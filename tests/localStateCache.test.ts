import { describe, expect, it } from 'vitest'
import { GameAction, GameState, initialGameState } from '../src/state/gameState'
import { clearAllRoomCaches, clearRoomCache, loadRoomCache, saveRoomCache } from '../src/sync/localStateCache'

class MemoryStorage {
  private readonly store = new Map<string, string>()

  get length(): number {
    return this.store.size
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null
  }
}

function sampleStateAndActions(): { state: GameState; actions: GameAction[] } {
  const state = initialGameState([
    { id: 'p1', name: 'Host', seat: 0, connected: true, ready: false },
    { id: 'p2', name: 'Guest', seat: 1, connected: true, ready: false }
  ])
  const actions: GameAction[] = [
    { id: 'p1-1', type: 'ready', playerId: 'p1' },
    { id: 'p2-1', type: 'ready', playerId: 'p2' }
  ]
  return {
    state: { ...state, actionLog: actions },
    actions
  }
}

describe('localStateCache', () => {
  it('saves and loads cached room state', () => {
    const storage = new MemoryStorage()
    const { state, actions } = sampleStateAndActions()
    saveRoomCache(
      'alpha',
      {
        gameId: 'g-1',
        actionsVersion: 4,
        state,
        actions,
        role: 'host',
        joinedAt: 123
      },
      storage
    )

    const loaded = loadRoomCache('alpha', storage)
    expect(loaded).not.toBeNull()
    expect(loaded).toMatchObject({
      gameId: 'g-1',
      actionsVersion: 4,
      role: 'host',
      joinedAt: 123
    })
    expect(loaded?.actions.map((action) => action.id)).toEqual(['p1-1', 'p2-1'])
  })

  it('returns null when cache data is missing or malformed', () => {
    const storage = new MemoryStorage()
    const { state, actions } = sampleStateAndActions()
    saveRoomCache(
      'beta',
      {
        gameId: 'g-2',
        actionsVersion: 3,
        state,
        actions,
        role: 'guest',
        joinedAt: 456
      },
      storage
    )

    storage.setItem('ofc:room:beta:state', '{not-json')
    expect(loadRoomCache('beta', storage)).toBeNull()
  })

  it('clears one room cache without touching others', () => {
    const storage = new MemoryStorage()
    const { state, actions } = sampleStateAndActions()
    saveRoomCache('one', { gameId: 'g-1', actionsVersion: 1, state, actions, role: 'host', joinedAt: 1 }, storage)
    saveRoomCache('two', { gameId: 'g-2', actionsVersion: 2, state, actions, role: 'guest', joinedAt: 2 }, storage)

    clearRoomCache('one', storage)
    expect(loadRoomCache('one', storage)).toBeNull()
    expect(loadRoomCache('two', storage)?.gameId).toBe('g-2')
  })

  it('clears all ofc:room:* entries only', () => {
    const storage = new MemoryStorage()
    const { state, actions } = sampleStateAndActions()
    saveRoomCache('one', { gameId: 'g-1', actionsVersion: 1, state, actions, role: 'host', joinedAt: 1 }, storage)
    storage.setItem('ofc:player-name', 'Bert')

    clearAllRoomCaches(storage)

    expect(loadRoomCache('one', storage)).toBeNull()
    expect(storage.getItem('ofc:player-name')).toBe('Bert')
  })
})
