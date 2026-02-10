import type { GameAction } from '../state/gameState'
import { GameState, Player, initialGameState } from '../state/gameState'
import { createFirebaseRestClient, FirebaseRestClient } from './firebaseClient'
import { createFirebaseSdkClient } from './firebaseSdkClient'
import { WAITING_OPPONENT_ID } from './constants'

const ROOM_TTL_MS = 5 * 60 * 1000
const ROOM_POLL_MS = 2000
const DIRECTORY_POLL_MS = 3000
const DIRECTORY_CLEANUP_MS = 60 * 1000
const PRESENCE_LIVENESS_REFRESH_MS = 60 * 1000
const SNAPSHOT_GAME_STATE_REFRESH_POLLS = 15
const SNAPSHOT_PARTICIPANTS_REFRESH_POLLS = 5
const SNAPSHOT_ACTIONS_REFRESH_POLLS = 5

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
  actionsVersion: number
  dealerSeat: number
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
  gameStateIncluded: boolean
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
    role?: RoomRole
    includeSnapshot?: boolean
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
    joinedAt?: number
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
  fetchRoomSnapshot: (
    roomId: string,
    options?: { includeParticipants?: boolean; includeActions?: boolean; includeGameState?: boolean }
  ) => Promise<RoomSnapshot>
  fetchRoomMeta: (roomId: string) => Promise<RoomMeta | null>
  fetchRoomActions: (roomId: string, options?: { gameId?: string | null }) => Promise<ActionRecord[]>
  upsertGameState: (roomId: string, state: GameState, expectedGameId?: string) => Promise<boolean>
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

function toStoredActionKey(gameId: string, actionId: string): string {
  return toFirebaseKey(`${gameId}__${toFirebaseKey(actionId)}`)
}

function isRecord(value: unknown): value is FirebaseRecordMap {
  return typeof value === 'object' && value !== null
}

function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) return error
  return new Error(fallbackMessage)
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
  const actionsVersionRaw = asNumber(value.actionsVersion)
  const dealerSeatRaw = asNumber(value.dealerSeat)
  const createdAt = asNumber(value.createdAt)
  const updatedAt = asNumber(value.updatedAt)
  const expiresAt = asNumber(value.expiresAt)
  if (!roomId || !hostId || !currentGameId || createdAt === null || updatedAt === null || expiresAt === null) return null
  const expectedPlayersRaw = asNumber(value.expectedPlayers)
  const expectedPlayers = expectedPlayersRaw === null ? 2 : Math.max(2, Math.trunc(expectedPlayersRaw))
  const dealerSeat = dealerSeatRaw === null ? 0 : Math.max(0, Math.trunc(dealerSeatRaw))
  return {
    roomId,
    hostId,
    expectedPlayers,
    currentGameId,
    actionsVersion: actionsVersionRaw === null ? 0 : Math.max(0, Math.trunc(actionsVersionRaw)),
    dealerSeat,
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
    .filter((entry) => entry.playerCount < entry.expectedPlayers)
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

function createDefaultFirebaseClient(): FirebaseRestClient {
  try {
    return createFirebaseSdkClient()
  } catch (error) {
    console.warn('[firebase] sdk client init failed, falling back to REST polling', error)
    return createFirebaseRestClient()
  }
}

export function createRoomStore(options?: StoreOptions): RoomStore {
  const client = options?.client ?? createDefaultFirebaseClient()
  const now = options?.now ?? (() => Date.now())
  const timers = options?.timers ?? {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis)
  }

  const withRoomPath = (roomId: string) => `/rooms/${roomKey(roomId)}`
  const withDirectoryPath = (roomId: string) => `/roomDirectory/${roomKey(roomId)}`
  const lastLivenessRefreshByRoom = new Map<string, number>()
  const metaCacheByRoom = new Map<string, RoomMeta>()
  const appendQueueByRoom = new Map<string, Promise<void>>()

  const runAppendSerialized = <T>(roomId: string, run: () => Promise<T>): Promise<T> => {
    const previous = appendQueueByRoom.get(roomId) ?? Promise.resolve()
    const result = previous.then(() => run())
    const settled = result.then(
      () => undefined,
      () => undefined
    )
    appendQueueByRoom.set(roomId, settled)
    return result.finally(() => {
      if (appendQueueByRoom.get(roomId) === settled) {
        appendQueueByRoom.delete(roomId)
      }
    })
  }

  const parseAndMaybeMigrateMeta = async (roomId: string, rawMeta: unknown): Promise<RoomMeta | null> => {
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
          actionsVersion: Math.max(0, Math.trunc(asNumber(rawMeta.actionsVersion) ?? 0)),
          dealerSeat: Math.max(0, Math.trunc(asNumber(rawMeta.dealerSeat) ?? 0)),
          createdAt,
          updatedAt,
          expiresAt,
          status: parseStatus(rawMeta.status)
        }
        meta = migratedMeta
        await client.requestJson(`${withRoomPath(roomId)}/meta`, {
          method: 'PATCH',
          body: { currentGameId: migratedGameId, actionsVersion: migratedMeta.actionsVersion }
        })
      }
    }
    return meta
  }

  const fetchMeta = async (roomId: string): Promise<RoomMeta | null> => {
    const rawMeta = await client.requestJson<unknown>(`${withRoomPath(roomId)}/meta`)
    const meta = await parseAndMaybeMigrateMeta(roomId, rawMeta)
    if (meta) {
      metaCacheByRoom.set(roomId, meta)
    } else {
      metaCacheByRoom.delete(roomId)
    }
    return meta
  }

  const fetchParticipants = async (roomId: string): Promise<ParticipantPresence[]> => {
    const rawParticipants = await client.requestJson<unknown>(`${withRoomPath(roomId)}/participants`)
    return parseParticipants(rawParticipants)
  }

  const fetchActions = async (roomId: string, activeGameId: string | null): Promise<ActionRecord[]> => {
    const rawActions = await client.requestJson<unknown>(`${withRoomPath(roomId)}/actions`)
    return parseActionRecords(rawActions, activeGameId)
  }

  const fetchPersistedGameState = async (roomId: string): Promise<GameState | null> => {
    const rawGameState = await client.requestJson<unknown>(`${withRoomPath(roomId)}/gameState`)
    return parseGameState(rawGameState)
  }

  const refreshDirectory = async (roomId: string): Promise<void> => {
    const snapshot = await fetchRoomSnapshot(roomId, {
      includeParticipants: true,
      includeActions: false,
      includeGameState: false
    })
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

  const fetchRoomSnapshot = async (
    roomId: string,
    options?: { includeParticipants?: boolean; includeActions?: boolean; includeGameState?: boolean }
  ): Promise<RoomSnapshot> => {
    const includeParticipants = options?.includeParticipants ?? true
    const includeActions = options?.includeActions ?? true
    const includeGameState = options?.includeGameState ?? true
    const meta = await fetchMeta(roomId)
    const participants = includeParticipants ? await fetchParticipants(roomId) : []
    const actions = includeActions ? await fetchActions(roomId, meta?.currentGameId ?? null) : []
    const gameState = includeGameState ? await fetchPersistedGameState(roomId) : null

    return {
      roomId: roomKey(roomId),
      meta,
      participants,
      actions,
      gameState,
      gameStateIncluded: includeGameState
    }
  }

  const fetchRoomMeta = async (roomId: string): Promise<RoomMeta | null> => {
    return fetchMeta(roomKey(roomId))
  }

  const fetchRoomActions = async (roomId: string, options?: { gameId?: string | null }): Promise<ActionRecord[]> => {
    const normalizedRoom = roomKey(roomId)
    const activeGameId =
      options?.gameId === undefined ? (await fetchMeta(normalizedRoom))?.currentGameId ?? null : options.gameId
    return fetchActions(normalizedRoom, activeGameId)
  }

  const maybeRefreshLiveness = async (roomId: string, currentTime: number): Promise<void> => {
    const lastRefresh = lastLivenessRefreshByRoom.get(roomId) ?? 0
    if (currentTime - lastRefresh < PRESENCE_LIVENESS_REFRESH_MS) return
    lastLivenessRefreshByRoom.set(roomId, currentTime)
    const expiresAt = currentTime + ROOM_TTL_MS
    await client.requestJson(`${withRoomPath(roomId)}/meta`, {
      method: 'PATCH',
      body: {
        updatedAt: currentTime,
        expiresAt
      } satisfies Partial<RoomMeta>
    })
    await client.requestJson(withDirectoryPath(roomId), {
      method: 'PATCH',
      body: {
        updatedAt: currentTime,
        expiresAt
      } satisfies Partial<RoomDirectoryEntry>
    })
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
      actionsVersion: 0,
      dealerSeat: 0,
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
    metaCacheByRoom.set(normalizedRoom, meta)
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
    role?: RoomRole
    includeSnapshot?: boolean
  }): Promise<RoomSnapshot> => {
    const normalizedRoom = roomKey(input.roomId)
    const includeSnapshot = input.includeSnapshot ?? true
    const snapshot = await fetchRoomSnapshot(normalizedRoom, {
      includeParticipants: true,
      includeActions: false,
      includeGameState: false
    })
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
    const role: RoomRole =
      existing?.role ??
      input.role ??
      (snapshot.participants.some((participant) => participant.role === 'host') ? 'guest' : 'host')
    const currentTime = now()
    const presence = buildPresenceUpdate({
      playerId: input.playerId,
      playerName: input.playerName,
      role,
      joinedAt: existing?.joinedAt ?? currentTime,
      lastSeenAt: currentTime
    })
    await client.requestJson(`${withRoomPath(normalizedRoom)}/participants/${toFirebaseKey(input.playerId)}`, {
      method: 'PUT',
      body: presence
    })
    await refreshDirectory(normalizedRoom)
    if (includeSnapshot) return fetchRoomSnapshot(normalizedRoom)
    const participants = [...snapshot.participants.filter((participant) => participant.playerId !== input.playerId), presence]
    return {
      roomId: normalizedRoom,
      meta: snapshot.meta,
      participants,
      actions: [],
      gameState: null,
      gameStateIncluded: false
    }
  }

  const restartGameSession = async (input: {
    roomId: string
    hostId: string
    hostName: string
    expectedPlayers?: number
  }): Promise<RoomSnapshot> => {
    const normalizedRoom = roomKey(input.roomId)
    const snapshot = await fetchRoomSnapshot(normalizedRoom, {
      includeParticipants: false,
      includeActions: false,
      includeGameState: false
    })
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
          actionsVersion: 0,
          dealerSeat: 0,
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
    metaCacheByRoom.set(normalizedRoom, {
      ...snapshot.meta,
      hostId: input.hostId,
      expectedPlayers,
      currentGameId,
      actionsVersion: 0,
      dealerSeat: 0,
      status: 'waiting',
      updatedAt: currentTime,
      expiresAt: currentTime + ROOM_TTL_MS
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
    const snapshot = await fetchRoomSnapshot(normalizedRoom, {
      includeParticipants: true,
      includeActions: false,
      includeGameState: true
    })
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
    const previousDealerSeatRaw = snapshot.meta?.dealerSeat ?? snapshot.gameState?.dealerSeat ?? 0
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
        actionsVersion: 0,
        dealerSeat: nextDealerSeat,
        status: 'waiting',
        updatedAt: currentTime,
        expiresAt: currentTime + ROOM_TTL_MS
      } satisfies Partial<RoomMeta>
    })
    metaCacheByRoom.set(normalizedRoom, {
      ...snapshot.meta,
      hostId: hostPlayer.id,
      expectedPlayers,
      currentGameId,
      actionsVersion: 0,
      dealerSeat: nextDealerSeat,
      status: 'waiting',
      updatedAt: currentTime,
      expiresAt: currentTime + ROOM_TTL_MS
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
    const snapshot = await fetchRoomSnapshot(normalizedRoom, {
      includeParticipants: true,
      includeActions: false,
      includeGameState: false
    })
    if (!snapshot.meta) return
    if (snapshot.participants.length === 0) {
      await client.requestJson(withRoomPath(normalizedRoom), { method: 'DELETE' })
      await client.requestJson(withDirectoryPath(normalizedRoom), { method: 'DELETE' })
      metaCacheByRoom.delete(normalizedRoom)
      return
    }
    await refreshDirectory(normalizedRoom)
  }

  const touchPresence = async (input: {
    roomId: string
    playerId: string
    playerName: string
    role: RoomRole
    joinedAt?: number
    pingToken?: string
    pingAt?: number
    ackForPeerPingToken?: string
    ackAt?: number
  }): Promise<void> => {
    const normalizedRoom = roomKey(input.roomId)
    const meta = await fetchMeta(normalizedRoom)
    if (!meta) return
    const currentTime = now()
    const presence = buildPresenceUpdate({
      playerId: input.playerId,
      playerName: input.playerName,
      role: input.role,
      joinedAt: input.joinedAt ?? currentTime,
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
    await maybeRefreshLiveness(normalizedRoom, currentTime)
  }

  const upsertGameState = async (roomId: string, state: GameState, expectedGameId?: string): Promise<boolean> => {
    const normalizedRoom = roomKey(roomId)
    if (expectedGameId) {
      const cachedMeta = metaCacheByRoom.get(normalizedRoom)
      const meta =
        cachedMeta && cachedMeta.currentGameId === expectedGameId ? cachedMeta : await fetchMeta(normalizedRoom)
      if (!meta) return false
      if (meta.currentGameId !== expectedGameId) return false
    }
    await client.requestJson(`${withRoomPath(normalizedRoom)}/gameState`, {
      method: 'PUT',
      body: state
    })
    await client.requestJson(`${withRoomPath(normalizedRoom)}/meta`, {
      method: 'PATCH',
      body: {
        dealerSeat: state.dealerSeat
      } satisfies Partial<RoomMeta>
    })
    return true
  }

  const appendAction = async (input: {
    roomId: string
    actorId: string
    action: GameAction
    expectedGameId?: string
  }): Promise<ActionRecord | null> => {
    const normalizedRoom = roomKey(input.roomId)
    return runAppendSerialized(normalizedRoom, async () => {
      const cachedMeta = metaCacheByRoom.get(normalizedRoom)
      const needsRefresh = !cachedMeta || (input.expectedGameId && cachedMeta.currentGameId !== input.expectedGameId)
      const meta = needsRefresh ? await fetchMeta(normalizedRoom) : cachedMeta
      if (!meta) {
        throw new Error(`Room "${normalizedRoom}" does not exist.`)
      }
      if (input.expectedGameId && meta.currentGameId !== input.expectedGameId) {
        // Stale action for a prior round/session; ignore.
        return null
      }
      const gameId = meta.currentGameId
      const actionKey = toStoredActionKey(gameId, input.action.id)
      const existing = await client.requestJson<unknown>(
        `${withRoomPath(normalizedRoom)}/actions/${encodeURIComponent(actionKey)}`
      )
      if (existing !== null) return null

      const record = buildActionRecord(input.action, input.actorId, now(), gameId)
      const nextActionsVersion = (meta.actionsVersion ?? 0) + 1
      await client.requestJson(withRoomPath(normalizedRoom), {
        method: 'PATCH',
        body: {
          [`actions/${actionKey}`]: record,
          'meta/actionsVersion': nextActionsVersion
        } satisfies Record<string, unknown>
      })
      metaCacheByRoom.set(normalizedRoom, { ...meta, actionsVersion: nextActionsVersion })
      return record
    })
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
      metaCacheByRoom.delete(rawId)
    }
    return expiredRoomIds.length
  }

  const subscribeRoomSnapshotPolling = (
    roomId: string,
    handlers: { onUpdate: (snapshot: RoomSnapshot) => void; onError?: (error: Error) => void }
  ): (() => void) => {
    let active = true
    let inFlight = false
    let rerunRequested = false
    let pollCount = 0
    let cachedParticipants: ParticipantPresence[] = []
    let cachedActions: ActionRecord[] = []
    let cachedGameState: GameState | null = null
    let cachedGameId: string | null = null
    let cachedActionsVersion = -1

    const run = async () => {
      if (!active) return
      if (inFlight) {
        rerunRequested = true
        return
      }
      inFlight = true
      try {
        do {
          rerunRequested = false
          try {
            const includeGameState = pollCount === 0 || pollCount % SNAPSHOT_GAME_STATE_REFRESH_POLLS === 0
            const includeParticipants = pollCount === 0 || pollCount % SNAPSHOT_PARTICIPANTS_REFRESH_POLLS === 0
            const includeActionsRefresh = pollCount === 0 || pollCount % SNAPSHOT_ACTIONS_REFRESH_POLLS === 0
            pollCount += 1
            const meta = await fetchMeta(roomId)
            if (!meta) {
              cachedParticipants = []
              cachedActions = []
              cachedGameState = null
              cachedGameId = null
              cachedActionsVersion = -1
              const snapshot: RoomSnapshot = {
                roomId: roomKey(roomId),
                meta: null,
                participants: [],
                actions: [],
                gameState: null,
                gameStateIncluded: includeGameState
              }
              if (!active) return
              handlers.onUpdate(snapshot)
              continue
            }

            if (includeParticipants || cachedParticipants.length === 0) {
              cachedParticipants = await fetchParticipants(roomId)
            }

            const shouldFetchActions =
              includeActionsRefresh ||
              cachedActions.length === 0 ||
              cachedGameId !== meta.currentGameId ||
              cachedActionsVersion !== meta.actionsVersion
            if (shouldFetchActions) {
              cachedActions = await fetchActions(roomId, meta.currentGameId)
              cachedGameId = meta.currentGameId
              cachedActionsVersion = meta.actionsVersion
            }

            if (includeGameState) {
              cachedGameState = await fetchPersistedGameState(roomId)
            }

            const snapshot: RoomSnapshot = {
              roomId: roomKey(roomId),
              meta,
              participants: cachedParticipants,
              actions: cachedActions,
              gameState: includeGameState ? cachedGameState : null,
              gameStateIncluded: includeGameState
            }
            if (!active) return
            handlers.onUpdate(snapshot)
          } catch (error) {
            if (!active) return
            handlers.onError?.(toError(error, 'Failed to fetch room snapshot'))
          }
        } while (active && rerunRequested)
      } finally {
        inFlight = false
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

  const subscribeRoomSnapshotRealtime = (
    roomId: string,
    handlers: { onUpdate: (snapshot: RoomSnapshot) => void; onError?: (error: Error) => void }
  ): (() => void) => {
    let active = true
    let fallbackTriggered = false
    let fallbackUnsubscribe: (() => void) | null = null
    const realtimeUnsubscribers: Array<() => void> = []
    let cachedMeta: RoomMeta | null = null
    let cachedParticipants: ParticipantPresence[] = []
    let cachedGameState: GameState | null = null
    let currentGameId: string | null = null
    const actionsByKey = new Map<string, ActionRecord>()

    const emitSnapshot = (includeGameState: boolean) => {
      if (!active || fallbackTriggered) return
      handlers.onUpdate({
        roomId: roomKey(roomId),
        meta: cachedMeta,
        participants: cachedParticipants,
        actions: dedupeActionRecords(sortActions([...actionsByKey.values()])),
        gameState: includeGameState ? cachedGameState : null,
        gameStateIncluded: includeGameState
      })
    }

    const triggerFallback = (error: unknown) => {
      if (!active || fallbackTriggered) return
      fallbackTriggered = true
      const normalized = toError(error, 'Realtime room snapshot subscription failed; falling back to polling.')
      console.warn('[firebase] room snapshot realtime failed; using polling fallback', normalized)
      handlers.onError?.(normalized)
      realtimeUnsubscribers.forEach((unsubscribe) => unsubscribe())
      realtimeUnsubscribers.length = 0
      fallbackUnsubscribe = subscribeRoomSnapshotPolling(roomId, handlers)
    }

    const applyActionValue = (actionKey: string, value: unknown) => {
      if (!currentGameId) {
        actionsByKey.delete(actionKey)
        return
      }
      const parsed = parseActionRecords({ [actionKey]: value }, currentGameId)
      if (parsed.length === 0) {
        actionsByKey.delete(actionKey)
        return
      }
      const first = parsed[0]
      if (!first) return
      actionsByKey.set(actionKey, first)
    }

    const refreshForSession = async (nextGameId: string) => {
      currentGameId = nextGameId
      actionsByKey.clear()
      const refreshedActions = await fetchActions(roomId, nextGameId)
      for (const record of refreshedActions) {
        actionsByKey.set(toStoredActionKey(record.gameId, record.id), record)
      }
      cachedGameState = await fetchPersistedGameState(roomId)
    }

    const bootstrap = async () => {
      try {
        const initial = await fetchRoomSnapshot(roomId)
        if (!active || fallbackTriggered) return
        cachedMeta = initial.meta
        cachedParticipants = initial.participants
        cachedGameState = initial.gameState
        currentGameId = initial.meta?.currentGameId ?? null
        actionsByKey.clear()
        initial.actions.forEach((record) => {
          actionsByKey.set(toStoredActionKey(record.gameId, record.id), record)
        })
        emitSnapshot(true)
      } catch (error) {
        triggerFallback(error)
        return
      }

      try {
        if (!client.subscribeValue || !client.subscribeChild) throw new Error('Realtime subscriptions are unavailable.')
        realtimeUnsubscribers.push(
          client.subscribeValue(`${withRoomPath(roomId)}/meta`, {
            onValue: (rawMeta) => {
              void (async () => {
                try {
                  const nextMeta = await parseAndMaybeMigrateMeta(roomId, rawMeta)
                  if (!active || fallbackTriggered) return
                  const previousGameId = currentGameId
                  cachedMeta = nextMeta
                  if (!nextMeta) {
                    cachedParticipants = []
                    cachedGameState = null
                    currentGameId = null
                    actionsByKey.clear()
                    emitSnapshot(true)
                    return
                  }
                  if (previousGameId && previousGameId !== nextMeta.currentGameId) {
                    await refreshForSession(nextMeta.currentGameId)
                    if (!active || fallbackTriggered) return
                    emitSnapshot(true)
                    return
                  }
                  currentGameId = nextMeta.currentGameId
                  emitSnapshot(false)
                } catch (error) {
                  triggerFallback(error)
                }
              })()
            },
            onError: (error) => triggerFallback(error)
          })
        )
        realtimeUnsubscribers.push(
          client.subscribeValue(`${withRoomPath(roomId)}/participants`, {
            onValue: (rawParticipants) => {
              try {
                cachedParticipants = parseParticipants(rawParticipants)
                emitSnapshot(false)
              } catch (error) {
                triggerFallback(error)
              }
            },
            onError: (error) => triggerFallback(error)
          })
        )
        realtimeUnsubscribers.push(
          client.subscribeChild(`${withRoomPath(roomId)}/actions`, {
            onAdded: (key, value) => {
              try {
                applyActionValue(key, value)
                emitSnapshot(false)
              } catch (error) {
                triggerFallback(error)
              }
            },
            onChanged: (key, value) => {
              try {
                applyActionValue(key, value)
                emitSnapshot(false)
              } catch (error) {
                triggerFallback(error)
              }
            },
            onRemoved: (key) => {
              actionsByKey.delete(key)
              emitSnapshot(false)
            },
            onError: (error) => triggerFallback(error)
          })
        )
      } catch (error) {
        triggerFallback(error)
      }
    }

    void bootstrap()

    return () => {
      active = false
      realtimeUnsubscribers.forEach((unsubscribe) => unsubscribe())
      fallbackUnsubscribe?.()
    }
  }

  const subscribeRoomSnapshot = (
    roomId: string,
    handlers: { onUpdate: (snapshot: RoomSnapshot) => void; onError?: (error: Error) => void }
  ): (() => void) => {
    if (client.supportsRealtime && client.subscribeValue && client.subscribeChild) {
      return subscribeRoomSnapshotRealtime(roomId, handlers)
    }
    return subscribeRoomSnapshotPolling(roomId, handlers)
  }

  const subscribeRoomDirectoryPolling = (
    handlers: { onUpdate: (rooms: RoomDirectoryEntry[]) => void; onError?: (error: Error) => void }
  ): (() => void) => {
    let active = true
    let pollInFlight = false
    let pollRerunRequested = false
    let cleanupInFlight = false
    let cleanupRerunRequested = false

    const run = async () => {
      if (!active) return
      if (pollInFlight) {
        pollRerunRequested = true
        return
      }
      pollInFlight = true
      try {
        do {
          pollRerunRequested = false
          try {
            const rooms = await fetchRoomDirectory()
            if (!active) return
            handlers.onUpdate(rooms)
          } catch (error) {
            if (!active) return
            handlers.onError?.(toError(error, 'Failed to fetch room directory'))
          }
        } while (active && pollRerunRequested)
      } finally {
        pollInFlight = false
      }
    }

    const runCleanup = async () => {
      if (!active) return
      if (cleanupInFlight) {
        cleanupRerunRequested = true
        return
      }
      cleanupInFlight = true
      try {
        do {
          cleanupRerunRequested = false
          try {
            await cleanupExpiredRooms()
          } catch {
            // Best-effort cleanup in v1.
          }
        } while (active && cleanupRerunRequested)
      } finally {
        cleanupInFlight = false
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

  const subscribeRoomDirectoryRealtime = (
    handlers: { onUpdate: (rooms: RoomDirectoryEntry[]) => void; onError?: (error: Error) => void }
  ): (() => void) => {
    let active = true
    let fallbackTriggered = false
    let fallbackUnsubscribe: (() => void) | null = null
    let cleanupInFlight = false
    let cleanupRerunRequested = false

    const emitRooms = (directoryNode: unknown) => {
      if (!active || fallbackTriggered) return
      if (!isRecord(directoryNode)) {
        handlers.onUpdate([])
        return
      }
      const rooms: RoomDirectoryEntry[] = []
      for (const value of Object.values(directoryNode)) {
        const parsed = parseDirectoryEntry(value)
        if (parsed) rooms.push(parsed)
      }
      handlers.onUpdate(filterActiveRoomDirectory(rooms, now()))
    }

    const triggerFallback = (error: unknown) => {
      if (!active || fallbackTriggered) return
      fallbackTriggered = true
      const normalized = toError(error, 'Realtime room directory subscription failed; falling back to polling.')
      console.warn('[firebase] room directory realtime failed; using polling fallback', normalized)
      handlers.onError?.(normalized)
      timers.clearInterval(cleanupTimer)
      unsubscribeValue?.()
      fallbackUnsubscribe = subscribeRoomDirectoryPolling(handlers)
    }

    const runCleanup = async () => {
      if (!active || fallbackTriggered) return
      if (cleanupInFlight) {
        cleanupRerunRequested = true
        return
      }
      cleanupInFlight = true
      try {
        do {
          cleanupRerunRequested = false
          try {
            await cleanupExpiredRooms()
          } catch {
            // Best-effort cleanup in v1.
          }
        } while (active && !fallbackTriggered && cleanupRerunRequested)
      } finally {
        cleanupInFlight = false
      }
    }

    const cleanupTimer = timers.setInterval(() => {
      void runCleanup()
    }, DIRECTORY_CLEANUP_MS)
    void runCleanup()

    let unsubscribeValue: (() => void) | null = null
    try {
      if (!client.subscribeValue) throw new Error('Realtime subscriptions are unavailable.')
      unsubscribeValue = client.subscribeValue('/roomDirectory', {
        onValue: (directoryNode) => {
          try {
            emitRooms(directoryNode)
          } catch (error) {
            triggerFallback(error)
          }
        },
        onError: (error) => triggerFallback(error)
      })
    } catch (error) {
      triggerFallback(error)
    }

    return () => {
      active = false
      timers.clearInterval(cleanupTimer)
      unsubscribeValue?.()
      fallbackUnsubscribe?.()
    }
  }

  const subscribeRoomDirectory = (
    handlers: { onUpdate: (rooms: RoomDirectoryEntry[]) => void; onError?: (error: Error) => void }
  ): (() => void) => {
    if (client.supportsRealtime && client.subscribeValue) {
      return subscribeRoomDirectoryRealtime(handlers)
    }
    return subscribeRoomDirectoryPolling(handlers)
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
    fetchRoomMeta,
    fetchRoomActions,
    upsertGameState,
    subscribeRoomSnapshot,
    fetchRoomDirectory,
    subscribeRoomDirectory,
    cleanupExpiredRooms
  }
}
