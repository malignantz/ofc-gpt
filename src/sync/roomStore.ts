import type { GameAction } from '../state/gameState'
import { GameState, Player, initialGameState } from '../state/gameState'
import { createFirebaseRestClient, FirebaseRestClient } from './firebaseClient'
import { WAITING_OPPONENT_ID } from './constants'

const ROOM_TTL_MS = 5 * 60 * 1000
const ROOM_POLL_MS = 2000
const DIRECTORY_POLL_MS = 3000
const DIRECTORY_CLEANUP_MS = 60 * 1000

export type RoomRole = 'host' | 'guest'
export type RoomStatus = 'waiting' | 'active' | 'ended'

export type RoomDirectoryEntry = {
  roomId: string
  displayName: string
  hostName: string
  status: RoomStatus
  playerCount: number
  expectedPlayers: number
  updatedAt: number
  expiresAt: number
  discoverable: boolean
}

export type RoomMeta = {
  roomId: string
  hostId: string
  expectedPlayers: number
  currentGameId: string
  createdAt: number
  updatedAt: number
  expiresAt: number
  status: RoomStatus
}

export type ParticipantPresence = {
  playerId: string
  name: string
  role: RoomRole
  joinedAt: number
  lastSeenAt: number
  pingToken?: string
  pingAt?: number
  ackForPeerPingToken?: string
  ackAt?: number
}

export type ActionRecord = {
  id: string
  gameId: string
  action: GameAction
  actorId: string
  createdAt: number
}

export type RoomSnapshot = {
  roomId: string
  meta: RoomMeta | null
  participants: ParticipantPresence[]
  actions: ActionRecord[]
  gameState: GameState | null
}

export type RoomStore = {
  isConfigured: boolean
  createRoom: (input: {
    roomId: string
    displayName: string
    hostId: string
    hostName: string
    expectedPlayers?: number
  }) => Promise<RoomSnapshot>
  joinRoom: (input: {
    roomId: string
    playerId: string
    playerName: string
    role: RoomRole
  }) => Promise<RoomSnapshot>
  restartGameSession: (input: {
    roomId: string
    hostId: string
    hostName: string
    expectedPlayers?: number
  }) => Promise<RoomSnapshot>
  resetRoundSession: (input: { roomId: string; expectedGameId?: string }) => Promise<RoomSnapshot>
  leaveRoom: (roomId: string, playerId: string) => Promise<void>
  touchPresence: (input: {
    roomId: string
    playerId: string
    playerName: string
    role: RoomRole
    pingToken?: string
    pingAt?: number
    ackForPeerPingToken?: string
    ackAt?: number
  }) => Promise<void>
  appendAction: (input: {
    roomId: string
    actorId: string
    action: GameAction
    expectedGameId?: string
  }) => Promise<ActionRecord | null>
  fetchRoomSnapshot: (roomId: string) => Promise<RoomSnapshot>
  upsertGameState: (roomId: string, state: GameState) => Promise<void>
  subscribeRoomSnapshot: (
    roomId: string,
    handlers: { onUpdate: (snapshot: RoomSnapshot) => void; onError?: (error: Error) => void }
  ) => () => void
  fetchRoomDirectory: () => Promise<RoomDirectoryEntry[]>
  subscribeRoomDirectory: (
    handlers: { onUpdate: (rooms: RoomDirectoryEntry[]) => void; onError?: (error: Error) => void }
  ) => () => void
  cleanupExpiredRooms: () => Promise<number>
}

type TimerApi = {
  setInterval: typeof globalThis.setInterval
  clearInterval: typeof globalThis.clearInterval
}

type StoreOptions = {
  client?: FirebaseRestClient
  now?: () => number
  timers?: TimerApi
}

type FirebaseRecordMap = Record<string, unknown>

export function toFirebaseKey(value: string): string {
  return value.replace(/[.#$/\[\]]/g, '_')
}

function roomKey(roomId: string): string {
  return toFirebaseKey(roomId.trim().toLowerCase())
}

function isRecord(value: unknown): value is FirebaseRecordMap {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

function parseRole(value: unknown): RoomRole {
  return value === 'guest' ? 'guest' : 'host'
}

function parseStatus(value: unknown): RoomStatus {
  if (value === 'active' || value === 'ended') return value
  return 'waiting'
}

function createGameId(now: () => number): string {
  return `g-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function sortActions(records: ActionRecord[]): ActionRecord[] {
  return [...records].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
    return left.id.localeCompare(right.id)
  })
}

function parseActionRecords(mapValue: unknown, activeGameId: string | null): ActionRecord[] {
  if (!isRecord(mapValue)) return []
  const records: ActionRecord[] = []
  for (const value of Object.values(mapValue)) {
    if (!isRecord(value)) continue
    const id = asString(value.id)
    const gameId = asString(value.gameId)
    const actorId = asString(value.actorId)
    const createdAt = asNumber(value.createdAt)
    if (!id || !gameId || !actorId || createdAt === null) continue
    if (activeGameId && gameId !== activeGameId) continue
    const action = value.action
    if (!isRecord(action) || typeof action.type !== 'string' || typeof action.id !== 'string') continue
    records.push({
      id,
      gameId,
      actorId,
      createdAt,
      action: action as unknown as GameAction
    })
  }
  return dedupeActionRecords(sortActions(records))
}

function parseParticipants(mapValue: unknown): ParticipantPresence[] {
  if (!isRecord(mapValue)) return []
  const participants: ParticipantPresence[] = []
  for (const value of Object.values(mapValue)) {
    if (!isRecord(value)) continue
    const playerId = asString(value.playerId)
    const name = asString(value.name)
    const joinedAt = asNumber(value.joinedAt)
    const lastSeenAt = asNumber(value.lastSeenAt)
    if (!playerId || !name || joinedAt === null || lastSeenAt === null) continue
    participants.push({
      playerId,
      name,
      role: parseRole(value.role),
      joinedAt,
      lastSeenAt,
      pingToken: asString(value.pingToken) ?? undefined,
      pingAt: asNumber(value.pingAt) ?? undefined,
      ackForPeerPingToken: asString(value.ackForPeerPingToken) ?? undefined,
      ackAt: asNumber(value.ackAt) ?? undefined
    })
  }
  return participants.sort((left, right) => {
    if (left.role !== right.role) return left.role === 'host' ? -1 : 1
    if (left.joinedAt !== right.joinedAt) return left.joinedAt - right.joinedAt
    return left.playerId.localeCompare(right.playerId)
  })
}

function parseMeta(value: unknown): RoomMeta | null {
  if (!isRecord(value)) return null
  const roomId = asString(value.roomId)
  const hostId = asString(value.hostId)
  const currentGameId = asString(value.currentGameId)
  const createdAt = asNumber(value.createdAt)
  const updatedAt = asNumber(value.updatedAt)
  const expiresAt = asNumber(value.expiresAt)
  if (!roomId || !hostId || !currentGameId || createdAt === null || updatedAt === null || expiresAt === null) return null
  const expectedPlayersRaw = asNumber(value.expectedPlayers)
  const expectedPlayers = expectedPlayersRaw === null ? 2 : Math.max(2, Math.trunc(expectedPlayersRaw))
  return {
    roomId,
    hostId,
    expectedPlayers,
    currentGameId,
    createdAt,
    updatedAt,
    expiresAt,
    status: parseStatus(value.status)
  }
}

function parseGameState(value: unknown): GameState | null {
  if (!isRecord(value)) return null
  if (!Array.isArray(value.players)) return null
  if (!Array.isArray(value.actionLog)) return null
  if (!isRecord(value.lines)) return null
  if (!isRecord(value.pending)) return null
  if (!isRecord(value.commits)) return null
  if (!isRecord(value.reveals)) return null
  if (!Array.isArray(value.deck)) return null
  if (!Array.isArray(value.drawOrder)) return null
  if (value.phase !== 'lobby' && value.phase !== 'commit' && value.phase !== 'reveal' && value.phase !== 'initial' && value.phase !== 'play' && value.phase !== 'score') {
    return null
  }
  const drawIndex = asNumber(value.drawIndex)
  const dealerSeat = asNumber(value.dealerSeat)
  const turnSeat = asNumber(value.turnSeat)
  if (drawIndex === null || dealerSeat === null || turnSeat === null) return null
  if (value.turnStage !== 'draw' && value.turnStage !== 'place') return null
  return value as unknown as GameState
}

function parseDirectoryEntry(value: unknown): RoomDirectoryEntry | null {
  if (!isRecord(value)) return null
  const roomId = asString(value.roomId)
  const displayName = asString(value.displayName)
  const hostName = asString(value.hostName)
  const updatedAt = asNumber(value.updatedAt)
  const expiresAt = asNumber(value.expiresAt)
  if (!roomId || !displayName || !hostName || updatedAt === null || expiresAt === null) return null
  const expectedPlayersRaw = asNumber(value.expectedPlayers)
  const playerCountRaw = asNumber(value.playerCount)
  return {
    roomId,
    displayName,
    hostName,
    status: parseStatus(value.status),
    expectedPlayers: expectedPlayersRaw === null ? 2 : Math.max(2, Math.trunc(expectedPlayersRaw)),
    playerCount: playerCountRaw === null ? 0 : Math.max(0, Math.trunc(playerCountRaw)),
    updatedAt,
    expiresAt,
    discoverable: value.discoverable !== false
  }
}

export function filterActiveRoomDirectory(entries: RoomDirectoryEntry[], now: number): RoomDirectoryEntry[] {
  return [...entries]
    .filter((entry) => entry.discoverable && entry.expiresAt > now)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 20)
}

export function dedupeActionRecords(records: ActionRecord[]): ActionRecord[] {
  const seen = new Set<string>()
  const unique: ActionRecord[] = []
  for (const record of records) {
    if (seen.has(record.id)) continue
    seen.add(record.id)
    unique.push(record)
  }
  return unique
}

export function buildActionRecord(action: GameAction, actorId: string, createdAt: number, gameId: string): ActionRecord {
  return {
    id: action.id,
    gameId,
    action,
    actorId,
    createdAt
  }
}

export function buildPresenceUpdate(input: {
  playerId: string
  playerName: string
  role: RoomRole
  joinedAt: number
  lastSeenAt: number
  pingToken?: string
  pingAt?: number
  ackForPeerPingToken?: string
  ackAt?: number
}): ParticipantPresence {
  const presence: ParticipantPresence = {
    playerId: input.playerId,
    name: input.playerName.trim() || 'Player',
    role: input.role,
    joinedAt: input.joinedAt,
    lastSeenAt: input.lastSeenAt
  }
  if (input.pingToken) presence.pingToken = input.pingToken
  if (input.pingAt !== undefined) presence.pingAt = input.pingAt
  if (input.ackForPeerPingToken) presence.ackForPeerPingToken = input.ackForPeerPingToken
  if (input.ackAt !== undefined) presence.ackAt = input.ackAt
  return presence
}

export function createRoomStore(options?: StoreOptions): RoomStore {
  const client = options?.client ?? createFirebaseRestClient()
  const now = options?.now ?? (() => Date.now())
  const timers = options?.timers ?? {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis)
  }

  const withRoomPath = (roomId: string) => `/rooms/${roomKey(roomId)}`
  const withDirectoryPath = (roomId: string) => `/roomDirectory/${roomKey(roomId)}`

  const refreshDirectory = async (roomId: string): Promise<void> => {
    const snapshot = await fetchRoomSnapshot(roomId)
    const currentTime = now()
    if (!snapshot.meta) return
    const participants = snapshot.participants
    const hostParticipant =
      participants.find((participant) => participant.playerId === snapshot.meta?.hostId) ??
      participants.find((participant) => participant.role === 'host')
    const playerCount = participants.length
    const status: RoomStatus = playerCount >= snapshot.meta.expectedPlayers ? 'active' : 'waiting'
    const entry: RoomDirectoryEntry = {
      roomId: snapshot.meta.roomId,
      displayName: snapshot.meta.roomId,
      hostName: hostParticipant?.name ?? 'Host',
      status,
      playerCount,
      expectedPlayers: snapshot.meta.expectedPlayers,
      updatedAt: currentTime,
      expiresAt: currentTime + ROOM_TTL_MS,
      discoverable: true
    }
    await client.requestJson(withDirectoryPath(roomId), { method: 'PUT', body: entry })
    await client.requestJson(`${withRoomPath(roomId)}/meta`, {
      method: 'PATCH',
      body: { status, updatedAt: currentTime, expiresAt: currentTime + ROOM_TTL_MS }
    })
  }

  const fetchRoomSnapshot = async (roomId: string): Promise<RoomSnapshot> => {
    const roomNode = await client.requestJson<unknown>(withRoomPath(roomId))
    if (!isRecord(roomNode)) {
      return { roomId: roomKey(roomId), meta: null, participants: [], actions: [], gameState: null }
    }
    const rawMeta = roomNode.meta
    let meta = parseMeta(rawMeta)
    if (!meta && isRecord(rawMeta)) {
      const roomIdValue = asString(rawMeta.roomId) ?? roomKey(roomId)
      const hostId = asString(rawMeta.hostId)
      const createdAt = asNumber(rawMeta.createdAt)
      const updatedAt = asNumber(rawMeta.updatedAt)
      const expiresAt = asNumber(rawMeta.expiresAt)
      if (hostId && createdAt !== null && updatedAt !== null && expiresAt !== null) {
        const migratedGameId = createGameId(now)
        const migratedMeta: RoomMeta = {
          roomId: roomIdValue,
          hostId,
          expectedPlayers: Math.max(2, Math.trunc(asNumber(rawMeta.expectedPlayers) ?? 2)),
          currentGameId: migratedGameId,
          createdAt,
          updatedAt,
          expiresAt,
          status: parseStatus(rawMeta.status)
        }
        meta = migratedMeta
        await client.requestJson(`${withRoomPath(roomId)}/meta`, { method: 'PATCH', body: { currentGameId: migratedGameId } })
      }
    }
    return {
      roomId: roomKey(roomId),
      meta,
      participants: parseParticipants(roomNode.participants),
      actions: parseActionRecords(roomNode.actions, meta?.currentGameId ?? null),
      gameState: parseGameState(roomNode.gameState)
    }
  }

  const createRoom = async (input: {
    roomId: string
    displayName: string
    hostId: string
    hostName: string
    expectedPlayers?: number
  }): Promise<RoomSnapshot> => {
    const normalizedRoom = roomKey(input.roomId)
    const currentTime = now()
    const expectedPlayers = Math.max(2, Math.trunc(input.expectedPlayers ?? 2))
    const hostPresence = buildPresenceUpdate({
      playerId: input.hostId,
      playerName: input.hostName,
      role: 'host',
      joinedAt: currentTime,
      lastSeenAt: currentTime
    })
    const meta: RoomMeta = {
      roomId: normalizedRoom,
      hostId: input.hostId,
      expectedPlayers,
      currentGameId: createGameId(now),
      createdAt: currentTime,
      updatedAt: currentTime,
      expiresAt: currentTime + ROOM_TTL_MS,
      status: 'waiting'
    }
    const waitingPlayer: Player = {
      id: WAITING_OPPONENT_ID,
      name: 'Opponent',
      seat: 1,
      connected: false,
      ready: false
    }
    const hostPlayer: Player = {
      id: input.hostId,
      name: hostPresence.name,
      seat: 0,
      connected: true,
      ready: false
    }
    const gameState = initialGameState([hostPlayer, waitingPlayer])
    const roomPayload = {
      meta,
      participants: {
        [toFirebaseKey(input.hostId)]: hostPresence
      },
      actions: {},
      gameState
    }
    await client.requestJson(withRoomPath(normalizedRoom), { method: 'PUT', body: roomPayload })
    const directoryEntry: RoomDirectoryEntry = {
      roomId: normalizedRoom,
      displayName: input.displayName.trim() || normalizedRoom,
      hostName: hostPresence.name,
      status: 'waiting',
      playerCount: 1,
      expectedPlayers,
      updatedAt: currentTime,
      expiresAt: currentTime + ROOM_TTL_MS,
      discoverable: true
    }
    await client.requestJson(withDirectoryPath(normalizedRoom), { method: 'PUT', body: directoryEntry })
    return fetchRoomSnapshot(normalizedRoom)
  }

  const joinRoom = async (input: {
    roomId: string
    playerId: string
    playerName: string
    role: RoomRole
  }): Promise<RoomSnapshot> => {
    const normalizedRoom = roomKey(input.roomId)
    const snapshot = await fetchRoomSnapshot(normalizedRoom)
    if (!snapshot.meta) {
      // First connector bootstraps the room when metadata is missing.
      return createRoom({
        roomId: normalizedRoom,
        displayName: normalizedRoom,
        hostId: input.playerId,
        hostName: input.playerName,
        expectedPlayers: 2
      })
    }
    const existing = snapshot.participants.find((participant) => participant.playerId === input.playerId)
    if (!existing && snapshot.participants.length >= snapshot.meta.expectedPlayers) {
      throw new Error(`Room "${normalizedRoom}" is full.`)
    }
    const currentTime = now()
    const presence = buildPresenceUpdate({
      playerId: input.playerId,
      playerName: input.playerName,
      role: input.role,
      joinedAt: existing?.joinedAt ?? currentTime,
      lastSeenAt: currentTime
    })
    await client.requestJson(`${withRoomPath(normalizedRoom)}/participants/${toFirebaseKey(input.playerId)}`, {
      method: 'PUT',
      body: presence
    })
    await refreshDirectory(normalizedRoom)
    return fetchRoomSnapshot(normalizedRoom)
  }

  const restartGameSession = async (input: {
    roomId: string
    hostId: string
    hostName: string
    expectedPlayers?: number
  }): Promise<RoomSnapshot> => {
    const normalizedRoom = roomKey(input.roomId)
    const snapshot = await fetchRoomSnapshot(normalizedRoom)
    if (!snapshot.meta) {
      return createRoom({
        roomId: normalizedRoom,
        displayName: normalizedRoom,
        hostId: input.hostId,
        hostName: input.hostName,
        expectedPlayers: input.expectedPlayers
      })
    }
    const currentTime = now()
    const expectedPlayers = Math.max(2, Math.trunc(input.expectedPlayers ?? snapshot.meta.expectedPlayers ?? 2))
    const hostPresence = buildPresenceUpdate({
      playerId: input.hostId,
      playerName: input.hostName,
      role: 'host',
      joinedAt: currentTime,
      lastSeenAt: currentTime
    })
    const hostPlayer: Player = {
      id: input.hostId,
      name: hostPresence.name,
      seat: 0,
      connected: true,
      ready: false
    }
    const waitingPlayer: Player = {
      id: WAITING_OPPONENT_ID,
      name: 'Opponent',
      seat: 1,
      connected: false,
      ready: false
    }
    const gameState = initialGameState([hostPlayer, waitingPlayer])
    const currentGameId = createGameId(now)
    await client.requestJson(withRoomPath(normalizedRoom), {
      method: 'PATCH',
      body: {
        meta: {
          ...snapshot.meta,
          hostId: input.hostId,
          expectedPlayers,
          currentGameId,
          status: 'waiting',
          updatedAt: currentTime,
          expiresAt: currentTime + ROOM_TTL_MS
        },
        participants: {
          [toFirebaseKey(input.hostId)]: hostPresence
        },
        actions: {},
        gameState
      }
    })
    await client.requestJson(withDirectoryPath(normalizedRoom), {
      method: 'PUT',
      body: {
        roomId: normalizedRoom,
        displayName: normalizedRoom,
        hostName: hostPresence.name,
        status: 'waiting',
        playerCount: 1,
        expectedPlayers,
        updatedAt: currentTime,
        expiresAt: currentTime + ROOM_TTL_MS,
        discoverable: true
      } satisfies RoomDirectoryEntry
    })
    return fetchRoomSnapshot(normalizedRoom)
  }

  const resetRoundSession = async (input: { roomId: string; expectedGameId?: string }): Promise<RoomSnapshot> => {
    const normalizedRoom = roomKey(input.roomId)
    const snapshot = await fetchRoomSnapshot(normalizedRoom)
    if (!snapshot.meta) {
      throw new Error(`Room "${normalizedRoom}" does not exist.`)
    }
    if (input.expectedGameId && snapshot.meta.currentGameId !== input.expectedGameId) {
      // Another client already restarted this session; return fresh snapshot without mutating.
      return snapshot
    }

    const currentTime = now()
    const currentGameId = createGameId(now)
    const expectedPlayers = Math.max(2, Math.trunc(snapshot.meta.expectedPlayers ?? 2))
    const participantsByRole = [...snapshot.participants].sort((left, right) => {
      if (left.role !== right.role) return left.role === 'host' ? -1 : 1
      if (left.joinedAt !== right.joinedAt) return left.joinedAt - right.joinedAt
      return left.playerId.localeCompare(right.playerId)
    })
    const hostPresence =
      participantsByRole.find((participant) => participant.playerId === snapshot.meta?.hostId) ??
      participantsByRole.find((participant) => participant.role === 'host')
    const guestPresence = participantsByRole.find(
      (participant) => participant.playerId !== hostPresence?.playerId && participant.role === 'guest'
    )

    const hostPlayer: Player = {
      id: hostPresence?.playerId ?? snapshot.meta.hostId,
      name: hostPresence?.name ?? 'Host',
      seat: 0,
      connected: true,
      ready: false
    }
    const guestPlayer: Player = guestPresence
      ? {
          id: guestPresence.playerId,
          name: guestPresence.name,
          seat: 1,
          connected: true,
          ready: false
        }
      : {
          id: WAITING_OPPONENT_ID,
          name: 'Opponent',
          seat: 1,
          connected: false,
          ready: false
        }

    const freshGameState = initialGameState([hostPlayer, guestPlayer])
    const playerCount = Math.max(2, freshGameState.players.length)
    const previousDealerSeatRaw = snapshot.gameState?.dealerSeat ?? 0
    const previousDealerSeat = ((previousDealerSeatRaw % playerCount) + playerCount) % playerCount
    const nextDealerSeat = ((previousDealerSeat + 1) % playerCount) as Player['seat']
    freshGameState.dealerSeat = nextDealerSeat
    freshGameState.turnSeat = ((nextDealerSeat + 1) % playerCount) as Player['seat']

    await client.requestJson(`${withRoomPath(normalizedRoom)}/meta`, {
      method: 'PATCH',
      body: {
        hostId: hostPlayer.id,
        expectedPlayers,
        currentGameId,
        status: 'waiting',
        updatedAt: currentTime,
        expiresAt: currentTime + ROOM_TTL_MS
      } satisfies Partial<RoomMeta>
    })
    await client.requestJson(`${withRoomPath(normalizedRoom)}/actions`, { method: 'PUT', body: {} })
    await client.requestJson(`${withRoomPath(normalizedRoom)}/gameState`, {
      method: 'PUT',
      body: freshGameState
    })
    await refreshDirectory(normalizedRoom)
    return fetchRoomSnapshot(normalizedRoom)
  }

  const leaveRoom = async (roomId: string, playerId: string): Promise<void> => {
    const normalizedRoom = roomKey(roomId)
    await client.requestJson(`${withRoomPath(normalizedRoom)}/participants/${toFirebaseKey(playerId)}`, {
      method: 'DELETE'
    })
    const snapshot = await fetchRoomSnapshot(normalizedRoom)
    if (!snapshot.meta) return
    if (snapshot.participants.length === 0) {
      await client.requestJson(withRoomPath(normalizedRoom), { method: 'DELETE' })
      await client.requestJson(withDirectoryPath(normalizedRoom), { method: 'DELETE' })
      return
    }
    await refreshDirectory(normalizedRoom)
  }

  const touchPresence = async (input: {
    roomId: string
    playerId: string
    playerName: string
    role: RoomRole
    pingToken?: string
    pingAt?: number
    ackForPeerPingToken?: string
    ackAt?: number
  }): Promise<void> => {
    const normalizedRoom = roomKey(input.roomId)
    const snapshot = await fetchRoomSnapshot(normalizedRoom)
    if (!snapshot.meta) return
    const existing = snapshot.participants.find((participant) => participant.playerId === input.playerId)
    const currentTime = now()
    const presence = buildPresenceUpdate({
      playerId: input.playerId,
      playerName: input.playerName,
      role: input.role,
      joinedAt: existing?.joinedAt ?? currentTime,
      lastSeenAt: currentTime,
      pingToken: input.pingToken,
      pingAt: input.pingAt,
      ackForPeerPingToken: input.ackForPeerPingToken,
      ackAt: input.ackAt
    })
    await client.requestJson(`${withRoomPath(normalizedRoom)}/participants/${toFirebaseKey(input.playerId)}`, {
      method: 'PATCH',
      body: presence
    })
    await refreshDirectory(normalizedRoom)
  }

  const upsertGameState = async (roomId: string, state: GameState): Promise<void> => {
    const normalizedRoom = roomKey(roomId)
    await client.requestJson(`${withRoomPath(normalizedRoom)}/gameState`, {
      method: 'PUT',
      body: state
    })
  }

  const appendAction = async (input: {
    roomId: string
    actorId: string
    action: GameAction
    expectedGameId?: string
  }): Promise<ActionRecord | null> => {
    const normalizedRoom = roomKey(input.roomId)
    const snapshot = await fetchRoomSnapshot(normalizedRoom)
    if (!snapshot.meta) {
      throw new Error(`Room "${normalizedRoom}" does not exist.`)
    }
    if (input.expectedGameId && snapshot.meta.currentGameId !== input.expectedGameId) {
      // Stale action for a prior round/session; ignore.
      return null
    }
    const gameId = snapshot.meta.currentGameId
    const actionId = toFirebaseKey(input.action.id)
    const actionKey = toFirebaseKey(`${gameId}__${actionId}`)
    const existing = await client.requestJson<unknown>(
      `${withRoomPath(normalizedRoom)}/actions/${encodeURIComponent(actionKey)}`
    )
    if (existing !== null) return null

    const record = buildActionRecord(input.action, input.actorId, now(), gameId)
    await client.requestJson(`${withRoomPath(normalizedRoom)}/actions/${encodeURIComponent(actionKey)}`, {
      method: 'PUT',
      body: record
    })
    await refreshDirectory(normalizedRoom)
    return record
  }

  const fetchRoomDirectory = async (): Promise<RoomDirectoryEntry[]> => {
    const directoryNode = await client.requestJson<unknown>('/roomDirectory')
    if (!isRecord(directoryNode)) return []
    const rooms: RoomDirectoryEntry[] = []
    for (const value of Object.values(directoryNode)) {
      const parsed = parseDirectoryEntry(value)
      if (parsed) rooms.push(parsed)
    }
    return filterActiveRoomDirectory(rooms, now())
  }

  const cleanupExpiredRooms = async (): Promise<number> => {
    const directoryNode = await client.requestJson<unknown>('/roomDirectory')
    if (!isRecord(directoryNode)) return 0
    const expiredRoomIds: string[] = []
    const currentTime = now()
    for (const [rawId, value] of Object.entries(directoryNode)) {
      const parsed = parseDirectoryEntry(value)
      if (!parsed) continue
      if (parsed.expiresAt <= currentTime) {
        expiredRoomIds.push(rawId)
      }
    }
    for (const rawId of expiredRoomIds) {
      await client.requestJson(`/roomDirectory/${rawId}`, { method: 'DELETE' })
      await client.requestJson(`/rooms/${rawId}`, { method: 'DELETE' })
    }
    return expiredRoomIds.length
  }

  const subscribeRoomSnapshot = (
    roomId: string,
    handlers: { onUpdate: (snapshot: RoomSnapshot) => void; onError?: (error: Error) => void }
  ): (() => void) => {
    let active = true
    const run = async () => {
      if (!active) return
      try {
        const snapshot = await fetchRoomSnapshot(roomId)
        if (!active) return
        handlers.onUpdate(snapshot)
      } catch (error) {
        if (!active) return
        const normalized = error instanceof Error ? error : new Error('Failed to fetch room snapshot')
        handlers.onError?.(normalized)
      }
    }
    void run()
    const timerId = timers.setInterval(() => {
      void run()
    }, ROOM_POLL_MS)
    return () => {
      active = false
      timers.clearInterval(timerId)
    }
  }

  const subscribeRoomDirectory = (
    handlers: { onUpdate: (rooms: RoomDirectoryEntry[]) => void; onError?: (error: Error) => void }
  ): (() => void) => {
    let active = true
    const run = async () => {
      if (!active) return
      try {
        const rooms = await fetchRoomDirectory()
        if (!active) return
        handlers.onUpdate(rooms)
      } catch (error) {
        if (!active) return
        const normalized = error instanceof Error ? error : new Error('Failed to fetch room directory')
        handlers.onError?.(normalized)
      }
    }
    const runCleanup = async () => {
      if (!active) return
      try {
        await cleanupExpiredRooms()
      } catch {
        // Best-effort cleanup in v1.
      }
    }
    void runCleanup()
    void run()
    const pollTimer = timers.setInterval(() => {
      void run()
    }, DIRECTORY_POLL_MS)
    const cleanupTimer = timers.setInterval(() => {
      void runCleanup()
    }, DIRECTORY_CLEANUP_MS)
    return () => {
      active = false
      timers.clearInterval(pollTimer)
      timers.clearInterval(cleanupTimer)
    }
  }

  return {
    isConfigured: client.isConfigured,
    createRoom,
    joinRoom,
    restartGameSession,
    resetRoundSession,
    leaveRoom,
    touchPresence,
    appendAction,
    fetchRoomSnapshot,
    upsertGameState,
    subscribeRoomSnapshot,
    fetchRoomDirectory,
    subscribeRoomDirectory,
    cleanupExpiredRooms
  }
}
