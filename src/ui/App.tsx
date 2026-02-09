import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { stringToCard } from '../engine/cards'
import { combineSeeds, commitSeed, createSeedPair } from '../crypto/commitReveal'
import { GameAction, GameState } from '../state/gameState'
import { applyAction } from '../state/reducer'
import { Lobby } from './components/Lobby'
import { GameTable } from './components/GameTable'
import { toRoomSlug } from './utils/roomNames'
import { hydrateRoomState, seedActionCounterFromLog } from '../sync/roomHydration'
import { WAITING_OPPONENT_ID } from '../sync/constants'
import {
  createRoomStore,
  ParticipantPresence,
  RoomDirectoryEntry,
  RoomRole,
  RoomSnapshot
} from '../sync/roomStore'

export type View = 'lobby' | 'table'

const LOCAL_PLAYER_ID_KEY = 'ofc:local-player-id'
const LOCAL_PLAYER_NAME_KEY = 'ofc:player-name'
const HEARTBEAT_MS = 10_000
const PEER_PING_TIMEOUT_MS = HEARTBEAT_MS * 3
const PEER_ACK_TIMEOUT_MS = HEARTBEAT_MS * 4
const BOOTSTRAP_WARNING_GRACE_MS = 8_000

function generatePlayerId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `p-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  }
  return `p-${Math.random().toString(36).slice(2, 14)}`
}

function getOrCreateLocalPlayerId(): string {
  if (typeof window === 'undefined') return generatePlayerId()

  try {
    const existing = window.localStorage.getItem(LOCAL_PLAYER_ID_KEY)
    if (existing) return existing
    const created = generatePlayerId()
    window.localStorage.setItem(LOCAL_PLAYER_ID_KEY, created)
    return created
  } catch {
    return generatePlayerId()
  }
}

function readLocalPlayerName(): string {
  if (typeof window === 'undefined') return 'You'
  try {
    const stored = window.localStorage.getItem(LOCAL_PLAYER_NAME_KEY)
    return stored && stored.trim().length > 0 ? stored : 'You'
  } catch {
    return 'You'
  }
}

function writeLocalPlayerName(name: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LOCAL_PLAYER_NAME_KEY, name)
  } catch {
    // Ignore storage write failures.
  }
}

function getParamInsensitive(params: URLSearchParams, key: string): string | null {
  const lowered = key.toLowerCase()
  for (const [k, value] of params.entries()) {
    if (k.toLowerCase() === lowered) return value
  }
  return null
}

function parseJoinFlag(value: string | null): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function buildSharePath(roomSlug: string, role: RoomRole): string {
  const join = role === 'guest' ? '&join=1' : ''
  return `/${roomSlug}?players=2${join}`
}

function buildPingToken(playerId: string): string {
  return `${playerId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
}

export default function App() {
  const roomStore = useMemo(() => createRoomStore(), [])
  const [view, setView] = useState<View>('lobby')
  const [playerCount, setPlayerCount] = useState(2)
  const [playerName, setPlayerName] = useState(() => readLocalPlayerName())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [fourColorDeck, setFourColorDeck] = useState(true)
  const [hideSubmitButton, setHideSubmitButton] = useState(false)
  const [localPlayerId] = useState(() => getOrCreateLocalPlayerId())
  const [state, setState] = useState<GameState | null>(null)
  const [roomSlug, setRoomSlug] = useState<string | null>(null)
  const [roomRole, setRoomRole] = useState<RoomRole>('host')
  const [connectedPeers, setConnectedPeers] = useState<string[]>([])
  const [participantPresenceById, setParticipantPresenceById] = useState<Record<string, ParticipantPresence>>({})
  const [connectivityByPlayerId, setConnectivityByPlayerId] = useState<Record<string, boolean>>({
    [localPlayerId]: true
  })
  const [waitingMessage, setWaitingMessage] = useState<string | null>(null)
  const [rooms, setRooms] = useState<RoomDirectoryEntry[]>([])
  const [roomsLoading, setRoomsLoading] = useState(false)
  const [roomsError, setRoomsError] = useState<string | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)
  const [copiedShare, setCopiedShare] = useState(false)
  const actionCounter = useMemo(() => ({ value: 0 }), [])
  const localSeedRef = useMemo(() => ({ value: '' }), [])
  const useCrypto = false

  const roomSlugRef = useRef<string | null>(null)
  const autoJoinRef = useRef(false)
  const nameBroadcastTimerRef = useRef<number | null>(null)
  const autoDrawRef = useRef('')
  const readySentRef = useRef(false)
  const commitSentRef = useRef(false)
  const revealSentRef = useRef(false)
  const deferredActionsRef = useRef<{ action: GameAction; attempts: number }[]>([])
  const lastHydrationSignatureRef = useRef('')
  const lastPersistedStateSignatureRef = useRef('')
  const latestPingTokenRef = useRef('')
  const latestPingAtRef = useRef(0)
  const latestAckAtRef = useRef(0)
  const acknowledgedPeerPingRef = useRef('')
  const bootstrapInProgressRef = useRef(false)
  const bootstrapRoomRef = useRef<string | null>(null)
  const bootstrapStartedAtRef = useRef(0)

  const enqueueDeferred = useCallback((action: GameAction) => {
    if (deferredActionsRef.current.some((entry) => entry.action.id === action.id)) return
    deferredActionsRef.current.push({ action, attempts: 0 })
  }, [])

  const dispatchAction = useCallback(
    (action: GameAction) => {
      setState((current) => {
        if (!current) return current
        if (current.actionLog.some((entry) => entry.id === action.id)) {
          return current
        }
        try {
          return applyAction(current, action)
        } catch (error) {
          console.warn('[sync] Action deferred', action, error)
          enqueueDeferred(action)
          return current
        }
      })
    },
    [enqueueDeferred]
  )

  const dispatchActions = useCallback(
    (actions: GameAction[]) => {
      setState((current) => {
        if (!current) return current
        let next = current
        const filtered = actions.filter((action) => !current.actionLog.some((entry) => entry.id === action.id))
        for (const action of filtered) {
          try {
            next = applyAction(next, action)
          } catch (error) {
            console.warn('[sync] Action deferred', action, error)
            enqueueDeferred(action)
          }
        }
        return next
      })
    },
    [enqueueDeferred]
  )

  const nextActionId = useCallback(() => {
    actionCounter.value += 1
    return `${localPlayerId}-${actionCounter.value}`
  }, [actionCounter, localPlayerId])

  const applySnapshot = useCallback(
    (snapshot: RoomSnapshot) => {
      const now = Date.now()
      const participantMap: Record<string, ParticipantPresence> = {}
      snapshot.participants.forEach((participant) => {
        if (participant.playerId === WAITING_OPPONENT_ID) return
        participantMap[participant.playerId] = participant
      })
      setParticipantPresenceById(participantMap)

      const peerPresence = Object.values(participantMap).find((participant) => participant.playerId !== localPlayerId)
      const peerRecentlySeen = Boolean(peerPresence && now - peerPresence.lastSeenAt <= PEER_PING_TIMEOUT_MS)
      const peerAckedLatestPing = Boolean(
        peerPresence &&
          latestPingTokenRef.current &&
          peerPresence.ackForPeerPingToken === latestPingTokenRef.current &&
          (peerPresence.ackAt ?? 0) > 0 &&
          now - (peerPresence.ackAt ?? 0) <= PEER_ACK_TIMEOUT_MS
      )
      const peerConnected = Boolean(peerPresence && peerRecentlySeen && peerAckedLatestPing)

      setConnectivityByPlayerId(() => {
        const next: Record<string, boolean> = { [localPlayerId]: true }
        if (peerPresence) {
          next[peerPresence.playerId] = peerConnected
        }
        return next
      })

      if (!peerPresence) {
        setWaitingMessage('Waiting for opponent to connect...')
      } else if (!peerRecentlySeen) {
        setWaitingMessage(`Waiting for ${peerPresence.name} to reconnect...`)
      } else if (!peerAckedLatestPing) {
        setWaitingMessage(`Waiting for ${peerPresence.name} to respond...`)
      } else {
        setWaitingMessage(null)
      }

      if (peerPresence?.pingToken && peerPresence.pingToken !== acknowledgedPeerPingRef.current) {
        acknowledgedPeerPingRef.current = peerPresence.pingToken
        latestAckAtRef.current = now
        void roomStore
          .touchPresence({
            roomId: snapshot.roomId,
            playerId: localPlayerId,
            playerName,
            role: roomRole,
            pingToken: latestPingTokenRef.current || undefined,
            pingAt: latestPingAtRef.current || undefined,
            ackForPeerPingToken: peerPresence.pingToken,
            ackAt: now
          })
          .catch(() => undefined)
      }

      const hydrated = hydrateRoomState({
        localPlayerId,
        localPlayerName: playerName,
        participants: snapshot.participants,
        actionRecords: snapshot.actions
      })
      const resolvedState = hydrated.state ?? snapshot.gameState
      setConnectedPeers(hydrated.connectedPeerIds)

      const signature = `${snapshot.roomId}|${hydrated.connectedPeerIds.join(',')}|${hydrated.actionLog
        .map((action) => action.id)
        .join(',')}`
      if (signature === lastHydrationSignatureRef.current) return
      lastHydrationSignatureRef.current = signature

      if (resolvedState) {
        actionCounter.value = seedActionCounterFromLog(hydrated.actionLog, localPlayerId, actionCounter.value)
        setState(resolvedState)
        if (!snapshot.gameState) {
          void roomStore.upsertGameState(snapshot.roomId, resolvedState).catch(() => undefined)
        }
      } else {
        setState(null)
      }

      const bootstrapElapsedMs = now - bootstrapStartedAtRef.current
      const bootstrapMatchesRoom =
        bootstrapInProgressRef.current && bootstrapRoomRef.current === snapshot.roomId
      const suppressDroppedWarnings = bootstrapMatchesRoom && bootstrapElapsedMs <= BOOTSTRAP_WARNING_GRACE_MS
      if (bootstrapMatchesRoom && (hydrated.droppedActionIds.length === 0 || bootstrapElapsedMs > BOOTSTRAP_WARNING_GRACE_MS)) {
        bootstrapInProgressRef.current = false
        bootstrapRoomRef.current = null
      }

      if (hydrated.droppedActionIds.length > 0) {
        if (!suppressDroppedWarnings) {
          setSyncError(`Dropped invalid actions: ${hydrated.droppedActionIds.join(', ')}`)
        }
      } else {
        setSyncError((current) =>
          current && current.startsWith('Dropped invalid actions:') ? null : current
        )
      }
    },
    [actionCounter, localPlayerId, playerName, roomRole, roomStore]
  )

  const returnToLobby = useCallback(() => {
    const activeRoom = roomSlugRef.current
    if (activeRoom) {
      void roomStore.leaveRoom(activeRoom, localPlayerId).catch(() => undefined)
    }
    roomSlugRef.current = null
    setRoomSlug(null)
    setState(null)
    setConnectedPeers([])
    setParticipantPresenceById({})
    setConnectivityByPlayerId({ [localPlayerId]: true })
    setWaitingMessage(null)
    setView('lobby')
    setJoining(false)
    setSyncError(null)
    lastHydrationSignatureRef.current = ''
    latestPingTokenRef.current = ''
    latestPingAtRef.current = 0
    latestAckAtRef.current = 0
    acknowledgedPeerPingRef.current = ''
    lastPersistedStateSignatureRef.current = ''
    bootstrapInProgressRef.current = false
    bootstrapRoomRef.current = null
    bootstrapStartedAtRef.current = 0
  }, [localPlayerId, roomStore])

  const dispatchAndSync = useCallback(
    (action: GameAction) => {
      dispatchAction(action)
      const activeRoom = roomSlugRef.current
      if (!activeRoom) return
      void roomStore
        .appendAction({ roomId: activeRoom, actorId: localPlayerId, action })
        .catch((error) => {
          setSyncError(error instanceof Error ? error.message : 'Failed to append action')
        })
    },
    [dispatchAction, localPlayerId, roomStore]
  )

  const dispatchBatchAndSync = useCallback(
    (actions: GameAction[]) => {
      dispatchActions(actions)
      const activeRoom = roomSlugRef.current
      if (!activeRoom) return
      actions.forEach((action) => {
        void roomStore
          .appendAction({ roomId: activeRoom, actorId: localPlayerId, action })
          .catch((error) => {
            setSyncError(error instanceof Error ? error.message : 'Failed to append action')
          })
      })
    },
    [dispatchActions, localPlayerId, roomStore]
  )

  const startDatabaseGame = useCallback(
    async (room: string, host: boolean) => {
      const slug = toRoomSlug(room)
      if (!slug) return
      if (!roomStore.isConfigured) {
        setSyncError('Firebase is not configured. Set VITE_FIREBASE_DATABASE_URL and related env vars.')
        return
      }

      const previousRoom = roomSlugRef.current
      if (previousRoom && previousRoom !== slug) {
        await roomStore.leaveRoom(previousRoom, localPlayerId).catch(() => undefined)
      }

      setView('table')
      setRoomSlug(slug)
      roomSlugRef.current = slug
      setRoomRole(host ? 'host' : 'guest')
      setPlayerCount(2)
      setConnectedPeers([])
      const localPresence: ParticipantPresence = {
        playerId: localPlayerId,
        name: playerName,
        role: host ? 'host' : 'guest',
        joinedAt: Date.now(),
        lastSeenAt: Date.now()
      }
      const seeded = hydrateRoomState({
        localPlayerId,
        localPlayerName: playerName,
        participants: [localPresence],
        actionRecords: []
      })
      setParticipantPresenceById({ [localPlayerId]: localPresence })
      setConnectivityByPlayerId({ [localPlayerId]: true })
      setWaitingMessage('Waiting for opponent to connect...')
      setState(seeded.state)
      setSyncError(null)
      setJoining(true)
      lastHydrationSignatureRef.current = ''
      bootstrapInProgressRef.current = true
      bootstrapRoomRef.current = slug
      bootstrapStartedAtRef.current = Date.now()

      try {
        let snapshot: RoomSnapshot
        let effectiveRole: RoomRole = host ? 'host' : 'guest'
        const existing = await roomStore.fetchRoomSnapshot(slug)
        if (!existing.meta) {
          effectiveRole = 'host'
          snapshot = await roomStore.createRoom({
            roomId: slug,
            displayName: slug,
            hostId: localPlayerId,
            hostName: playerName,
            expectedPlayers: 2
          })
        } else {
          const now = Date.now()
          const allParticipantsStale =
            existing.participants.length > 0 &&
            existing.participants.every((participant) => now - participant.lastSeenAt > PEER_PING_TIMEOUT_MS)
          const shouldRestartSession = host && (allParticipantsStale || existing.gameState === null)

          if (shouldRestartSession) {
            effectiveRole = 'host'
            snapshot = await roomStore.restartGameSession({
              roomId: slug,
              hostId: localPlayerId,
              hostName: playerName,
              expectedPlayers: 2
            })
          } else {
            const localExisting = existing.participants.find((participant) => participant.playerId === localPlayerId)
            if (localExisting) {
              effectiveRole = localExisting.role
            } else {
              const hostTaken = existing.participants.some((participant) => participant.role === 'host')
              effectiveRole = hostTaken ? 'guest' : 'host'
            }
            snapshot = await roomStore.joinRoom({
              roomId: slug,
              playerId: localPlayerId,
              playerName,
              role: effectiveRole
            })
          }
        }
        const localParticipant = snapshot.participants.find((participant) => participant.playerId === localPlayerId)
        if (localParticipant) {
          effectiveRole = localParticipant.role
        }
        setRoomRole(effectiveRole)
        applySnapshot(snapshot)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to start database room'
        setSyncError(message)
        bootstrapInProgressRef.current = false
        bootstrapRoomRef.current = null
        bootstrapStartedAtRef.current = 0
        roomSlugRef.current = null
        setRoomSlug(null)
        setConnectedPeers([])
        setParticipantPresenceById({})
        setConnectivityByPlayerId({ [localPlayerId]: true })
        setWaitingMessage(null)
        setState(null)
        setView('lobby')
      } finally {
        setJoining(false)
      }
    },
    [applySnapshot, localPlayerId, playerName, roomStore]
  )

  useEffect(() => {
    writeLocalPlayerName(playerName)
  }, [playerName])

  useEffect(() => {
    roomSlugRef.current = roomSlug
  }, [roomSlug])

  useEffect(() => {
    if (roomSlug === null) {
      lastHydrationSignatureRef.current = ''
      lastPersistedStateSignatureRef.current = ''
    }
  }, [roomSlug])

  useEffect(() => {
    if (!roomSlug || !state) return
    const signature = `${state.actionLog.length}:${state.phase}:${state.turnSeat}:${state.turnStage}:${state.drawIndex}`
    if (lastPersistedStateSignatureRef.current === signature) return
    lastPersistedStateSignatureRef.current = signature
    void roomStore.upsertGameState(roomSlug, state).catch(() => undefined)
  }, [roomSlug, roomStore, state])

  useEffect(() => {
    if (view !== 'lobby') return
    if (!roomStore.isConfigured) {
      setRooms([])
      setRoomsLoading(false)
      setRoomsError('Firebase room directory unavailable. Configure VITE_FIREBASE_DATABASE_URL.')
      return
    }

    setRoomsLoading(true)
    setRoomsError(null)
    const unsubscribe = roomStore.subscribeRoomDirectory({
      onUpdate: (nextRooms) => {
        setRooms(nextRooms)
        setRoomsLoading(false)
      },
      onError: (error) => {
        setRoomsError(error.message)
        setRoomsLoading(false)
      }
    })
    return unsubscribe
  }, [roomStore, view])

  useEffect(() => {
    if (!roomSlug) return
    if (!roomStore.isConfigured) return
    const unsubscribe = roomStore.subscribeRoomSnapshot(roomSlug, {
      onUpdate: (snapshot) => applySnapshot(snapshot),
      onError: (error) => setSyncError(error.message)
    })
    return unsubscribe
  }, [applySnapshot, roomSlug, roomStore])

  useEffect(() => {
    if (!roomSlug) return
    const heartbeat = () => {
      const pingToken = buildPingToken(localPlayerId)
      const pingAt = Date.now()
      latestPingTokenRef.current = pingToken
      latestPingAtRef.current = pingAt
      void roomStore
        .touchPresence({
          roomId: roomSlug,
          playerId: localPlayerId,
          playerName,
          role: roomRole,
          pingToken,
          pingAt,
          ackForPeerPingToken: acknowledgedPeerPingRef.current || undefined,
          ackAt: latestAckAtRef.current || undefined
        })
        .catch((error) => {
          setSyncError(error instanceof Error ? error.message : 'Failed to heartbeat room presence')
        })
    }
    void heartbeat()
    const timerId = window.setInterval(heartbeat, HEARTBEAT_MS)
    return () => window.clearInterval(timerId)
  }, [localPlayerId, playerName, roomRole, roomSlug, roomStore])

  useEffect(() => {
    if (autoJoinRef.current) return
    const params = new URLSearchParams(window.location.search)
    const pathRoom = window.location.pathname.replace(/^\//, '')
    const room = getParamInsensitive(params, 'room') ?? (pathRoom.length > 0 ? decodeURIComponent(pathRoom) : null)
    if (!room) return

    const join = parseJoinFlag(getParamInsensitive(params, 'join'))
    autoJoinRef.current = true
    void startDatabaseGame(room, !join)
  }, [startDatabaseGame])

  useEffect(() => {
    if (roomSlug && view !== 'lobby') {
      const url = buildSharePath(roomSlug, roomRole)
      window.history.pushState({ room: roomSlug }, '', url)
    } else if (view === 'lobby') {
      window.history.pushState({}, '', '/')
    }
  }, [roomRole, roomSlug, view])

  useEffect(() => {
    const onPopState = () => {
      if (window.location.pathname === '/' || window.location.pathname === '') {
        returnToLobby()
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [returnToLobby])

  useEffect(() => {
    return () => {
      const activeRoom = roomSlugRef.current
      if (!activeRoom) return
      void roomStore.leaveRoom(activeRoom, localPlayerId).catch(() => undefined)
    }
  }, [localPlayerId, roomStore])

  useEffect(() => {
    if (!state) return
    if (deferredActionsRef.current.length === 0) return
    setState((current) => {
      if (!current) return current
      let next = current
      const remaining: { action: GameAction; attempts: number }[] = []
      for (const entry of deferredActionsRef.current) {
        try {
          next = applyAction(next, entry.action)
        } catch {
          const attempts = entry.attempts + 1
          if (attempts < 6) {
            remaining.push({ action: entry.action, attempts })
          }
        }
      }
      deferredActionsRef.current = remaining
      return next
    })
  }, [state])

  useEffect(() => {
    if (!state) return
    if (state.phase !== 'lobby') return
    const local = state.players.find((player) => player.id === localPlayerId)
    if (!local || local.ready || readySentRef.current) return
    readySentRef.current = true
    dispatchAndSync({ id: nextActionId(), type: 'ready', playerId: localPlayerId })
  }, [dispatchAndSync, localPlayerId, nextActionId, state])

  useEffect(() => {
    if (!state) {
      if (nameBroadcastTimerRef.current !== null) {
        window.clearTimeout(nameBroadcastTimerRef.current)
        nameBroadcastTimerRef.current = null
      }
      return
    }

    const local = state.players.find((player) => player.id === localPlayerId)
    if (!local || local.name === playerName) return

    if (nameBroadcastTimerRef.current !== null) {
      window.clearTimeout(nameBroadcastTimerRef.current)
    }

    nameBroadcastTimerRef.current = window.setTimeout(() => {
      dispatchAndSync({
        id: nextActionId(),
        type: 'setName',
        playerId: localPlayerId,
        name: playerName
      })
      nameBroadcastTimerRef.current = null
    }, 500)

    return () => {
      if (nameBroadcastTimerRef.current !== null) {
        window.clearTimeout(nameBroadcastTimerRef.current)
        nameBroadcastTimerRef.current = null
      }
    }
  }, [dispatchAndSync, localPlayerId, nextActionId, playerName, state])

  useEffect(() => {
    if (!state) return
    if (state.phase !== 'commit') return
    if (!useCrypto) return
    if (state.commits[localPlayerId] || commitSentRef.current) return
    const run = async () => {
      commitSentRef.current = true
      const { seed } = createSeedPair()
      localSeedRef.value = seed
      const commit = await commitSeed(seed)
      dispatchAndSync({ id: nextActionId(), type: 'commitSeed', playerId: localPlayerId, commit })
    }
    void run()
  }, [dispatchAndSync, localPlayerId, nextActionId, state, useCrypto])

  useEffect(() => {
    if (!state) return
    if (state.phase !== 'reveal') return
    if (!useCrypto) return
    if (state.reveals[localPlayerId] || revealSentRef.current) return
    if (!localSeedRef.value) return
    revealSentRef.current = true
    dispatchAndSync({ id: nextActionId(), type: 'revealSeed', playerId: localPlayerId, seed: localSeedRef.value })
  }, [dispatchAndSync, localPlayerId, nextActionId, state, useCrypto])

  useEffect(() => {
    if (!state) {
      readySentRef.current = false
      commitSentRef.current = false
      revealSentRef.current = false
      return
    }
    if (state.phase === 'lobby') {
      readySentRef.current = false
      commitSentRef.current = false
      revealSentRef.current = false
    }
    if (state.phase === 'commit') {
      commitSentRef.current = false
    }
    if (state.phase === 'reveal') {
      revealSentRef.current = false
    }
  }, [state?.phase])

  useEffect(() => {
    if (!state) return
    if (state.phase !== 'reveal') return
    if (!useCrypto) return
    const allRevealed = state.players.every((player) => Boolean(state.reveals[player.id]))
    if (!allRevealed || state.combinedSeed) return
    const orderedSeeds = [...state.players]
      .sort((a, b) => a.seat - b.seat)
      .map((player) => state.reveals[player.id])
      .filter((seed): seed is string => Boolean(seed))
    if (orderedSeeds.length !== state.players.length) return
    const run = async () => {
      const combined = await combineSeeds(orderedSeeds)
      const combinedId = `derived:setCombinedSeed:${combined}`
      const startId = `derived:startRound:${combined}`
      dispatchBatchAndSync([
        { id: combinedId, type: 'setCombinedSeed', seed: combined },
        { id: startId, type: 'startRound' }
      ])
    }
    void run()
  }, [dispatchBatchAndSync, state, useCrypto])

  useEffect(() => {
    if (!state) return
    if (useCrypto) return
    if (state.phase !== 'commit') return
    if (state.combinedSeed) return
    const leaderId = [...state.players].sort((a, b) => a.id.localeCompare(b.id))[0]?.id
    if (leaderId !== localPlayerId) return
    const { seed } = createSeedPair()
    const combinedId = `derived:setCombinedSeed:${seed}`
    const startId = `derived:startRound:${seed}`
    dispatchBatchAndSync([
      { id: combinedId, type: 'setCombinedSeed', seed },
      { id: startId, type: 'startRound' }
    ])
  }, [dispatchBatchAndSync, localPlayerId, state, useCrypto])

  useEffect(() => {
    if (!state || state.phase !== 'play') return
    const current = state.players.find((player) => player.seat === state.turnSeat)
    if (!current || current.id !== localPlayerId) return
    if (state.turnStage !== 'draw') return
    const key = `${state.turnSeat}-${state.drawIndex}`
    if (autoDrawRef.current === key) return
    autoDrawRef.current = key
    dispatchAndSync({ id: nextActionId(), type: 'drawCard', playerId: localPlayerId })
  }, [dispatchAndSync, localPlayerId, nextActionId, state])

  useEffect(() => {
    if (!state || state.phase !== 'play') {
      autoDrawRef.current = ''
    }
  }, [state?.phase])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (!state || state.phase !== 'initial') return
    const myPending = state.pending[localPlayerId]
    if (!myPending || myPending.length === 0) return
    const myLines = state.lines[localPlayerId]
    if (!myLines) return

    const limits = { top: 3, middle: 5, bottom: 5 } as const
    const remaining = {
      top: limits.top - myLines.top.length,
      middle: limits.middle - myLines.middle.length,
      bottom: limits.bottom - myLines.bottom.length
    }
    const actions: GameAction[] = []
    const rows: (keyof typeof limits)[] = []
    for (const row of ['bottom', 'middle', 'top'] as const) {
      for (let i = 0; i < remaining[row]; i += 1) rows.push(row)
    }
    for (let i = rows.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[rows[i], rows[j]] = [rows[j] as keyof typeof limits, rows[i] as keyof typeof limits]
    }
    for (let i = 0; i < myPending.length; i += 1) {
      const card = myPending[i]
      const target = rows[i]
      if (!card || !target) break
      actions.push({ id: nextActionId(), type: 'placeCard', playerId: localPlayerId, card, target })
    }
    if (actions.length > 0) {
      dispatchBatchAndSync(actions)
    }
  }, [dispatchBatchAndSync, localPlayerId, nextActionId, state])

  useEffect(() => {
    if (!state) return
    const gamePhases = ['initial', 'play', 'score'] as const
    if (!(gamePhases as readonly string[]).includes(state.phase)) return
    const hasCards = state.deck.length > 0
    const hasAnyPending = state.players.some((player) => (state.pending[player.id]?.length ?? 0) > 0)
    const hasAnyLines = state.players.some((player) => {
      const lines = state.lines[player.id]
      if (!lines) return false
      return lines.top.length > 0 || lines.middle.length > 0 || lines.bottom.length > 0
    })
    if (!hasCards && !hasAnyPending && !hasAnyLines) {
      returnToLobby()
    }
  }, [returnToLobby, state])

  const sharePath = roomSlug ? buildSharePath(roomSlug, 'guest') : '/'
  const activeTableState = useMemo(() => {
    if (state) return state
    if (view === 'lobby') return null
    const participants = Object.values(participantPresenceById)
    const fallbackParticipants =
      participants.length > 0
        ? participants
        : [
            {
              playerId: localPlayerId,
              name: playerName,
              role: roomRole,
              joinedAt: 0,
              lastSeenAt: 0
            } satisfies ParticipantPresence
          ]
    return hydrateRoomState({
      localPlayerId,
      localPlayerName: playerName,
      participants: fallbackParticipants,
      actionRecords: []
    }).state
  }, [localPlayerId, participantPresenceById, playerName, roomRole, state, view])

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <div className="brand">OFC-GPT</div>
          <div className="subtitle">Realtime DB Sync • Firebase RTDB</div>
        </div>
        <button className="button secondary" onClick={() => setSettingsOpen((open) => !open)}>
          Settings
        </button>
      </header>

      {settingsOpen && (
        <section className="panel settings-panel">
          <div className="settings-header">
            <h3>Settings</h3>
            <button className="settings-close" onClick={() => setSettingsOpen(false)} aria-label="Close settings">
              &times;
            </button>
          </div>
          <label className="setting-field">
            <span>Player Name</span>
            <input value={playerName} onChange={(event) => setPlayerName(event.target.value)} />
          </label>
          <label className="setting-row">
            <input type="checkbox" checked={fourColorDeck} onChange={(event) => setFourColorDeck(event.target.checked)} />
            4-Color Deck
          </label>
          <label className="setting-row">
            <input type="checkbox" checked={hideSubmitButton} onChange={(event) => setHideSubmitButton(event.target.checked)} />
            Hide Submit Button (initial)
          </label>
        </section>
      )}

      {syncError && (
        <section className="panel" style={{ marginBottom: 12 }}>
          <p>{syncError}</p>
        </section>
      )}

      {view === 'lobby' ? (
        <Lobby
          playerCount={playerCount}
          playerName={playerName}
          onPlayerNameChange={setPlayerName}
          onPlayerCountChange={() => setPlayerCount(2)}
          onStart={(room, host) => {
            void startDatabaseGame(room, host)
          }}
          rooms={rooms}
          roomsLoading={roomsLoading}
          roomsError={roomsError}
          onJoinListedRoom={(listedRoomId) => {
            void startDatabaseGame(listedRoomId, false)
          }}
          initialRoom={
            getParamInsensitive(new URLSearchParams(window.location.search), 'room') ??
            (window.location.pathname.replace(/^\//, '') || undefined)
          }
        />
      ) : activeTableState ? (
        <GameTable
          state={activeTableState}
          localPlayerId={localPlayerId}
          connectivityByPlayerId={connectivityByPlayerId}
          waitingMessage={waitingMessage}
          onPlace={(card, target) =>
            dispatchAndSync({
              id: nextActionId(),
              type: 'placeCard',
              playerId: localPlayerId,
              card: stringToCard(card),
              target
            })
          }
          onSubmitInitial={(draft) => {
            const actions: GameAction[] = []
            draft.top.forEach((card) => {
              actions.push({ id: nextActionId(), type: 'placeCard', playerId: localPlayerId, card, target: 'top' })
            })
            draft.middle.forEach((card) => {
              actions.push({ id: nextActionId(), type: 'placeCard', playerId: localPlayerId, card, target: 'middle' })
            })
            draft.bottom.forEach((card) => {
              actions.push({ id: nextActionId(), type: 'placeCard', playerId: localPlayerId, card, target: 'bottom' })
            })
            dispatchBatchAndSync(actions)
          }}
          onResetRound={() => dispatchAndSync({ id: nextActionId(), type: 'resetRound' })}
          hideSubmit={hideSubmitButton}
          fourColor={fourColorDeck}
        />
      ) : (
        <section className="panel">
          <h2>Hydrating table...</h2>
          {joining ? (
            <p>Joining room...</p>
          ) : (
            <p>
              Connected {connectedPeers.length + 1} / {playerCount}
            </p>
          )}
          <p style={{ marginTop: 12 }}>Share Link</p>
          <div className="share-row">
            <span className="share-link">{`${window.location.origin}${sharePath}`}</span>
            <button
              className="button secondary"
              onClick={() => {
                navigator.clipboard.writeText(`${window.location.origin}${sharePath}`)
                setCopiedShare(true)
                window.setTimeout(() => setCopiedShare(false), 1600)
              }}
            >
              Copy
            </button>
            {copiedShare && <span className="tooltip">Copied!</span>}
          </div>
        </section>
      )}
    </div>
  )
}
