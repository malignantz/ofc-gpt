import { describe, expect, it } from 'vitest'
import { FirebaseRequestOptions, FirebaseRestClient } from '../src/sync/firebaseClient'
import { createRoomStore } from '../src/sync/roomStore'
import { hydrateRoomState } from '../src/sync/roomHydration'

class FakeFirebaseClient implements FirebaseRestClient {
  isConfigured = true
  baseUrl = 'https://fake.firebaseio.test'
  private db: Record<string, unknown> = {}

  async requestJson<T>(path: string, options?: FirebaseRequestOptions): Promise<T> {
    const method = options?.method ?? 'GET'
    const segments = path
      .replace(/\\.json$/, '')
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment))

    if (method === 'GET') return this.readPath(segments) as T
    if (method === 'PUT') {
      this.writePath(segments, options?.body)
      return options?.body as T
    }
    if (method === 'PATCH') {
      if (typeof options?.body === 'object' && options.body !== null) {
        const patchEntries = Object.entries(options.body as Record<string, unknown>)
        if (patchEntries.some(([key]) => key.includes('/'))) {
          patchEntries.forEach(([key, value]) => {
            this.writePath([...segments, ...key.split('/').filter(Boolean)], value)
          })
          return this.readPath(segments) as T
        }
      }
      const current = this.readPath(segments)
      const merged =
        typeof current === 'object' && current !== null && typeof options?.body === 'object' && options.body !== null
          ? { ...(current as Record<string, unknown>), ...(options.body as Record<string, unknown>) }
          : options?.body
      this.writePath(segments, merged)
      return merged as T
    }
    if (method === 'DELETE') {
      this.deletePath(segments)
      return null as T
    }
    throw new Error(`Unsupported method ${method}`)
  }

  private readPath(segments: string[]): unknown {
    let current: unknown = this.db
    for (const segment of segments) {
      if (typeof current !== 'object' || current === null) return null
      current = (current as Record<string, unknown>)[segment]
      if (current === undefined) return null
    }
    return current === undefined ? null : structuredClone(current)
  }

  private writePath(segments: string[], value: unknown) {
    if (segments.length === 0) {
      this.db = (value as Record<string, unknown>) ?? {}
      return
    }
    let current: Record<string, unknown> = this.db
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]
      if (!segment) continue
      const next = current[segment]
      if (typeof next !== 'object' || next === null) current[segment] = {}
      current = current[segment] as Record<string, unknown>
    }
    const leaf = segments[segments.length - 1]
    if (!leaf) return
    current[leaf] = value === undefined ? null : structuredClone(value)
  }

  private deletePath(segments: string[]) {
    if (segments.length === 0) {
      this.db = {}
      return
    }
    let current: Record<string, unknown> = this.db
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]
      if (!segment) continue
      const next = current[segment]
      if (typeof next !== 'object' || next === null) return
      current = next as Record<string, unknown>
    }
    const leaf = segments[segments.length - 1]
    if (!leaf) return
    delete current[leaf]
  }
}

describe('database sync integration', () => {
  it('host room appears in directory and both clients converge from action log', async () => {
    let time = 1000
    const store = createRoomStore({
      client: new FakeFirebaseClient(),
      now: () => {
        time += 10
        return time
      }
    })

    await store.createRoom({
      roomId: 'sync-room',
      displayName: 'sync-room',
      hostId: 'p1',
      hostName: 'Host',
      expectedPlayers: 2
    })

    const directory = await store.fetchRoomDirectory()
    expect(directory.map((entry) => entry.roomId)).toContain('sync-room')

    await store.joinRoom({
      roomId: 'sync-room',
      playerId: 'p2',
      playerName: 'Guest',
      role: 'guest'
    })

    await store.appendAction({
      roomId: 'sync-room',
      actorId: 'p1',
      action: { id: 'p1-1', type: 'ready', playerId: 'p1' }
    })
    await store.appendAction({
      roomId: 'sync-room',
      actorId: 'p2',
      action: { id: 'p2-1', type: 'ready', playerId: 'p2' }
    })

    const hostSnapshot = await store.fetchRoomSnapshot('sync-room')
    const guestSnapshot = await store.fetchRoomSnapshot('sync-room')
    const hostHydrated = hydrateRoomState({
      localPlayerId: 'p1',
      localPlayerName: 'Host',
      participants: hostSnapshot.participants,
      actionRecords: hostSnapshot.actions
    })
    const guestHydrated = hydrateRoomState({
      localPlayerId: 'p2',
      localPlayerName: 'Guest',
      participants: guestSnapshot.participants,
      actionRecords: guestSnapshot.actions
    })

    expect(hostHydrated.state?.actionLog.map((action) => action.id)).toEqual(['p1-1', 'p2-1'])
    expect(guestHydrated.state?.actionLog.map((action) => action.id)).toEqual(['p1-1', 'p2-1'])
    expect(hostHydrated.state?.phase).toBe('commit')
    expect(guestHydrated.state?.phase).toBe('commit')
  })

  it('dealer restart converges both clients and ignores stale restart attempts', async () => {
    let time = 2_000
    const store = createRoomStore({
      client: new FakeFirebaseClient(),
      now: () => {
        time += 10
        return time
      }
    })

    await store.createRoom({
      roomId: 'sync-round-restart',
      displayName: 'sync-round-restart',
      hostId: 'p1',
      hostName: 'Host',
      expectedPlayers: 2
    })
    await store.joinRoom({
      roomId: 'sync-round-restart',
      playerId: 'p2',
      playerName: 'Guest',
      role: 'guest'
    })

    const beforeRestart = await store.fetchRoomSnapshot('sync-round-restart')
    if (!beforeRestart.meta || !beforeRestart.gameState) throw new Error('Expected room snapshot with meta and gameState')

    await store.upsertGameState('sync-round-restart', {
      ...beforeRestart.gameState,
      phase: 'score'
    }, beforeRestart.meta.currentGameId)
    const scoredSnapshot = await store.fetchRoomSnapshot('sync-round-restart')
    const gameIdBeforeRestart = scoredSnapshot.meta?.currentGameId
    if (!gameIdBeforeRestart) throw new Error('Expected current game id before restart')

    const restartSnapshot = await store.resetRoundSession({
      roomId: 'sync-round-restart',
      expectedGameId: gameIdBeforeRestart
    })
    const restartedGameId = restartSnapshot.meta?.currentGameId
    if (!restartedGameId) throw new Error('Expected current game id after restart')
    expect(restartedGameId).not.toBe(gameIdBeforeRestart)
    expect(restartSnapshot.meta?.dealerSeat).toBe(1)
    expect(restartSnapshot.gameState?.phase).toBe('lobby')
    expect(restartSnapshot.gameState?.dealerSeat).toBe(1)
    expect(restartSnapshot.gameState?.turnSeat).toBe(0)

    const staleRestart = await store.resetRoundSession({
      roomId: 'sync-round-restart',
      expectedGameId: gameIdBeforeRestart
    })
    expect(staleRestart.meta?.currentGameId).toBe(restartedGameId)

    await store.appendAction({
      roomId: 'sync-round-restart',
      actorId: 'p1',
      action: { id: `auto:ready:${restartedGameId}:p1`, type: 'ready', playerId: 'p1' },
      expectedGameId: restartedGameId
    })
    await store.appendAction({
      roomId: 'sync-round-restart',
      actorId: 'p2',
      action: { id: `auto:ready:${restartedGameId}:p2`, type: 'ready', playerId: 'p2' },
      expectedGameId: restartedGameId
    })
    await store.appendAction({
      roomId: 'sync-round-restart',
      actorId: 'p2',
      action: { id: `auto:setCombinedSeed:${restartedGameId}`, type: 'setCombinedSeed', seed: '00'.repeat(32) },
      expectedGameId: restartedGameId
    })
    await store.appendAction({
      roomId: 'sync-round-restart',
      actorId: 'p2',
      action: { id: `auto:startRound:${restartedGameId}`, type: 'startRound' },
      expectedGameId: restartedGameId
    })

    const hostSnapshot = await store.fetchRoomSnapshot('sync-round-restart')
    const guestSnapshot = await store.fetchRoomSnapshot('sync-round-restart')
    const hostHydrated = hydrateRoomState({
      localPlayerId: 'p1',
      localPlayerName: 'Host',
      participants: hostSnapshot.participants,
      actionRecords: hostSnapshot.actions
    })
    const guestHydrated = hydrateRoomState({
      localPlayerId: 'p2',
      localPlayerName: 'Guest',
      participants: guestSnapshot.participants,
      actionRecords: guestSnapshot.actions
    })

    expect(hostHydrated.state?.phase).toBe('initial')
    expect(guestHydrated.state?.phase).toBe('initial')
    expect(hostHydrated.state?.actionLog.map((action) => action.id)).toEqual([
      `auto:ready:${restartedGameId}:p1`,
      `auto:ready:${restartedGameId}:p2`,
      `auto:setCombinedSeed:${restartedGameId}`,
      `auto:startRound:${restartedGameId}`
    ])
    expect(guestHydrated.state?.actionLog.map((action) => action.id)).toEqual([
      `auto:ready:${restartedGameId}:p1`,
      `auto:ready:${restartedGameId}:p2`,
      `auto:setCombinedSeed:${restartedGameId}`,
      `auto:startRound:${restartedGameId}`
    ])
  })
})
