import { describe, expect, it } from 'vitest'
import { Player, initialGameState } from '../src/state/gameState'
import { ParticipantPresence } from '../src/sync/roomStore'
import { ROUND_TAKEOVER_TIMEOUT_MS, getRoundRestartDecision } from '../src/ui/utils/roundControl'

const players: Player[] = [
  { id: 'p1', name: 'Host', seat: 0, connected: true, ready: false },
  { id: 'p2', name: 'Guest', seat: 1, connected: true, ready: false }
]

function scoreState(dealerSeat: Player['seat']) {
  const state = initialGameState(players)
  state.phase = 'score'
  state.dealerSeat = dealerSeat
  state.turnSeat = ((dealerSeat + 1) % players.length) as Player['seat']
  return state
}

function presence(lastSeenAt: number): Record<string, ParticipantPresence> {
  return {
    p1: { playerId: 'p1', name: 'Host', role: 'host', joinedAt: 1, lastSeenAt },
    p2: { playerId: 'p2', name: 'Guest', role: 'guest', joinedAt: 2, lastSeenAt }
  }
}

describe('roundControl', () => {
  it('allows dealer to start next round immediately', () => {
    const decision = getRoundRestartDecision({
      state: scoreState(0),
      localPlayerId: 'p1',
      connectivityByPlayerId: { p1: true, p2: true },
      participantPresenceById: presence(1_000),
      now: 1_000
    })

    expect(decision.isLocalDealer).toBe(true)
    expect(decision.canStartNextRound).toBe(true)
    expect(decision.nextRoundLabel).toBe('Next Round')
    expect(decision.nextRoundHint).toBeNull()
  })

  it('blocks non-dealer while dealer is online', () => {
    const decision = getRoundRestartDecision({
      state: scoreState(0),
      localPlayerId: 'p2',
      connectivityByPlayerId: { p1: true, p2: true },
      participantPresenceById: presence(1_000),
      now: 1_000
    })

    expect(decision.canStartNextRound).toBe(false)
    expect(decision.nextRoundHint).toContain('Waiting for Host')
  })

  it('shows takeover countdown while dealer has not timed out', () => {
    const decision = getRoundRestartDecision({
      state: scoreState(0),
      localPlayerId: 'p2',
      connectivityByPlayerId: { p1: false, p2: true },
      participantPresenceById: presence(10_000),
      now: 10_000 + ROUND_TAKEOVER_TIMEOUT_MS - 1_500
    })

    expect(decision.canStartNextRound).toBe(false)
    expect(decision.takeoverCountdownSeconds).toBe(2)
    expect(decision.nextRoundHint).toContain('Take over in')
  })

  it('allows non-dealer takeover after timeout', () => {
    const decision = getRoundRestartDecision({
      state: scoreState(0),
      localPlayerId: 'p2',
      connectivityByPlayerId: { p1: false, p2: true },
      participantPresenceById: presence(20_000),
      now: 20_000 + ROUND_TAKEOVER_TIMEOUT_MS + 5
    })

    expect(decision.canStartNextRound).toBe(true)
    expect(decision.nextRoundLabel).toBe('Take Over Next Round')
  })
})

