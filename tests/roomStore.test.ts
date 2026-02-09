import { describe, expect, it } from 'vitest'
import { FirebaseRequestOptions, FirebaseRestClient } from '../src/sync/firebaseClient'
import {
  buildPresenceUpdate,
  createRoomStore,
  filterActiveRoomDirectory,
  RoomDirectoryEntry
} from '../src/sync/roomStore'
import { WAITING_OPPONENT_ID } from '../src/sync/constants'

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

    if (method === 'GET') {
      return this.readPath(segments) as T
    }
    if (method === 'PUT') {
      this.writePath(segments, options?.body)
      return options?.body as T
    }
    if (method === 'PATCH') {
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
    throw new Error(`Unsupported method: ${method}`)
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
      if (typeof next !== 'object' || next === null) {
        current[segment] = {}
      }
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

describe('roomStore helpers', () => {
  it('filters directory by expiry and sorts by updatedAt descending', () => {
    const entries: RoomDirectoryEntry[] = [
      {
        roomId: 'old',
        displayName: 'Old',
        hostName: 'Host',
        status: 'waiting',
        playerCount: 1,
        expectedPlayers: 2,
        updatedAt: 10,
        expiresAt: 20,
        discoverable: true
      },
      {
        roomId: 'fresh',
        displayName: 'Fresh',
        hostName: 'Host',
        status: 'active',
        playerCount: 2,
        expectedPlayers: 2,
        updatedAt: 100,
        expiresAt: 500,
        discoverable: true
      }
    ]

    const filtered = filterActiveRoomDirectory(entries, 30)
    expect(filtered.map((entry) => entry.roomId)).toEqual(['fresh'])
  })

  it('builds normalized presence payload', () => {
    const presence = buildPresenceUpdate({
      playerId: 'p1',
      playerName: '   ',
      role: 'guest',
      joinedAt: 1,
      lastSeenAt: 2
    })
    expect(presence).toEqual({
      playerId: 'p1',
      name: 'Player',
      role: 'guest',
      joinedAt: 1,
      lastSeenAt: 2
    })
  })
})

describe('roomStore action writes', () => {
  it('creates bootstrap game state when room is first created', async () => {
    const store = createRoomStore({
      client: new FakeFirebaseClient(),
      now: () => 100
    })

    const snapshot = await store.createRoom({
      roomId: 'table-bootstrap',
      displayName: 'table-bootstrap',
      hostId: 'p1',
      hostName: 'Host',
      expectedPlayers: 2
    })

    expect(snapshot.gameState).not.toBeNull()
    expect(snapshot.gameState?.players.map((player) => player.id)).toEqual(['p1', WAITING_OPPONENT_ID])
  })

  it('upserts explicit game state snapshots', async () => {
    const store = createRoomStore({
      client: new FakeFirebaseClient(),
      now: () => 100
    })

    await store.createRoom({
      roomId: 'table-state',
      displayName: 'table-state',
      hostId: 'p1',
      hostName: 'Host',
      expectedPlayers: 2
    })

    const snapshot = await store.fetchRoomSnapshot('table-state')
    if (!snapshot.gameState) throw new Error('Expected bootstrap state')
    const updated = { ...snapshot.gameState, phase: 'play' as const }
    await store.upsertGameState('table-state', updated)

    const reloaded = await store.fetchRoomSnapshot('table-state')
    expect(reloaded.gameState?.phase).toBe('play')
  })

  it('writes action records once and keeps idempotency by action id', async () => {
    let now = 100
    const store = createRoomStore({
      client: new FakeFirebaseClient(),
      now: () => {
        now += 1
        return now
      }
    })

    await store.createRoom({
      roomId: 'table-a',
      displayName: 'table-a',
      hostId: 'p1',
      hostName: 'Host',
      expectedPlayers: 2
    })

    const first = await store.appendAction({
      roomId: 'table-a',
      actorId: 'p1',
      action: { id: 'p1-1', type: 'ready', playerId: 'p1' }
    })
    const second = await store.appendAction({
      roomId: 'table-a',
      actorId: 'p1',
      action: { id: 'p1-1', type: 'ready', playerId: 'p1' }
    })
    const snapshot = await store.fetchRoomSnapshot('table-a')

    expect(first).not.toBeNull()
    expect(first?.id).toBe('p1-1')
    expect(first?.gameId).toBeTruthy()
    expect(first?.actorId).toBe('p1')
    expect(second).toBeNull()
    expect(snapshot.actions).toHaveLength(1)
    expect(snapshot.actions[0]?.id).toBe('p1-1')
  })

  it('uses current gameId to isolate future sessions from past actions', async () => {
    let now = 100
    const store = createRoomStore({
      client: new FakeFirebaseClient(),
      now: () => {
        now += 1
        return now
      }
    })

    await store.createRoom({
      roomId: 'table-iso',
      displayName: 'table-iso',
      hostId: 'p1',
      hostName: 'Host',
      expectedPlayers: 2
    })
    await store.appendAction({
      roomId: 'table-iso',
      actorId: 'p1',
      action: { id: 'p1-1', type: 'ready', playerId: 'p1' }
    })

    const beforeRestart = await store.fetchRoomSnapshot('table-iso')
    const firstGameId = beforeRestart.meta?.currentGameId
    expect(beforeRestart.actions.map((action) => action.id)).toEqual(['p1-1'])

    await store.restartGameSession({
      roomId: 'table-iso',
      hostId: 'p1',
      hostName: 'Host',
      expectedPlayers: 2
    })
    await store.appendAction({
      roomId: 'table-iso',
      actorId: 'p1',
      action: { id: 'p1-2', type: 'ready', playerId: 'p1' }
    })

    const afterRestart = await store.fetchRoomSnapshot('table-iso')
    expect(afterRestart.meta?.currentGameId).not.toBe(firstGameId)
    expect(afterRestart.actions.map((action) => action.id)).toEqual(['p1-2'])
  })

  it('auto-creates room on join when metadata is missing', async () => {
    const store = createRoomStore({
      client: new FakeFirebaseClient(),
      now: () => 100
    })

    const snapshot = await store.joinRoom({
      roomId: 'wolf-tree-4',
      playerId: 'p-host',
      playerName: 'Host',
      role: 'guest'
    })

    expect(snapshot.meta).not.toBeNull()
    expect(snapshot.meta?.hostId).toBe('p-host')
    expect(snapshot.participants.some((participant) => participant.playerId === 'p-host')).toBe(true)
  })
})
