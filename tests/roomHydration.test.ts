import { describe, expect, it } from 'vitest'
import { cardToString } from '../src/engine/cards'
import { hydrateRoomState, seedActionCounterFromLog } from '../src/sync/roomHydration'
import { WAITING_OPPONENT_ID } from '../src/sync/constants'
import { ActionRecord, ParticipantPresence } from '../src/sync/roomStore'

const participants: ParticipantPresence[] = [
  { playerId: 'p1', name: 'Host', role: 'host', joinedAt: 1, lastSeenAt: 1 },
  { playerId: 'p2', name: 'Guest', role: 'guest', joinedAt: 2, lastSeenAt: 2 }
]

describe('roomHydration', () => {
  it('builds a placeholder opponent when only local participant exists', () => {
    const hydrated = hydrateRoomState({
      localPlayerId: 'p1',
      localPlayerName: 'Host',
      participants: [{ playerId: 'p1', name: 'Host', role: 'host', joinedAt: 1, lastSeenAt: 1 }],
      actionRecords: []
    })

    expect(hydrated.state).not.toBeNull()
    expect(hydrated.state?.players).toHaveLength(2)
    expect(hydrated.state?.players.some((player) => player.id === WAITING_OPPONENT_ID)).toBe(true)
    expect(hydrated.connectedPeerIds).toEqual([])
  })

  it('keeps guest card assignment stable when local presence is temporarily missing', () => {
    const startRoundRecords: ActionRecord[] = [
      {
        id: 'p1-1',
        gameId: 'g1',
        actorId: 'p1',
        createdAt: 10,
        action: { id: 'p1-1', type: 'setCombinedSeed', seed: '00'.repeat(32) }
      },
      {
        id: 'p1-2',
        gameId: 'g1',
        actorId: 'p1',
        createdAt: 11,
        action: { id: 'p1-2', type: 'startRound' }
      }
    ]

    const withBothParticipants = hydrateRoomState({
      localPlayerId: 'p2',
      localPlayerName: 'Guest',
      localRole: 'guest',
      participants,
      actionRecords: startRoundRecords
    })

    const hostOnlySnapshot = hydrateRoomState({
      localPlayerId: 'p2',
      localPlayerName: 'Guest',
      localRole: 'guest',
      participants: [participants[0] as ParticipantPresence],
      actionRecords: startRoundRecords
    })

    const expectedPending = (withBothParticipants.state?.pending.p2 ?? []).map(cardToString)
    const hostOnlyPending = (hostOnlySnapshot.state?.pending.p2 ?? []).map(cardToString)

    expect(hostOnlyPending).toEqual(expectedPending)
  })

  it('replays actions ordered by createdAt then id', () => {
    const records: ActionRecord[] = [
      {
        id: 'p2-1',
        gameId: 'g1',
        actorId: 'p2',
        createdAt: 20,
        action: { id: 'p2-1', type: 'ready', playerId: 'p2' }
      },
      {
        id: 'p1-1',
        gameId: 'g1',
        actorId: 'p1',
        createdAt: 10,
        action: { id: 'p1-1', type: 'ready', playerId: 'p1' }
      }
    ]

    const hydrated = hydrateRoomState({
      localPlayerId: 'p1',
      localPlayerName: 'Host',
      participants,
      actionRecords: records
    })

    expect(hydrated.state?.actionLog.map((action) => action.id)).toEqual(['p1-1', 'p2-1'])
    expect(hydrated.state?.phase).toBe('commit')
  })

  it('dedupes duplicate action ids', () => {
    const records: ActionRecord[] = [
      {
        id: 'p1-1',
        gameId: 'g1',
        actorId: 'p1',
        createdAt: 10,
        action: { id: 'p1-1', type: 'ready', playerId: 'p1' }
      },
      {
        id: 'p1-1',
        gameId: 'g1',
        actorId: 'p1',
        createdAt: 11,
        action: { id: 'p1-1', type: 'ready', playerId: 'p1' }
      }
    ]

    const hydrated = hydrateRoomState({
      localPlayerId: 'p1',
      localPlayerName: 'Host',
      participants,
      actionRecords: records
    })

    expect(hydrated.actionLog).toHaveLength(1)
    expect(hydrated.actionLog[0]?.id).toBe('p1-1')
  })

  it('drops invalid actions and continues replay', () => {
    const records: ActionRecord[] = [
      {
        id: 'p1-1',
        gameId: 'g1',
        actorId: 'p1',
        createdAt: 10,
        action: { id: 'p1-1', type: 'ready', playerId: 'p1' }
      },
      {
        id: 'bad-1',
        gameId: 'g1',
        actorId: 'p2',
        createdAt: 11,
        action: { id: 'bad-1', type: 'drawCard', playerId: 'p2' }
      },
      {
        id: 'p2-1',
        gameId: 'g1',
        actorId: 'p2',
        createdAt: 12,
        action: { id: 'p2-1', type: 'ready', playerId: 'p2' }
      }
    ]

    const hydrated = hydrateRoomState({
      localPlayerId: 'p1',
      localPlayerName: 'Host',
      participants,
      actionRecords: records
    })

    expect(hydrated.droppedActionIds).toEqual(['bad-1'])
    expect(hydrated.state?.actionLog.map((action) => action.id)).toEqual(['p1-1', 'p2-1'])
    expect(hydrated.state?.phase).toBe('commit')
  })

  it('retries out-of-order dependent actions before dropping', () => {
    const records: ActionRecord[] = [
      {
        id: 'p1-2',
        gameId: 'g1',
        actorId: 'p1',
        createdAt: 10,
        action: { id: 'p1-2', type: 'startRound' }
      },
      {
        id: 'p1-1',
        gameId: 'g1',
        actorId: 'p1',
        createdAt: 10,
        action: { id: 'p1-1', type: 'setCombinedSeed', seed: '00'.repeat(32) }
      }
    ]

    const hydrated = hydrateRoomState({
      localPlayerId: 'p1',
      localPlayerName: 'Host',
      participants,
      actionRecords: records
    })

    expect(hydrated.droppedActionIds).toEqual([])
    expect(hydrated.state?.actionLog.map((action) => action.id)).toEqual(['p1-1', 'p1-2'])
    expect(hydrated.state?.phase).toBe('initial')
  })

  it('uses initialDealerSeat when provided', () => {
    const records: ActionRecord[] = [
      {
        id: 'p1-1',
        gameId: 'g1',
        actorId: 'p1',
        createdAt: 10,
        action: { id: 'p1-1', type: 'ready', playerId: 'p1' }
      }
    ]

    const hydrated = hydrateRoomState({
      localPlayerId: 'p1',
      localPlayerName: 'Host',
      participants,
      actionRecords: records,
      initialDealerSeat: 1
    })

    expect(hydrated.state?.dealerSeat).toBe(1)
    expect(hydrated.state?.turnSeat).toBe(0)
  })

  it('defaults to dealerSeat 0 when initialDealerSeat is omitted', () => {
    const hydrated = hydrateRoomState({
      localPlayerId: 'p1',
      localPlayerName: 'Host',
      participants,
      actionRecords: []
    })

    expect(hydrated.state?.dealerSeat).toBe(0)
    expect(hydrated.state?.turnSeat).toBe(0)
  })

  it('seeds local action counter from log', () => {
    const next = seedActionCounterFromLog(
      [{ id: 'p1-2' }, { id: 'p2-1' }, { id: 'p1-9' }, { id: 'p1-3' }],
      'p1',
      4
    )
    expect(next).toBe(9)
  })
})
