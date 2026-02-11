import { describe, expect, it } from 'vitest'
import { buildDeck } from '../src/engine/deck'
import { stringToCard } from '../src/engine/cards'
import { GameState, Player, initialGameState } from '../src/state/gameState'
import { applyAction } from '../src/state/reducer'
import { planCpuActions } from '../src/strategy/cpuPlanner'

const players: Player[] = [
  { id: 'human', name: 'Human', seat: 0, connected: true, ready: false },
  { id: '__cpu_bot__', name: 'CPU', seat: 1, connected: true, ready: false }
]

function withPlayState(partial: Partial<GameState>): GameState {
  const state = initialGameState(players)
  return {
    ...state,
    phase: 'play',
    turnSeat: 1,
    turnStage: 'draw',
    drawIndex: 0,
    ...partial
  }
}

describe('cpu planner', () => {
  it('emits ready actions for unready lobby players', () => {
    const state = initialGameState(players)
    const plan = planCpuActions({
      state,
      cpuPlayerId: '__cpu_bot__',
      knownDeck: buildDeck(),
      delayMs: 650
    })

    expect(plan?.actions.map((action) => action.type)).toEqual(['ready', 'ready'])
    expect(plan?.actions.map((action) => (action.type === 'ready' ? action.playerId : ''))).toEqual([
      'human',
      '__cpu_bot__'
    ])
  })

  it('emits setCombinedSeed + startRound actions in commit with random seeds', () => {
    let state = initialGameState(players)
    state = applyAction(state, { id: 'r1', type: 'ready', playerId: 'human' })
    state = applyAction(state, { id: 'r2', type: 'ready', playerId: '__cpu_bot__' })

    const first = planCpuActions({
      state,
      cpuPlayerId: '__cpu_bot__',
      knownDeck: buildDeck(),
      delayMs: 650
    })
    const second = planCpuActions({
      state,
      cpuPlayerId: '__cpu_bot__',
      knownDeck: buildDeck(),
      delayMs: 650
    })

    expect(first).not.toBeNull()
    expect(first?.actions.map((action) => action.type)).toEqual(['setCombinedSeed', 'startRound'])
    expect(first?.actions.map((action) => action.id)).toEqual(['cpu:seed:r1', 'cpu:start:r1'])
    // Seeds should differ between calls due to random entropy injection
    expect(second).not.toBeNull()
    expect(second?.actions.map((action) => action.type)).toEqual(['setCombinedSeed', 'startRound'])
    const firstSeed = first?.actions[0]?.type === 'setCombinedSeed' ? first.actions[0].seed : ''
    const secondSeed = second?.actions[0]?.type === 'setCombinedSeed' ? second.actions[0].seed : ''
    expect(firstSeed).toHaveLength(64)
    expect(secondSeed).toHaveLength(64)
    expect(firstSeed).not.toBe(secondSeed)
  })

  it('increments round identifiers after a reset so scoring round keys remain unique', () => {
    let state = initialGameState(players)
    state = applyAction(state, { id: 'r1', type: 'ready', playerId: 'human' })
    state = applyAction(state, { id: 'r2', type: 'ready', playerId: '__cpu_bot__' })
    state = applyAction(state, { id: 'cpu:seed:r1', type: 'setCombinedSeed', seed: 'a'.repeat(64) })
    state = applyAction(state, { id: 'cpu:start:r1', type: 'startRound' })
    state = applyAction(state, { id: 'reset-1', type: 'resetRound' })
    state = applyAction(state, { id: 'r3', type: 'ready', playerId: 'human' })
    state = applyAction(state, { id: 'r4', type: 'ready', playerId: '__cpu_bot__' })

    const plan = planCpuActions({
      state,
      cpuPlayerId: '__cpu_bot__',
      knownDeck: buildDeck(),
      delayMs: 650
    })

    expect(plan?.actions.map((action) => action.id)).toEqual(['cpu:seed:r2', 'cpu:start:r2'])
  })

  it('emits a draw action only for CPU turn in play/draw stage', () => {
    const state = withPlayState({
      turnStage: 'draw',
      turnSeat: 1
    })

    const plan = planCpuActions({
      state,
      cpuPlayerId: '__cpu_bot__',
      knownDeck: buildDeck(),
      delayMs: 650
    })

    expect(plan?.actions).toHaveLength(1)
    expect(plan?.actions[0]?.type).toBe('drawCard')
    expect(plan?.actions[0]?.type === 'drawCard' ? plan.actions[0].playerId : null).toBe('__cpu_bot__')
  })

  it('emits exactly one legal placement action for CPU in play/place stage', () => {
    const state = withPlayState({
      turnStage: 'place',
      turnSeat: 1,
      pending: {
        human: [],
        __cpu_bot__: [stringToCard('AS')]
      },
      lines: {
        human: { top: [], middle: [], bottom: [] },
        __cpu_bot__: {
          top: [stringToCard('2S')],
          middle: [stringToCard('3D')],
          bottom: [stringToCard('4H')]
        }
      }
    })

    const plan = planCpuActions({
      state,
      cpuPlayerId: '__cpu_bot__',
      knownDeck: buildDeck(),
      delayMs: 650
    })

    expect(plan?.actions).toHaveLength(1)
    expect(plan?.actions[0]?.type).toBe('placeCard')
    expect(
      plan?.actions[0]?.type === 'placeCard'
        ? ['top', 'middle', 'bottom'].includes(plan.actions[0].target)
        : false
    ).toBe(true)
  })

  it('emits no actions in score phase', () => {
    const state = {
      ...initialGameState(players),
      phase: 'score'
    } satisfies GameState

    const plan = planCpuActions({
      state,
      cpuPlayerId: '__cpu_bot__',
      knownDeck: buildDeck(),
      delayMs: 650
    })

    expect(plan).toBeNull()
  })
})
