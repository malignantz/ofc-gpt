import type { GameAction, GameState } from '../state/gameState'
import type { RoomRole } from './roomStore'

export type CachedRoomState = {
  gameId: string
  actionsVersion: number
  state: GameState
  actions: GameAction[]
  role: RoomRole
  joinedAt: number
}

type StorageLike = {
  length: number
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
  key: (index: number) => string | null
}

const ROOM_PREFIX = 'ofc:room:'

function roomKey(roomId: string, field: string): string {
  return `${ROOM_PREFIX}${roomId}:${field}`
}

function resolveStorage(storage?: StorageLike): StorageLike | null {
  if (storage) return storage
  if (typeof window === 'undefined') return null
  return window.localStorage
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseRole(value: unknown): RoomRole | null {
  if (value === 'host' || value === 'guest') return value
  return null
}

function parseInteger(raw: string): number | null {
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value)) return null
  if (value < 0) return null
  return value
}

function isGameAction(value: unknown): value is GameAction {
  if (!isRecord(value)) return false
  return asString(value.id) !== null && asString(value.type) !== null
}

function isGameState(value: unknown): value is GameState {
  if (!isRecord(value)) return false
  if (!Array.isArray(value.players)) return false
  if (!Array.isArray(value.actionLog)) return false
  if (!isRecord(value.lines)) return false
  if (!isRecord(value.pending)) return false
  if (!isRecord(value.commits)) return false
  if (!isRecord(value.reveals)) return false
  if (!Array.isArray(value.deck)) return false
  if (!Array.isArray(value.drawOrder)) return false
  if (asNumber(value.dealerSeat) === null) return false
  if (asNumber(value.turnSeat) === null) return false
  if (asNumber(value.drawIndex) === null) return false
  if (value.turnStage !== 'draw' && value.turnStage !== 'place') return false
  if (
    value.phase !== 'lobby' &&
    value.phase !== 'commit' &&
    value.phase !== 'reveal' &&
    value.phase !== 'initial' &&
    value.phase !== 'play' &&
    value.phase !== 'score'
  ) {
    return false
  }
  return true
}

export function saveRoomCache(roomId: string, cached: CachedRoomState, storage?: StorageLike): void {
  const target = resolveStorage(storage)
  if (!target) return
  try {
    target.setItem(roomKey(roomId, 'gameId'), cached.gameId)
    target.setItem(roomKey(roomId, 'actionsVersion'), `${cached.actionsVersion}`)
    target.setItem(roomKey(roomId, 'state'), JSON.stringify(cached.state))
    target.setItem(roomKey(roomId, 'actions'), JSON.stringify(cached.actions))
    target.setItem(roomKey(roomId, 'role'), cached.role)
    target.setItem(roomKey(roomId, 'joinedAt'), `${cached.joinedAt}`)
  } catch {
    // Ignore storage write failures.
  }
}

export function loadRoomCache(roomId: string, storage?: StorageLike): CachedRoomState | null {
  const target = resolveStorage(storage)
  if (!target) return null
  try {
    const rawGameId = target.getItem(roomKey(roomId, 'gameId'))
    const rawActionsVersion = target.getItem(roomKey(roomId, 'actionsVersion'))
    const rawState = target.getItem(roomKey(roomId, 'state'))
    const rawActions = target.getItem(roomKey(roomId, 'actions'))
    const rawRole = target.getItem(roomKey(roomId, 'role'))
    const rawJoinedAt = target.getItem(roomKey(roomId, 'joinedAt'))
    if (!rawGameId || !rawActionsVersion || !rawState || !rawActions || !rawRole || !rawJoinedAt) return null

    const actionsVersion = parseInteger(rawActionsVersion)
    const joinedAt = parseInteger(rawJoinedAt)
    const role = parseRole(rawRole)
    if (actionsVersion === null || joinedAt === null || role === null) return null

    const state = JSON.parse(rawState)
    if (!isGameState(state)) return null

    const actionsRaw = JSON.parse(rawActions)
    if (!Array.isArray(actionsRaw)) return null
    const actions = actionsRaw.filter((action): action is GameAction => isGameAction(action))
    if (actions.length !== actionsRaw.length) return null

    return {
      gameId: rawGameId,
      actionsVersion,
      state,
      actions,
      role,
      joinedAt
    }
  } catch {
    return null
  }
}

export function clearRoomCache(roomId: string, storage?: StorageLike): void {
  const target = resolveStorage(storage)
  if (!target) return
  try {
    target.removeItem(roomKey(roomId, 'gameId'))
    target.removeItem(roomKey(roomId, 'actionsVersion'))
    target.removeItem(roomKey(roomId, 'state'))
    target.removeItem(roomKey(roomId, 'actions'))
    target.removeItem(roomKey(roomId, 'role'))
    target.removeItem(roomKey(roomId, 'joinedAt'))
  } catch {
    // Ignore storage write failures.
  }
}

export function clearAllRoomCaches(storage?: StorageLike): void {
  const target = resolveStorage(storage)
  if (!target) return
  try {
    const toRemove: string[] = []
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index)
      if (!key || !key.startsWith(ROOM_PREFIX)) continue
      toRemove.push(key)
    }
    toRemove.forEach((key) => target.removeItem(key))
  } catch {
    // Ignore storage clear failures.
  }
}
