import { afterEach, describe, expect, it, vi } from 'vitest'
import { FirebaseConfig } from '../src/sync/firebaseClient'
import { createFirebaseSdkClient } from '../src/sync/firebaseSdkClient'

type FakeReference = { path: string }

class FakeSnapshot {
  constructor(private readonly value: unknown, readonly key: string | null) {}

  exists() {
    return this.value !== null && this.value !== undefined
  }

  val() {
    return structuredClone(this.value)
  }
}

class FakeSdkDeps {
  private db: Record<string, unknown> = {}
  private apps: Array<{ name: string }> = []
  private valueSubscriptions = new Map<string, Set<(snapshot: FakeSnapshot) => void>>()
  private childAddedSubscriptions = new Map<string, Set<(snapshot: FakeSnapshot) => void>>()
  private childChangedSubscriptions = new Map<string, Set<(snapshot: FakeSnapshot) => void>>()
  private childRemovedSubscriptions = new Map<string, Set<(snapshot: FakeSnapshot) => void>>()

  getApps = () => this.apps as unknown as ReturnType<typeof import('firebase/app').getApps>

  getApp = (name: string) => {
    const existing = this.apps.find((app) => app.name === name)
    if (!existing) throw new Error(`Missing app: ${name}`)
    return existing as unknown as ReturnType<typeof import('firebase/app').getApp>
  }

  initializeApp = (_config: unknown, name?: string) => {
    const app = { name: name ?? '[default]' }
    this.apps.push(app)
    return app as unknown as ReturnType<typeof import('firebase/app').initializeApp>
  }

  getDatabase = () => ({}) as ReturnType<typeof import('firebase/database').getDatabase>

  ref = (_database: unknown, path = '') => ({ path }) as unknown as ReturnType<typeof import('firebase/database').ref>

  get = async (reference: FakeReference) =>
    new FakeSnapshot(this.read(reference.path), leafKey(reference.path)) as unknown as ReturnType<
      typeof import('firebase/database').get
    > extends Promise<infer T>
      ? T
      : never

  set = async (reference: FakeReference, value: unknown) => {
    this.write(reference.path, value)
  }

  update = async (reference: FakeReference, value: unknown) => {
    const current = this.read(reference.path)
    if (isRecord(current) && isRecord(value)) {
      this.write(reference.path, { ...current, ...value })
      return
    }
    this.write(reference.path, value)
  }

  remove = async (reference: FakeReference) => {
    this.delete(reference.path)
  }

  onValue = (reference: FakeReference, callback: (snapshot: FakeSnapshot) => void) => {
    const path = reference.path
    const subscriptions = this.valueSubscriptions.get(path) ?? new Set()
    subscriptions.add(callback)
    this.valueSubscriptions.set(path, subscriptions)
    callback(this.snapshot(path))
    return () => {
      const current = this.valueSubscriptions.get(path)
      if (!current) return
      current.delete(callback)
      if (current.size === 0) this.valueSubscriptions.delete(path)
    }
  }

  onChildAdded = (reference: FakeReference, callback: (snapshot: FakeSnapshot) => void) => {
    const path = reference.path
    const subscriptions = this.childAddedSubscriptions.get(path) ?? new Set()
    subscriptions.add(callback)
    this.childAddedSubscriptions.set(path, subscriptions)
    const current = asRecord(this.read(path))
    if (current) {
      Object.entries(current).forEach(([key, value]) => callback(new FakeSnapshot(value, key)))
    }
    return () => {
      const existing = this.childAddedSubscriptions.get(path)
      if (!existing) return
      existing.delete(callback)
      if (existing.size === 0) this.childAddedSubscriptions.delete(path)
    }
  }

  onChildChanged = (reference: FakeReference, callback: (snapshot: FakeSnapshot) => void) => {
    const path = reference.path
    const subscriptions = this.childChangedSubscriptions.get(path) ?? new Set()
    subscriptions.add(callback)
    this.childChangedSubscriptions.set(path, subscriptions)
    return () => {
      const existing = this.childChangedSubscriptions.get(path)
      if (!existing) return
      existing.delete(callback)
      if (existing.size === 0) this.childChangedSubscriptions.delete(path)
    }
  }

  onChildRemoved = (reference: FakeReference, callback: (snapshot: FakeSnapshot) => void) => {
    const path = reference.path
    const subscriptions = this.childRemovedSubscriptions.get(path) ?? new Set()
    subscriptions.add(callback)
    this.childRemovedSubscriptions.set(path, subscriptions)
    return () => {
      const existing = this.childRemovedSubscriptions.get(path)
      if (!existing) return
      existing.delete(callback)
      if (existing.size === 0) this.childRemovedSubscriptions.delete(path)
    }
  }

  emitValue(path: string, value: unknown) {
    this.write(path, value)
    const subscriptions = this.valueSubscriptions.get(path)
    subscriptions?.forEach((callback) => callback(this.snapshot(path)))
  }

  emitChildAdded(path: string, key: string, value: unknown) {
    this.write(`${path}/${key}`, value)
    this.childAddedSubscriptions.get(path)?.forEach((callback) => callback(new FakeSnapshot(value, key)))
  }

  emitChildChanged(path: string, key: string, value: unknown) {
    this.write(`${path}/${key}`, value)
    this.childChangedSubscriptions.get(path)?.forEach((callback) => callback(new FakeSnapshot(value, key)))
  }

  emitChildRemoved(path: string, key: string) {
    const value = this.read(`${path}/${key}`)
    this.delete(`${path}/${key}`)
    this.childRemovedSubscriptions.get(path)?.forEach((callback) => callback(new FakeSnapshot(value, key)))
  }

  readPath(path: string): unknown {
    return this.read(path)
  }

  private snapshot(path: string) {
    return new FakeSnapshot(this.read(path), leafKey(path))
  }

  private read(path: string): unknown {
    const segments = splitPath(path)
    let current: unknown = this.db
    for (const segment of segments) {
      if (!isRecord(current)) return null
      current = current[segment]
      if (current === undefined) return null
    }
    return current === undefined ? null : structuredClone(current)
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
    current[leaf] = structuredClone(value)
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

const config: FirebaseConfig = {
  apiKey: 'key',
  authDomain: 'demo.firebaseapp.com',
  databaseUrl: 'https://demo-default-rtdb.firebaseio.com',
  projectId: 'demo',
  appId: 'app'
}

describe('firebaseSdkClient', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('maps GET/PUT/PATCH/DELETE to SDK data operations', async () => {
    const deps = new FakeSdkDeps()
    const client = createFirebaseSdkClient({ config, deps: deps as never })

    await client.requestJson('/rooms/alpha', { method: 'PUT', body: { a: 1 } })
    expect(await client.requestJson('/rooms/alpha')).toEqual({ a: 1 })

    await client.requestJson('/rooms/alpha', { method: 'PATCH', body: { b: 2 } })
    expect(await client.requestJson('/rooms/alpha')).toEqual({ a: 1, b: 2 })

    await client.requestJson('/rooms/alpha', { method: 'DELETE' })
    expect(await client.requestJson('/rooms/alpha')).toBeNull()
  }, 15_000)

  it('decodes encoded path segments before read/write', async () => {
    const deps = new FakeSdkDeps()
    const client = createFirebaseSdkClient({ config, deps: deps as never })

    await client.requestJson('/rooms/alpha/actions/key%2E1', { method: 'PUT', body: { ok: true } })

    expect(deps.readPath('rooms/alpha/actions/key.1')).toEqual({ ok: true })
  })

  it('supports value subscriptions and unsubscribe', async () => {
    const deps = new FakeSdkDeps()
    const client = createFirebaseSdkClient({ config, deps: deps as never })
    const updates: unknown[] = []

    const unsubscribe = client.subscribeValue?.('/rooms/live', {
      onValue: (value) => updates.push(value)
    })
    expect(updates).toEqual([null])

    deps.emitValue('rooms/live', { ok: true })
    expect(updates.at(-1)).toEqual({ ok: true })

    unsubscribe?.()
    deps.emitValue('rooms/live', { ok: false })
    expect(updates.at(-1)).toEqual({ ok: true })
  })

  it('supports child subscriptions and unsubscribe', async () => {
    const deps = new FakeSdkDeps()
    const client = createFirebaseSdkClient({ config, deps: deps as never })
    const added: string[] = []
    const changed: string[] = []
    const removed: string[] = []

    const unsubscribe = client.subscribeChild?.('/rooms/live/actions', {
      onAdded: (key) => added.push(key),
      onChanged: (key) => changed.push(key),
      onRemoved: (key) => removed.push(key)
    })

    deps.emitChildAdded('rooms/live/actions', 'a1', { value: 1 })
    deps.emitChildChanged('rooms/live/actions', 'a1', { value: 2 })
    deps.emitChildRemoved('rooms/live/actions', 'a1')

    expect(added).toEqual(['a1'])
    expect(changed).toEqual(['a1'])
    expect(removed).toEqual(['a1'])

    unsubscribe?.()
    deps.emitChildAdded('rooms/live/actions', 'a2', { value: 3 })
    expect(added).toEqual(['a1'])
  })

  it('rate limits sdk-backed requests to at most one per second', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const deps = new FakeSdkDeps()
    const client = createFirebaseSdkClient({ config, deps: deps as never })

    await client.requestJson('/rooms/first', { method: 'PUT', body: { ok: 1 } })
    expect(deps.readPath('rooms/first')).toEqual({ ok: 1 })

    const secondRequest = client.requestJson('/rooms/second', { method: 'PUT', body: { ok: 2 } })
    await Promise.resolve()
    expect(deps.readPath('rooms/second')).toBeNull()

    await vi.advanceTimersByTimeAsync(999)
    expect(deps.readPath('rooms/second')).toBeNull()

    await vi.advanceTimersByTimeAsync(1)
    await secondRequest
    expect(deps.readPath('rooms/second')).toEqual({ ok: 2 })
  })
})

function splitPath(path: string): string[] {
  return path
    .replace(/\.json$/, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment))
}

function leafKey(path: string): string | null {
  const segments = splitPath(path)
  return segments.length === 0 ? null : segments[segments.length - 1] ?? null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
