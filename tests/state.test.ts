import { describe, expect, it } from 'vitest'
import { GameState, Player, initialGameState } from '../src/state/gameState'
import { applyAction } from '../src/state/reducer'

const players: Player[] = [
  { id: 'p1', name: 'A', seat: 0, connected: true, ready: false },
  { id: 'p2', name: 'B', seat: 1, connected: true, ready: false }
]

const playersThreeHanded: Player[] = [
  { id: 'p1', name: 'A', seat: 0, connected: true, ready: false },
  { id: 'p2', name: 'B', seat: 1, connected: true, ready: false },
  { id: 'p3', name: 'C', seat: 2, connected: true, ready: false }
]

const combinedSeed = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
let counter = 0
const id = () => `t-${++counter}`

function nextPendingCard(state: GameState, playerId: string) {
  const pending = state.pending[playerId]
  if (!pending || pending.length === 0) {
    throw new Error(`Expected pending card for player ${playerId}`)
  }
  const card = pending[0]
  if (!card) throw new Error(`Expected first pending card for player ${playerId}`)
  return card
}

function currentTurnPlayer(state: GameState) {
  const player = state.players.find((candidate) => candidate.seat === state.turnSeat)
  if (!player) throw new Error(`Expected player at seat ${state.turnSeat}`)
  return player
}

function setupRound(roundPlayers: Player[]) {
  let state = initialGameState(roundPlayers)
  for (const player of roundPlayers) {
    state = applyAction(state, { id: id(), type: 'ready', playerId: player.id })
  }
  for (const player of roundPlayers) {
    state = applyAction(state, { id: id(), type: 'commitSeed', playerId: player.id, commit: `${player.id}-c` })
  }
  for (const player of roundPlayers) {
    state = applyAction(state, { id: id(), type: 'revealSeed', playerId: player.id, seed: `${player.id}-s` })
  }
  state = applyAction(state, { id: id(), type: 'setCombinedSeed', seed: combinedSeed })
  state = applyAction(state, { id: id(), type: 'startRound' })
  return state
}

function completeInitialPlacements(state: GameState) {
  let next = state
  for (let i = 0; i < 5; i += 1) {
    const orderedPlayers = [...next.players].sort((a, b) => a.seat - b.seat)
    for (const player of orderedPlayers) {
      next = applyAction(next, {
        id: id(),
        type: 'placeCard',
        playerId: player.id,
        card: nextPendingCard(next, player.id),
        target: 'bottom'
      })
    }
  }
  return next
}

function playToScore(state: GameState) {
  let next = state
  let safety = 0
  while (next.phase === 'play') {
    safety += 1
    if (safety > 200) throw new Error('Exceeded play loop safety limit')
    const player = currentTurnPlayer(next)
    next = applyAction(next, { id: id(), type: 'drawCard', playerId: player.id })
    const lines = next.lines[player.id]
    if (!lines) throw new Error(`Missing lines for player ${player.id}`)
    const target = lines.top.length < 3 ? 'top' : 'middle'
    next = applyAction(next, {
      id: id(),
      type: 'placeCard',
      playerId: player.id,
      card: nextPendingCard(next, player.id),
      target
    })
  }
  return next
}

describe('game loop', () => {
  it('updates player name via setName', () => {
    let state = initialGameState(players)
    state = applyAction(state, { id: id(), type: 'setName', playerId: 'p1', name: 'Alice' })
    expect(state.players.find((player) => player.id === 'p1')?.name).toBe('Alice')
  })

  it('progresses from lobby to play with first action left of dealer', () => {
    let state = setupRound(players)

    expect(state.phase).toBe('initial')
    expect(state.pending.p1).toHaveLength(5)
    expect(state.pending.p2).toHaveLength(5)
    expect(state.dealerSeat).toBe(0)

    state = completeInitialPlacements(state)

    expect(state.phase).toBe('play')
    expect(state.turnStage).toBe('draw')
    expect(state.turnSeat).toBe(1)
  })

  it('draws and places a card during play', () => {
    let state = completeInitialPlacements(setupRound(players))
    const actor = currentTurnPlayer(state)

    state = applyAction(state, { id: id(), type: 'drawCard', playerId: actor.id })
    const drawn = nextPendingCard(state, actor.id)
    expect(state.turnStage).toBe('place')

    state = applyAction(state, { id: id(), type: 'placeCard', playerId: actor.id, card: drawn, target: 'top' })
    expect(state.turnStage).toBe('draw')
    expect(state.turnSeat).toBe(0)
  })

  it('rejects draw out of turn', () => {
    const state = completeInitialPlacements(setupRound(players))
    const actor = currentTurnPlayer(state)
    const outOfTurn = state.players.find((player) => player.id !== actor.id)
    if (!outOfTurn) throw new Error('Expected out-of-turn player')

    expect(() => applyAction(state, { id: id(), type: 'drawCard', playerId: outOfTurn.id })).toThrow()
  })

  it('transitions to score after the last placement and does not allow extra draws', () => {
    let state = completeInitialPlacements(setupRound(players))
    state = playToScore(state)

    expect(state.phase).toBe('score')
    expect(state.lines.p1?.top).toHaveLength(3)
    expect(state.lines.p1?.middle).toHaveLength(5)
    expect(state.lines.p1?.bottom).toHaveLength(5)
    expect(state.lines.p2?.top).toHaveLength(3)
    expect(state.lines.p2?.middle).toHaveLength(5)
    expect(state.lines.p2?.bottom).toHaveLength(5)
    expect(() => applyAction(state, { id: id(), type: 'drawCard', playerId: 'p1' })).toThrow()
  })

  it('advances turn clockwise from the seat left of dealer', () => {
    let state = completeInitialPlacements(setupRound(playersThreeHanded))
    expect(state.dealerSeat).toBe(0)
    expect(state.turnSeat).toBe(1)

    const firstActor = currentTurnPlayer(state)
    expect(firstActor.id).toBe('p2')
    state = applyAction(state, { id: id(), type: 'drawCard', playerId: firstActor.id })
    state = applyAction(state, {
      id: id(),
      type: 'placeCard',
      playerId: firstActor.id,
      card: nextPendingCard(state, firstActor.id),
      target: 'top'
    })
    expect(state.turnSeat).toBe(2)

    const secondActor = currentTurnPlayer(state)
    expect(secondActor.id).toBe('p3')
    state = applyAction(state, { id: id(), type: 'drawCard', playerId: secondActor.id })
    state = applyAction(state, {
      id: id(),
      type: 'placeCard',
      playerId: secondActor.id,
      card: nextPendingCard(state, secondActor.id),
      target: 'top'
    })
    expect(state.turnSeat).toBe(0)
  })

  it('rotates dealer button on reset for the next round', () => {
    let state = playToScore(completeInitialPlacements(setupRound(players)))
    expect(state.phase).toBe('score')
    expect(state.dealerSeat).toBe(0)

    state = applyAction(state, { id: id(), type: 'resetRound' })
    expect(state.phase).toBe('lobby')
    expect(state.dealerSeat).toBe(1)

    for (const player of state.players) {
      state = applyAction(state, { id: id(), type: 'ready', playerId: player.id })
    }
    for (const player of state.players) {
      state = applyAction(state, { id: id(), type: 'commitSeed', playerId: player.id, commit: `${player.id}-c2` })
    }
    for (const player of state.players) {
      state = applyAction(state, { id: id(), type: 'revealSeed', playerId: player.id, seed: `${player.id}-s2` })
    }
    state = applyAction(state, { id: id(), type: 'setCombinedSeed', seed: combinedSeed })
    state = applyAction(state, { id: id(), type: 'startRound' })
    state = completeInitialPlacements(state)

    expect(state.dealerSeat).toBe(1)
    expect(state.turnSeat).toBe(0)
  })
})
