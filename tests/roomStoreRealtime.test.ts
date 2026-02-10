import { describe, expect, it } from 'vitest'
import {
  FirebaseChildSubscriptionHandlers,
  FirebaseRequestOptions,
  FirebaseRestClient,
  FirebaseValueSubscriptionHandlers
} from '../src/sync/firebaseClient'
import { createRoomStore, type RoomDirectoryEntry, type RoomSnapshot } from '../src/sync/roomStore'

class RealtimeMemoryClient implements FirebaseRestClient {
  isConfigured = true
  baseUrl = 'https://fake.firebaseio.test'
  supportsRealtime = true
  private db: Record<string, unknown> = {}
  private valueSubscriptions = new Map<string, Set<FirebaseValueSubscriptionHandlers>>()
  private childSubscriptions = new Map<string, Set<FirebaseChildSubscriptionHandlers>>()

  async requestJson<T>(path: string, options?: FirebaseRequestOptions): Promise<T> {
    const method = options?.method ?? 'GET'
    const normalizedPath = normalizePath(path)
    if (method === 'GET') {
      return this.read(normalizedPath) as T
    }

    const before = structuredClone(this.db)
    if (method === 'PUT') {
      this.write(normalizedPath, options?.body)
      this.emitDiff(before)
      return (options?.body ?? null) as T
    }
    if (method === 'PATCH') {
      const current = this.read(normalizedPath)
      const merged =
        isRecord(current) && isRecord(options?.body)
          ? { ...current, ...(options?.body as Record<string, unknown>) }
          : (options?.body ?? null)
      this.write(normalizedPath, merged)
      this.emitDiff(before)
      return merged as T
    }
    if (method === 'DELETE') {
      this.delete(normalizedPath)
      this.emitDiff(before)
      return null as T
    }
    throw new Error(`Unsupported method: ${method}`)
  }

  subscribeValue(path: string, handlers: FirebaseValueSubscriptionHandlers): () => void {
    const normalizedPath = normalizePath(path)
    const subscriptions = this.valueSubscriptions.get(normalizedPath) ?? new Set()
    subscriptions.add(handlers)
    this.valueSubscriptions.set(normalizedPath, subscriptions)
    handlers.onValue(this.read(normalizedPath))
    return () => {
      const existing = this.valueSubscriptions.get(normalizedPath)
      if (!existing) return
      existing.delete(handlers)
      if (existing.size === 0) this.valueSubscriptions.delete(normalizedPath)
    }
  }

  subscribeChild(path: string, handlers: FirebaseChildSubscriptionHandlers): () => void {
    const normalizedPath = normalizePath(path)
    const subscriptions = this.childSubscriptions.get(normalizedPath) ?? new Set()
    subscriptions.add(handlers)
    this.childSubscriptions.set(normalizedPath, subscriptions)

    const current = asRecord(this.read(normalizedPath))
    if (current) {
      Object.entries(current).forEach(([key, value]) => handlers.onAdded?.(key, structuredClone(value)))
    }

    return () => {
      const existing = this.childSubscriptions.get(normalizedPath)
      if (!existing) return
      existing.delete(handlers)
      if (existing.size === 0) this.childSubscriptions.delete(normalizedPath)
    }
  }

  private emitDiff(before: Record<string, unknown>) {
    for (const [path, subscriptions] of this.valueSubscriptions.entries()) {
      const previous = readFrom(before, path)
      const next = this.read(path)
      if (deepEqual(previous, next)) continue
      subscriptions.forEach((handlers) => handlers.onValue(structuredClone(next)))
    }

    for (const [path, subscriptions] of this.childSubscriptions.entries()) {
      const previousRecord = asRecord(readFrom(before, path)) ?? {}
      const nextRecord = asRecord(this.read(path)) ?? {}
      const keys = new Set([...Object.keys(previousRecord), ...Object.keys(nextRecord)])
      keys.forEach((key) => {
        const previous = previousRecord[key]
        const next = nextRecord[key]
        subscriptions.forEach((handlers) => {
          if (previous === undefined && next !== undefined) {
            handlers.onAdded?.(key, structuredClone(next))
            return
          }
          if (previous !== undefined && next === undefined) {
            handlers.onRemoved?.(key, structuredClone(previous))
            return
          }
          if (previous !== undefined && next !== undefined && !deepEqual(previous, next)) {
            handlers.onChanged?.(key, structuredClone(next))
          }
        })
      })
    }
  }

  private read(path: string): unknown {
    return readFrom(this.db, path)
  }

  private write(path: string, value: unknown) {
    const segments = splitPath(path)
    if (segments.length === 0) {
      this.db = isRecord(value) ? structuredClone(value) : {}
      return
    }
    let current: Record<string, unknown> = this.db
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]
      if (!segment) continue
      if (!isRecord(current[segment])) current[segment] = {}
      current = current[segment] as Record<string, unknown>
    }
    const leaf = segments[segments.length - 1]
    if (!leaf) return
    current[leaf] = value === undefined ? null : structuredClone(value)
  }

  private delete(path: string) {
    const segments = splitPath(path)
    if (segments.length === 0) {
      this.db = {}
      return
    }
    let current: Record<string, unknown> = this.db
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]
      if (!segment) continue
      const next = current[segment]
      if (!isRecord(next)) return
      current = next
    }
    const leaf = segments[segments.length - 1]
    if (!leaf) return
    delete current[leaf]
  }
}

class FaultyRealtimeClient extends RealtimeMemoryClient {
  subscribeValue(_path: string, _handlers: FirebaseValueSubscriptionHandlers): () => void {
    throw new Error('listener setup failed')
  }

  subscribeChild(_path: string, _handlers: FirebaseChildSubscriptionHandlers): () => void {
    throw new Error('listener setup failed')
  }
}

function createTrackingTimers() {
  let nextId = 1
  const callbacks = new Map<number, () => void>()
  let intervalCount = 0
  return {
    timers: {
      setInterval: ((callback: TimerHandler) => {
        const id = nextId
        nextId += 1
        callbacks.set(id, callback as () => void)
        intervalCount += 1
        return id as unknown as ReturnType<typeof setInterval>
      }) as typeof globalThis.setInterval,
      clearInterval: ((id: number) => {
        callbacks.delete(id)
      }) as typeof globalThis.clearInterval
    },
    tick: async () => {
      for (const callback of callbacks.values()) {
        callback()
      }
      await flush()
      await flush()
    },
    getIntervalCount: () => intervalCount
  }
}

describe('roomStore realtime subscriptions', () => {
  it('updates room snapshot via realtime listeners without polling timers', async () => {
    let currentTime = 100
    const timers = createTrackingTimers()
    const store = createRoomStore({
      client: new RealtimeMemoryClient(),
      now: () => {
        currentTime += 5
        return currentTime
      },
      timers: timers.timers
    })

    await store.createRoom({
      roomId: 'sync-room',
      displayName: 'sync-room',
      hostId: 'p1',
      hostName: 'Host',
      expectedPlayers: 2
    })
    await store.joinRoom({
      roomId: 'sync-room',
      playerId: 'p2',
      playerName: 'Guest',
      role: 'guest'
    })

    const snapshots: RoomSnapshot[] = []
    const errors: string[] = []
    const unsubscribe = store.subscribeRoomSnapshot('sync-room', {
      onUpdate: (snapshot) => snapshots.push(snapshot),
      onError: (error) => errors.push(error.message)
    })
    await flush()

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
    await flush()
    await flush()

    expect(errors).toEqual([])
    expect(timers.getIntervalCount()).toBe(0)
    expect(snapshots.some((snapshot) => snapshot.gameStateIncluded)).toBe(true)
    expect(snapshots.some((snapshot) => !snapshot.gameStateIncluded)).toBe(true)
    expect(snapshots.at(-1)?.actions.map((record) => record.id)).toEqual(['p1-1', 'p2-1'])
    unsubscribe()
  })

  it('refreshes game state on session transition in realtime mode', async () => {
    let currentTime = 1000
    const timers = createTrackingTimers()
    const store = createRoomStore({
      client: new RealtimeMemoryClient(),
      now: () => {
        currentTime += 10
        return currentTime
      },
      timers: timers.timers
    })

    await store.createRoom({
      roomId: 'session-room',
      displayName: 'session-room',
      hostId: 'p1',
      hostName: 'Host',
      expectedPlayers: 2
    })
    await store.joinRoom({
      roomId: 'session-room',
      playerId: 'p2',
      playerName: 'Guest',
      role: 'guest'
    })

    const snapshots: RoomSnapshot[] = []
    const unsubscribe = store.subscribeRoomSnapshot('session-room', {
      onUpdate: (snapshot) => snapshots.push(snapshot)
    })
    await flush()

    const before = await store.fetchRoomSnapshot('session-room')
    if (!before.meta) throw new Error('Expected meta before reset')
    const restarted = await store.resetRoundSession({
      roomId: 'session-room',
      expectedGameId: before.meta.currentGameId
    })
    await flush()
    await flush()

    expect(
      snapshots.some(
        (snapshot) => snapshot.meta?.currentGameId === restarted.meta?.currentGameId && snapshot.gameStateIncluded
      )
    ).toBe(true)
    unsubscribe()
  })

  it('updates room directory via realtime listener and keeps cleanup timer', async () => {
    let currentTime = 2000
    const timers = createTrackingTimers()
    const store = createRoomStore({
      client: new RealtimeMemoryClient(),
      now: () => {
        currentTime += 10
        return currentTime
      },
      timers: timers.timers
    })

    const snapshots: RoomDirectoryEntry[][] = []
    const unsubscribe = store.subscribeRoomDirectory({
      onUpdate: (rooms) => snapshots.push(rooms)
    })
    await flush()

    await store.createRoom({
      roomId: 'dir-room',
      displayName: 'dir-room',
      hostId: 'p1',
      hostName: 'Host',
      expectedPlayers: 2
    })
    await flush()
    await flush()

    expect(snapshots.some((rooms) => rooms.some((room) => room.roomId === 'dir-room'))).toBe(true)
    expect(timers.getIntervalCount()).toBe(1)
    unsubscribe()
  })

  it('falls back to polling for room snapshot when realtime listener setup fails', async () => {
    let currentTime = 3000
    const timers = createTrackingTimers()
    const store = createRoomStore({
      client: new FaultyRealtimeClient(),
      now: () => {
        currentTime += 10
        return currentTime
      },
      timers: timers.timers
    })

    await store.createRoom({
      roomId: 'fallback-room',
      displayName: 'fallback-room',
      hostId: 'p1',
      hostName: 'Host',
      expectedPlayers: 2
    })
    await store.joinRoom({
      roomId: 'fallback-room',
      playerId: 'p2',
      playerName: 'Guest',
      role: 'guest'
    })

    const snapshots: RoomSnapshot[] = []
    const errors: string[] = []
    const unsubscribe = store.subscribeRoomSnapshot('fallback-room', {
      onUpdate: (snapshot) => snapshots.push(snapshot),
      onError: (error) => errors.push(error.message)
    })

    await store.appendAction({
      roomId: 'fallback-room',
      actorId: 'p1',
      action: { id: 'fallback-1', type: 'ready', playerId: 'p1' }
    })
    await timers.tick()
    await timers.tick()

    expect(errors).toHaveLength(1)
    expect(timers.getIntervalCount()).toBe(1)
    expect(snapshots.at(-1)?.actions.map((record) => record.id)).toContain('fallback-1')
    unsubscribe()
  })

  it('falls back to polling for room directory when realtime listener setup fails', async () => {
    let currentTime = 4000
    const timers = createTrackingTimers()
    const store = createRoomStore({
      client: new FaultyRealtimeClient(),
      now: () => {
        currentTime += 10
        return currentTime
      },
      timers: timers.timers
    })

    const snapshots: RoomDirectoryEntry[][] = []
    const errors: string[] = []
    const unsubscribe = store.subscribeRoomDirectory({
      onUpdate: (rooms) => snapshots.push(rooms),
      onError: (error) => errors.push(error.message)
    })
    await store.createRoom({
      roomId: 'fallback-dir',
      displayName: 'fallback-dir',
      hostId: 'p1',
      hostName: 'Host',
      expectedPlayers: 2
    })
    await timers.tick()
    await timers.tick()

    expect(errors).toHaveLength(1)
    expect(snapshots.some((rooms) => rooms.some((room) => room.roomId === 'fallback-dir'))).toBe(true)
    expect(timers.getIntervalCount()).toBeGreaterThanOrEqual(3)
    unsubscribe()
  })
})

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

function normalizePath(path: string): string {
  return path
    .replace(/\.json$/, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment))
    .join('/')
}

function splitPath(path: string): string[] {
  return normalizePath(path).split('/').filter(Boolean)
}

function readFrom(root: Record<string, unknown>, path: string): unknown {
  const segments = splitPath(path)
  let current: unknown = root
  for (const segment of segments) {
    if (!isRecord(current)) return null
    current = current[segment]
    if (current === undefined) return null
  }
  return current === undefined ? null : structuredClone(current)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
