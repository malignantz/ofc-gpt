import { describe, expect, it } from 'vitest'
import { Player, initialGameState } from '../src/state/gameState'
import { resolveIncomingState, shouldIgnoreRegressiveSnapshot } from '../src/ui/utils/snapshotConsistency'

const players: Player[] = [
  { id: 'p1', name: 'Host', seat: 0, connected: true, ready: false },
  { id: 'p2', name: 'Guest', seat: 1, connected: true, ready: false }
]

function withActions(count: number, dealerSeat: 0 | 1) {
  const state = initialGameState(players)
  state.dealerSeat = dealerSeat
  state.actionLog = Array.from({ length: count }, (_, index) => ({
    id: `a-${index + 1}`,
    type: 'ready',
    playerId: 'p1'
  }))
  return state
}

describe('snapshotConsistency', () => {
  it('ignores regressive snapshots for the same game session', () => {
    const ignore = shouldIgnoreRegressiveSnapshot({
      previousGameId: 'g-1',
      incomingGameId: 'g-1',
      currentActionCount: 18,
      incomingActionCount: 15
    })
    expect(ignore).toBe(true)
  })

  it('does not ignore snapshots for a newer game session', () => {
    const ignore = shouldIgnoreRegressiveSnapshot({
      previousGameId: 'g-1',
      incomingGameId: 'g-2',
      currentActionCount: 18,
      incomingActionCount: 0
    })
    expect(ignore).toBe(false)
  })

  it('prefers persisted state when action counts are equal', () => {
    const persisted = withActions(12, 1)
    const hydrated = withActions(12, 0)

    const resolved = resolveIncomingState({
      hydratedState: hydrated,
      persistedState: persisted,
      droppedActionCount: 0
    })

    expect(resolved?.dealerSeat).toBe(1)
  })

  it('prefers hydrated state when persisted state is behind', () => {
    const persisted = withActions(10, 1)
    const hydrated = withActions(12, 0)

    const resolved = resolveIncomingState({
      hydratedState: hydrated,
      persistedState: persisted,
      droppedActionCount: 0
    })

    expect(resolved?.actionLog).toHaveLength(12)
    expect(resolved?.dealerSeat).toBe(0)
  })
})
