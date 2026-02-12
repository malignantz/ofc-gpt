import { describe, expect, it } from 'vitest'
import { initialGameState, type GameState, type Player } from '../src/state/gameState'
import { getCurrentRoundKey } from '../src/ui/components/GameTable'

const players: Player[] = [
  { id: 'p1', name: 'Host', seat: 0, connected: true, ready: false },
  { id: 'p2', name: 'CPU', seat: 1, connected: true, ready: false }
]

function scoreStateWithRound(startRoundId: string, combinedSeed: string): GameState {
  const state = initialGameState(players)
  state.phase = 'score'
  state.combinedSeed = combinedSeed
  state.actionLog = [{ id: startRoundId, type: 'startRound' }]
  return state
}

describe('getCurrentRoundKey', () => {
  it('includes combined seed so repeated round labels do not collide', () => {
    const first = scoreStateWithRound('cpu:start:r1', 'seed-a')
    const second = scoreStateWithRound('cpu:start:r1', 'seed-b')

    expect(getCurrentRoundKey(first)).toBe('v2:cpu:start:r1:seed-a')
    expect(getCurrentRoundKey(second)).toBe('v2:cpu:start:r1:seed-b')
    expect(getCurrentRoundKey(first)).not.toBe(getCurrentRoundKey(second))
  })

  it('falls back to combined seed when startRound is missing', () => {
    const state = initialGameState(players)
    state.phase = 'score'
    state.combinedSeed = 'seed-only'

    expect(getCurrentRoundKey(state)).toBe('v2:seed:seed-only')
  })
})
