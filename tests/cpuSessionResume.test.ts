import { describe, expect, it } from 'vitest'
import { initialGameState, type Player } from '../src/state/gameState'
import { resolveCpuSessionForLocalPlayer } from '../src/ui/App'

const LOCAL_PLAYER_ID = 'p-local'

const cpuPlayers: Player[] = [
  { id: LOCAL_PLAYER_ID, name: 'Local', seat: 0, connected: true, ready: false },
  { id: '__cpu_bot__', name: 'CPU', seat: 1, connected: true, ready: false }
]

const onlinePlayers: Player[] = [
  { id: LOCAL_PLAYER_ID, name: 'Local', seat: 0, connected: true, ready: false },
  { id: 'p-remote', name: 'Remote', seat: 1, connected: true, ready: false }
]

describe('resolveCpuSessionForLocalPlayer', () => {
  it('returns the session when it belongs to the local player and has CPU state', () => {
    const session = {
      version: 1 as const,
      localPlayerId: LOCAL_PLAYER_ID,
      state: initialGameState(cpuPlayers),
      actionCounter: 6,
      savedAt: Date.now()
    }

    expect(resolveCpuSessionForLocalPlayer(session, LOCAL_PLAYER_ID)).toBe(session)
  })

  it('rejects sessions for a different local player id', () => {
    const session = {
      version: 1 as const,
      localPlayerId: 'someone-else',
      state: initialGameState(cpuPlayers),
      actionCounter: 6,
      savedAt: Date.now()
    }

    expect(resolveCpuSessionForLocalPlayer(session, LOCAL_PLAYER_ID)).toBeNull()
  })

  it('rejects non-CPU sessions', () => {
    const session = {
      version: 1 as const,
      localPlayerId: LOCAL_PLAYER_ID,
      state: initialGameState(onlinePlayers),
      actionCounter: 2,
      savedAt: Date.now()
    }

    expect(resolveCpuSessionForLocalPlayer(session, LOCAL_PLAYER_ID)).toBeNull()
  })
})
