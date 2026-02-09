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

type TimerTask = { id: number; callback: () => void }

function createManualTimers() {
  let nextId = 1
  const tasks = new Map<number, TimerTask>()
  return {
    timers: {
      setInterval: ((callback: TimerHandler) => {
        const id = nextId
        nextId += 1
        tasks.set(id, { id, callback: callback as () => void })
        return id as unknown as ReturnType<typeof setInterval>
      }) as typeof globalThis.setInterval,
      clearInterval: ((id: number) => {
        tasks.delete(id)
      }) as typeof globalThis.clearInterval
    },
    tick: async () => {
      for (const task of [...tasks.values()]) {
        task.callback()
      }
      await Promise.resolve()
      await Promise.resolve()
    }
  }
}

describe('roomStore subscription sync', () => {
  it('pushes snapshot updates after new actions are appended', async () => {
    let time = 100
    const manual = createManualTimers()
    const store = createRoomStore({
      client: new FakeFirebaseClient(),
      now: () => {
        time += 5
        return time
      },
      timers: manual.timers
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

    const observedActionCounts: number[] = []
    let latestHydratedActionIds: string[] = []
    const unsubscribe = store.subscribeRoomSnapshot('sync-room', {
      onUpdate: (snapshot) => {
        observedActionCounts.push(snapshot.actions.length)
        const hydrated = hydrateRoomState({
          localPlayerId: 'p2',
          localPlayerName: 'Guest',
          participants: snapshot.participants,
          actionRecords: snapshot.actions
        })
        latestHydratedActionIds = hydrated.actionLog.map((action) => action.id)
      }
    })

    await manual.tick()
    expect(observedActionCounts.at(-1)).toBe(0)

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

    await manual.tick()

    expect(observedActionCounts.at(-1)).toBe(2)
    expect(latestHydratedActionIds).toEqual(['p1-1', 'p2-1'])
    unsubscribe()
  })
})
