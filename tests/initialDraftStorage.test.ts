import { describe, expect, it } from 'vitest'
import {
  buildDraftCardPoolSignature,
  buildInitialDraftStorageKey,
  clearInitialDraftSnapshot,
  readInitialDraftSnapshot,
  writeInitialDraftSnapshot
} from '../src/ui/utils/initialDraftStorage'

function createMemoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key) ?? null : null
    },
    key(index: number) {
      return [...store.keys()][index] ?? null
    },
    removeItem(key: string) {
      store.delete(key)
    },
    setItem(key: string, value: string) {
      store.set(key, value)
    }
  }
}

describe('initialDraftStorage', () => {
  it('builds room-scoped and cpu-scoped keys', () => {
    expect(buildInitialDraftStorageKey({ roomName: 'Alpha', playerId: 'p1' })).toBe(
      'ofc:initial-draft:v1:room:alpha:p1'
    )
    expect(buildInitialDraftStorageKey({ playerId: 'p1' })).toBe('ofc:initial-draft:v1:cpu_local:p1')
  })

  it('creates card pool signatures independent of placement order', () => {
    const first = buildDraftCardPoolSignature({
      lines: { top: ['AS'], middle: ['KH'], bottom: [] },
      pending: ['2C', 'JD']
    })
    const second = buildDraftCardPoolSignature({
      lines: { top: [], middle: ['JD'], bottom: ['2C'] },
      pending: ['AS', 'KH']
    })
    expect(second).toBe(first)
  })

  it('restores a stored draft when the card pool signature matches', () => {
    const storage = createMemoryStorage()
    const key = buildInitialDraftStorageKey({ roomName: 'test-room', playerId: 'p1' })
    const snapshot = {
      lines: { top: ['AS'], middle: [], bottom: ['KH'] },
      pending: ['2C', 'JD', '5S']
    }

    writeInitialDraftSnapshot(storage, key, snapshot)
    const signature = buildDraftCardPoolSignature(snapshot)
    expect(readInitialDraftSnapshot(storage, key, signature)).toEqual(snapshot)
  })

  it('ignores a stored draft when the card pool signature does not match', () => {
    const storage = createMemoryStorage()
    const key = buildInitialDraftStorageKey({ roomName: 'test-room', playerId: 'p1' })
    writeInitialDraftSnapshot(storage, key, {
      lines: { top: ['AS'], middle: [], bottom: [] },
      pending: ['2C', 'JD', '5S', 'KH']
    })

    expect(readInitialDraftSnapshot(storage, key, 'AS,2C,JD,5S,QH')).toBeNull()
  })

  it('rejects invalid payloads with duplicate cards', () => {
    const storage = createMemoryStorage()
    const key = buildInitialDraftStorageKey({ roomName: 'test-room', playerId: 'p1' })
    const snapshot = {
      version: 1,
      cardPoolSignature: 'AS,AS,2C,JD,KH',
      snapshot: {
        lines: { top: ['AS'], middle: ['AS'], bottom: [] },
        pending: ['2C', 'JD', 'KH']
      },
      savedAt: Date.now()
    }
    storage.setItem(key, JSON.stringify(snapshot))

    expect(readInitialDraftSnapshot(storage, key, snapshot.cardPoolSignature)).toBeNull()
  })

  it('clears a stored snapshot', () => {
    const storage = createMemoryStorage()
    const key = buildInitialDraftStorageKey({ roomName: 'test-room', playerId: 'p1' })
    writeInitialDraftSnapshot(storage, key, {
      lines: { top: ['AS'], middle: [], bottom: [] },
      pending: ['2C', 'JD', '5S', 'KH']
    })
    clearInitialDraftSnapshot(storage, key)
    expect(storage.getItem(key)).toBeNull()
  })
})
