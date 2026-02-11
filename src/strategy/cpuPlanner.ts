import { Card, cardToString } from '../engine/cards'
import { emptyLines } from '../state/gameState'
import type { GameAction, GameState, LinesState, Player } from '../state/gameState'
import { hashString32 } from './deterministicRng'
import { chooseInitialPlacement, choosePlayPlacement } from './placementEngine'
import type { CpuPlannerInput, PlannerOutput } from './types'

function toPlacementCardKey(card: Card): string {
  return cardToString(card)
}

function playerBySeat(state: GameState, seat: number): Player | undefined {
  return state.players.find((player) => player.seat === seat)
}

function countActions(state: GameState, type: GameAction['type']): number {
  return state.actionLog.filter((action) => action.type === type).length
}

function completedRoundCount(state: GameState): number {
  return countActions(state, 'startRound')
}

function activeRoundNumber(state: GameState): number {
  const completed = completedRoundCount(state)
  if (state.phase === 'commit' || state.phase === 'lobby' || state.phase === 'reveal') {
    return completed + 1
  }
  return Math.max(1, completed)
}

function readyCycleNumber(state: GameState): number {
  return countActions(state, 'resetRound')
}

function hasActionId(state: GameState, id: string): boolean {
  return state.actionLog.some((action) => action.id === id)
}

function linesSignature(lines: LinesState): string {
  return `${lines.top.map(cardToString).join(',')}|${lines.middle.map(cardToString).join(',')}|${lines.bottom.map(cardToString).join(',')}`
}

function stateSignature(state: GameState): string {
  const players = state.players
    .map((player) => `${player.id}:${player.ready ? 1 : 0}:${player.seat}`)
    .sort()
    .join('|')
  const lines = state.players
    .map((player) => `${player.id}:${linesSignature(state.lines[player.id] ?? emptyLines())}`)
    .sort()
    .join('|')
  const pending = state.players
    .map((player) => `${player.id}:${(state.pending[player.id] ?? []).map(cardToString).join(',')}`)
    .sort()
    .join('|')
  return `${state.phase}|${state.turnSeat}|${state.turnStage}|${state.drawIndex}|${state.dealerSeat}|${players}|${lines}|${pending}`
}

function deterministicSeedHex(signature: string): string {
  const chunks: string[] = []
  let carry = hashString32(signature)
  for (let i = 0; i < 8; i += 1) {
    carry = hashString32(`${signature}:${i}:${carry}`)
    chunks.push(carry.toString(16).padStart(8, '0'))
  }
  return chunks.join('')
}

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function actionKey(actions: GameAction[]): string {
  return actions.map((action) => action.id).join('|')
}

function getVisibleOpponentLines(state: GameState, cpuPlayerId: string): LinesState {
  const opponent = state.players.find((player) => player.id !== cpuPlayerId)
  if (!opponent) return emptyLines()
  return state.lines[opponent.id] ?? emptyLines()
}

export function planCpuActions(input: CpuPlannerInput): PlannerOutput | null {
  const state = input.state
  const cpuPlayer = state.players.find((player) => player.id === input.cpuPlayerId)
  if (!cpuPlayer) return null

  if (state.phase === 'lobby') {
    const readyCycle = readyCycleNumber(state)
    const actions: GameAction[] = []
    for (const player of state.players) {
      if (player.ready) continue
      const id = `cpu:ready:${readyCycle}:${player.id}`
      if (hasActionId(state, id)) continue
      actions.push({ id, type: 'ready', playerId: player.id })
    }
    if (actions.length === 0) return null
    return {
      actions,
      delayMs: input.delayMs,
      key: `cpu:lobby:${readyCycle}:${state.players.map((player) => `${player.id}:${player.ready ? 1 : 0}`).join('|')}`
    }
  }

  if (state.phase === 'commit') {
    if (state.combinedSeed) return null
    const dealer = playerBySeat(state, state.dealerSeat)
    if (!dealer) return null
    const roundNumber = activeRoundNumber(state)
    const roundMarker = `r${roundNumber}`
    const combinedSeed = deterministicSeedHex(`${roundMarker}:${stateSignature(state)}:${randomNonce()}`)
    const combinedId = `cpu:seed:${roundMarker}`
    const startId = `cpu:start:${roundMarker}`
    const actions: GameAction[] = []
    if (!hasActionId(state, combinedId)) {
      actions.push({ id: combinedId, type: 'setCombinedSeed', seed: combinedSeed })
    }
    if (!hasActionId(state, startId)) {
      actions.push({ id: startId, type: 'startRound' })
    }
    if (actions.length === 0) return null
    return {
      actions,
      delayMs: input.delayMs,
      key: `cpu:commit:${roundMarker}:${actionKey(actions)}`
    }
  }

  if (state.phase === 'initial') {
    const roundNumber = activeRoundNumber(state)
    const roundMarker = `r${roundNumber}`
    const botPending = state.pending[input.cpuPlayerId] ?? []
    if (botPending.length === 0) return null
    const botLines = state.lines[input.cpuPlayerId] ?? emptyLines()
    const decision = chooseInitialPlacement({
      botLines,
      botPending,
      visibleOpponentLines: getVisibleOpponentLines(state, input.cpuPlayerId),
      knownDeck: input.knownDeck,
      drawIndex: state.drawIndex,
      signatureSeed: `${roundMarker}:initial`,
      profile: input.profile
    })

    const placementByCard = new Map<string, keyof LinesState>()
    for (const target of ['top', 'middle', 'bottom'] as const) {
      for (const card of decision[target]) {
        const key = toPlacementCardKey(card)
        if (!botPending.some((pendingCard) => toPlacementCardKey(pendingCard) === key)) continue
        placementByCard.set(key, target)
      }
    }

    const actions: GameAction[] = []
    for (const card of botPending) {
      const key = toPlacementCardKey(card)
      const target = placementByCard.get(key)
      if (!target) continue
      const id = `cpu:place:initial:${roundMarker}:${state.drawIndex}:${key}:${target}`
      if (hasActionId(state, id)) continue
      actions.push({ id, type: 'placeCard', playerId: input.cpuPlayerId, card, target })
    }

    if (actions.length === 0) return null
    return {
      actions,
      delayMs: input.delayMs,
      key: `cpu:initial:${roundMarker}:${state.drawIndex}:${actionKey(actions)}`
    }
  }

  if (state.phase === 'play') {
    const roundNumber = activeRoundNumber(state)
    const roundMarker = `r${roundNumber}`
    const actor = playerBySeat(state, state.turnSeat)
    if (!actor || actor.id !== input.cpuPlayerId) return null

    if (state.turnStage === 'draw') {
      const id = `cpu:draw:${roundMarker}:${state.drawIndex}:${state.turnSeat}`
      if (hasActionId(state, id)) return null
      return {
        actions: [{ id, type: 'drawCard', playerId: input.cpuPlayerId }],
        delayMs: input.delayMs,
        key: `cpu:play:draw:${roundMarker}:${state.drawIndex}:${state.turnSeat}`
      }
    }

    const botPending = state.pending[input.cpuPlayerId] ?? []
    const card = botPending[0]
    if (!card) return null
    const botLines = state.lines[input.cpuPlayerId] ?? emptyLines()
    const choice = choosePlayPlacement({
      botLines,
      botPending,
      visibleOpponentLines: getVisibleOpponentLines(state, input.cpuPlayerId),
      knownDeck: input.knownDeck,
      drawIndex: state.drawIndex,
      signatureSeed: `${roundMarker}:play`,
      profile: input.profile
    })
    const cardKey = toPlacementCardKey(card)
    const id = `cpu:place:play:${roundMarker}:${state.drawIndex}:${cardKey}:${choice.target}`
    if (hasActionId(state, id)) return null
    return {
      actions: [
        {
          id,
          type: 'placeCard',
          playerId: input.cpuPlayerId,
          card,
          target: choice.target
        }
      ],
      delayMs: input.delayMs,
      key: `cpu:play:place:${roundMarker}:${state.drawIndex}:${cardKey}:${choice.target}`
    }
  }

  return null
}
