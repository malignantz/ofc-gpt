import { buildDeck, shuffle } from '../engine/deck'
import { hexToBytes } from '../crypto/hash'
import { seededRngFromBytes } from '../crypto/seededRng'
import { GameAction, GameState, LinesState, Seat, emptyLines } from './gameState'

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function allPlayersReady(state: GameState) {
  return state.players.every((player) => player.ready)
}

function allPlayersCommitted(state: GameState) {
  return state.players.every((player) => Boolean(state.commits[player.id]))
}

function allPlayersRevealed(state: GameState) {
  return state.players.every((player) => Boolean(state.reveals[player.id]))
}

function nextSeat(state: GameState, seat: number): Seat {
  const count = state.players.length
  return ((seat + 1) % count) as Seat
}

function getDealerSeat(state: GameState): Seat {
  const count = state.players.length
  const maybeDealerSeat = (state as { dealerSeat?: number }).dealerSeat
  if (typeof maybeDealerSeat !== 'number' || count <= 0) return 0
  const normalized = ((maybeDealerSeat % count) + count) % count
  return normalized as Seat
}

function resetLines(state: GameState) {
  const lines: Record<string, LinesState> = {}
  const pending: Record<string, LinesState['top']> = {}
  state.players.forEach((player) => {
    lines[player.id] = emptyLines()
    pending[player.id] = []
  })
  return { lines, pending }
}

export function applyAction(state: GameState, action: GameAction): GameState {
  const next = { ...state, actionLog: [...state.actionLog, action] }

  switch (action.type) {
    case 'ready': {
      const players = next.players.map((player) =>
        player.id === action.playerId ? { ...player, ready: true } : player
      )
      if (next.phase !== 'lobby') {
        return { ...next, players }
      }
      const phase = allPlayersReady({ ...next, players }) ? 'commit' : next.phase
      return { ...next, players, phase }
    }
    case 'setName': {
      const players = next.players.map((player) =>
        player.id === action.playerId ? { ...player, name: action.name } : player
      )
      return { ...next, players }
    }
    case 'commitSeed': {
      ensure(next.phase === 'commit', 'Cannot commit outside commit phase')
      const commits = { ...next.commits, [action.playerId]: action.commit }
      const phase = allPlayersCommitted({ ...next, commits }) ? 'reveal' : next.phase
      return { ...next, commits, phase }
    }
    case 'revealSeed': {
      ensure(next.phase === 'reveal', 'Cannot reveal outside reveal phase')
      const reveals = { ...next.reveals, [action.playerId]: action.seed }
      return { ...next, reveals }
    }
    case 'setCombinedSeed': {
      const hasReveals = Object.keys(next.reveals).length > 0
      if (hasReveals) {
        ensure(allPlayersRevealed(next), 'Cannot set combined seed until all reveals exist')
      }
      return { ...next, combinedSeed: action.seed }
    }
    case 'startRound': {
      const combinedSeed = next.combinedSeed
      ensure(combinedSeed, 'Combined seed required to start round')
      const dealerSeat = getDealerSeat(next)
      const openingSeat = nextSeat(next, dealerSeat)
      const { lines, pending } = resetLines(next)
      const rng = seededRngFromBytes(hexToBytes(combinedSeed))
      const deck = shuffle(buildDeck(), rng)
      const cardsPerPlayer = 13
      const initialPerPlayer = 5
      const drawsPerPlayer = cardsPerPlayer - initialPerPlayer
      const requiredCards = next.players.length * cardsPerPlayer
      ensure(deck.length >= requiredCards, 'Insufficient cards for round')
      const hands: Record<string, LinesState['top']> = { ...pending }
      let index = 0
      for (let round = 0; round < initialPerPlayer; round += 1) {
        for (const player of next.players) {
          const playerHand = hands[player.id]
          const card = deck[index]
          ensure(playerHand, `Missing hand for player ${player.id}`)
          ensure(card, `Missing deck card at index ${index}`)
          hands[player.id] = [...playerHand, card]
          index += 1
        }
      }
      const drawCount = next.players.length * drawsPerPlayer
      const drawOrder = deck.slice(index, index + drawCount)
      ensure(drawOrder.length === drawCount, 'Missing draw cards for round')
      return {
        ...next,
        phase: 'initial',
        lines,
        pending: hands,
        deck,
        drawOrder,
        drawIndex: 0,
        dealerSeat,
        turnSeat: openingSeat,
        turnStage: 'draw',
        commits: {},
        reveals: {}
      }
    }
    case 'resetRound': {
      const { lines, pending } = resetLines(next)
      const rotatedDealerSeat = nextSeat(next, getDealerSeat(next))
      const players = next.players.map((player) => ({ ...player, ready: false }))
      return {
        ...next,
        players,
        phase: 'lobby',
        lines,
        pending,
        commits: {},
        reveals: {},
        combinedSeed: undefined,
        deck: [],
        drawOrder: [],
        drawIndex: 0,
        dealerSeat: rotatedDealerSeat,
        turnSeat: nextSeat(next, rotatedDealerSeat),
        turnStage: 'draw'
      }
    }
    case 'placeCard': {
      const phase = next.phase
      const isInitial = phase === 'initial'
      const isPlay = phase === 'play'
      ensure(isInitial || isPlay, 'Cannot place card outside of a round')

      if (isPlay) {
        const currentPlayer = next.players.find((player) => player.seat === next.turnSeat)
        ensure(currentPlayer?.id === action.playerId, 'Not this player turn')
        ensure(next.turnStage === 'place', 'Must draw before placing')
      }

      const pending = next.pending[action.playerId] ?? []
      const cardIndex = pending.findIndex(
        (card) => card.rank === action.card.rank && card.suit === action.card.suit
      )
      ensure(cardIndex >= 0, 'Card not in pending hand')

      const current = next.lines[action.playerId] ?? emptyLines()
      const updatedLine = [...current[action.target], action.card]
      const lineLimits: Record<keyof LinesState, number> = { top: 3, middle: 5, bottom: 5 }
      ensure(updatedLine.length <= lineLimits[action.target], 'Line is full')

      const updatedLines = { ...current, [action.target]: updatedLine }
      const updatedPending = [...pending]
      updatedPending.splice(cardIndex, 1)

      let updatedState: GameState = {
        ...next,
        lines: { ...next.lines, [action.playerId]: updatedLines },
        pending: { ...next.pending, [action.playerId]: updatedPending }
      }

      if (isInitial) {
        const allPlaced = next.players.every((player) => updatedState.pending[player.id]?.length === 0)
        if (allPlaced) {
          updatedState = {
            ...updatedState,
            phase: 'play',
            turnStage: 'draw',
            turnSeat: nextSeat(updatedState, getDealerSeat(updatedState))
          }
        }
        return updatedState
      }

      const nextTurnSeat = nextSeat(next, next.turnSeat)
      const roundDone =
        updatedState.drawIndex >= updatedState.drawOrder.length &&
        updatedState.players.every((player) => updatedState.pending[player.id]?.length === 0) &&
        updatedState.players.every((player) => {
          const lines = updatedState.lines[player.id]
          if (!lines) return false
          return lines.top.length === 3 && lines.middle.length === 5 && lines.bottom.length === 5
        })

      return {
        ...updatedState,
        turnSeat: nextTurnSeat,
        turnStage: 'draw',
        phase: roundDone ? 'score' : updatedState.phase
      }
    }
    case 'drawCard': {
      ensure(next.phase === 'play', 'Can only draw during play phase')
      ensure(next.turnStage === 'draw', 'Not time to draw')
      const currentPlayer = next.players.find((player) => player.seat === next.turnSeat)
      ensure(currentPlayer?.id === action.playerId, 'Not this player turn')
      ensure(next.drawIndex < next.drawOrder.length, 'No more cards to draw')

      const card = next.drawOrder[next.drawIndex]
      ensure(card, `Missing draw card at index ${next.drawIndex}`)
      const pending = [...(next.pending[action.playerId] ?? []), card]

      return {
        ...next,
        pending: { ...next.pending, [action.playerId]: pending },
        drawIndex: next.drawIndex + 1,
        turnStage: 'place'
      }
    }
    case 'syncRequest':
    case 'syncResponse':
      return next
    default:
      return next
  }
}

export function applyActions(state: GameState, actions: GameAction[]): GameState {
  return actions.reduce((current, action) => applyAction(current, action), state)
}
