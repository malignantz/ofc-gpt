import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFocusTrap } from './hooks/useFocusTrap'
import { buildDeck } from '../engine/deck'
import { stringToCard } from '../engine/cards'
import { combineSeeds, commitSeed, createSeedPair } from '../crypto/commitReveal'
import { GameAction, GameState, Player, initialGameState } from '../state/gameState'
import { applyAction } from '../state/reducer'
import { Lobby } from './components/Lobby'
import { GameTable } from './components/GameTable'
import { toRoomSlug } from './utils/roomNames'
import { ROUND_TAKEOVER_TIMEOUT_MS, getRoundRestartDecision } from './utils/roundControl'
import { ScoreboardEntry, readScoreboardEntriesFromLocalStorage } from './utils/scoreboard'
import { resolveRoute } from './utils/routeResolution'
import { resolveIncomingState, shouldIgnoreRegressiveSnapshot } from './utils/snapshotConsistency'
import { hydrateRoomState, seedActionCounterFromLog, sortActionRecords } from '../sync/roomHydration'
import { WAITING_OPPONENT_ID } from '../sync/constants'
import { clearRoomCache, loadRoomCache, saveRoomCache } from '../sync/localStateCache'
import {
  createRoomStore,
  ParticipantPresence,
  RoomDirectoryEntry,
  RoomRole,
  RoomSnapshot
} from '../sync/roomStore'
import { planCpuActions } from '../strategy/cpuPlanner'
import type { StrategyProfile } from '../strategy/types'

export type View = 'lobby' | 'table'
type GameMode = 'online' | 'cpu_local'
type QueuedOutboundAction = { action: GameAction; gameId: string | null }
type PresenceUpdateInput = {
  roomId: string
  playerId: string
  playerName: string
  role: RoomRole
  joinedAt?: number
  pingToken?: string
  pingAt?: number
  ackForPeerPingToken?: string
  ackAt?: number
}

const LOCAL_PLAYER_ID_KEY = 'ofc:local-player-id'
const LOCAL_PLAYER_NAME_KEY = 'ofc:player-name'
const MANUAL_CONFIRM_INITIAL_PLACEMENTS_KEY = 'ofc:manual-confirm-initial-placements-v1'
const HEARTBEAT_MS = 15_000
const MIN_PRESENCE_WRITE_MS = 1_000
const PEER_PING_TIMEOUT_MS = HEARTBEAT_MS * 3
const PEER_ACK_TIMEOUT_MS = HEARTBEAT_MS * 4
const BOOTSTRAP_WARNING_GRACE_MS = 8_000
const CPU_LOCAL_SESSION_KEY = 'ofc:cpu-local-session-v1'
const CPU_PROFILE_KEY = 'ofc:cpu-profile-v1'
const CPU_BOT_ID = '__cpu_bot__'
const CPU_BOT_NAME = 'CPU'
const CPU_ACTION_DELAY_MS = 650
const CPU_PROFILE_OPTIONS: Array<{ value: StrategyProfile; label: string }> = [
  { value: 'conservative_ev', label: 'Monte Carlo (conservative EV)' },
  { value: 'balanced_ev', label: 'Monte Carlo (balanced EV)' },
  { value: 'fantasy_pressure', label: 'Monte Carlo (fantasy pressure)' },
  { value: 'heuristic', label: 'Heuristic (rule + draw odds)' }
]
const DEFAULT_PLAYER_NAMES = ['Bert', 'Ernie', 'Elmo', 'Oscar', 'Cookie Monster', 'Big Bird'] as const

type CpuLocalSession = {
  version: 1
  localPlayerId: string
  state: GameState
  actionCounter: number
  savedAt: number
}

function generatePlayerId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `p-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  }
  return `p-${Math.random().toString(36).slice(2, 14)}`
}

function randomDefaultPlayerName(): string {
  const names = DEFAULT_PLAYER_NAMES
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const random = new Uint32Array(1)
    crypto.getRandomValues(random)
    const index = (random[0] ?? 0) % names.length
    return names[index] ?? names[0]
  }
  const index = Math.floor(Math.random() * names.length)
  return names[index] ?? names[0]
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
  const fallback = randomDefaultPlayerName()
  if (typeof window === 'undefined') return fallback
  try {
    const stored = window.localStorage.getItem(LOCAL_PLAYER_NAME_KEY)
    const normalized = stored?.trim() ?? ''
    if (normalized.length > 0 && normalized !== 'You') return normalized
    return fallback
  } catch {
    return fallback
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

function readManualConfirmInitialPlacements(): boolean {
  if (typeof window === 'undefined') return true
  try {
    const stored = window.localStorage.getItem(MANUAL_CONFIRM_INITIAL_PLACEMENTS_KEY)
    if (stored === 'false') return false
    if (stored === 'true') return true
    return true
  } catch {
    return true
  }
}

function writeManualConfirmInitialPlacements(value: boolean) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(MANUAL_CONFIRM_INITIAL_PLACEMENTS_KEY, String(value))
  } catch {
    // Ignore storage write failures.
  }
}

function readCpuLocalSession(): CpuLocalSession | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(CPU_LOCAL_SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CpuLocalSession> | null
    if (!parsed || parsed.version !== 1) return null
    if (!parsed.localPlayerId || typeof parsed.localPlayerId !== 'string') return null
    if (!parsed.state || typeof parsed.state !== 'object') return null
    if (typeof parsed.actionCounter !== 'number') return null
    if (typeof parsed.savedAt !== 'number') return null
    return parsed as CpuLocalSession
  } catch {
    return null
  }
}

function writeCpuLocalSession(session: CpuLocalSession) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CPU_LOCAL_SESSION_KEY, JSON.stringify(session))
  } catch {
    // Ignore storage write failures.
  }
}

function clearCpuLocalSession() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(CPU_LOCAL_SESSION_KEY)
  } catch {
    // Ignore storage remove failures.
  }
}

function isCpuLocalState(state: GameState, localPlayerId: string): boolean {
  const local = state.players.find((player) => player.id === localPlayerId)
  const cpu = state.players.find((player) => player.id === CPU_BOT_ID)
  return Boolean(local && cpu && state.players.length === 2)
}

function readCpuProfile(): StrategyProfile {
  if (typeof window === 'undefined') return 'heuristic'
  try {
    const stored = window.localStorage.getItem(CPU_PROFILE_KEY)
    if (
      stored === 'conservative_ev' ||
      stored === 'balanced_ev' ||
      stored === 'fantasy_pressure' ||
      stored === 'heuristic'
    ) {
      return stored
    }
    return 'heuristic'
  } catch {
    return 'heuristic'
  }
}

function writeCpuProfile(profile: StrategyProfile) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CPU_PROFILE_KEY, profile)
  } catch {
    // Ignore storage write failures.
  }
}

export function resolveCpuSessionForLocalPlayer(
  session: CpuLocalSession | null,
  localPlayerId: string
): CpuLocalSession | null {
  if (!session) return null
  if (session.localPlayerId !== localPlayerId) return null
  if (!isCpuLocalState(session.state, localPlayerId)) return null
  return session
}

function buildSharePath(roomSlug: string, role: RoomRole): string {
  const join = role === 'guest' ? '&join=1' : ''
  return `/${roomSlug}?players=2${join}`
}

function buildPingToken(playerId: string): string {
  return `${playerId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
}

function toPlacementCardKey(card: { rank: string; suit: string }): string {
  return `${card.rank}${card.suit}`
}

function buildInitialPlacementActionId(input: {
  gameId: string
  playerId: string
  card: { rank: string; suit: string }
  target: keyof GameState['lines'][string]
}): string {
  return `initial-place:${input.gameId}:${input.playerId}:${toPlacementCardKey(input.card)}:${input.target}`
}

function buildPlayPlacementActionId(input: {
  gameId: string
  playerId: string
  card: { rank: string; suit: string }
  target: keyof GameState['lines'][string]
}): string {
  return `play-place:${input.gameId}:${input.playerId}:${toPlacementCardKey(input.card)}:${input.target}`
}

function formatSigned(value: number): string {
  if (value > 0) return `+${value}`
  return `${value}`
}

function scoreClass(value: number): string {
  if (value > 0) return 'score-positive'
  if (value < 0) return 'score-negative'
  return ''
}

const RULES_SECTIONS: Array<{ title: string; bullets: string[] }> = [
  {
    title: 'Goal',
    bullets: [
      'Build three poker rows over 13 cards: Top (3), Middle (5), Bottom (5).',
      'Your hand must be ordered Bottom >= Middle >= Top in poker strength.',
      'Beat your opponent row-by-row to win points.'
    ]
  },
  {
    title: 'Round Flow',
    bullets: [
      'Each player starts with 5 cards and places all 5.',
      'Then cards arrive one at a time until all 13 are placed.',
      'No moving cards after they are placed.'
    ]
  },
  {
    title: 'Fouls',
    bullets: [
      'If your final rows are out of order, your hand fouls.',
      'A fouled hand loses the matchup for that round.'
    ]
  },
  {
    title: 'Scoring Basics',
    bullets: [
      'Compare Top vs Top, Middle vs Middle, Bottom vs Bottom.',
      'Win more rows than your opponent to score positive points.',
      'Row bonuses (royalties) and sweep bonuses can apply.'
    ]
  },
  {
    title: 'Hand Rankings',
    bullets: [
      'Royal Flush: A-K-Q-J-10, same suit (in this app it pays as Straight Flush: Bottom +15, Middle +30).',
      'Straight Flush: Five consecutive cards, same suit (Bottom +15, Middle +30).',
      'Four of a Kind: Four cards of the same rank (Bottom +10, Middle +20).',
      'Full House: Three of a kind plus a pair (Bottom +6, Middle +12).',
      'Flush: Five cards of the same suit, not consecutive (Bottom +4, Middle +8).',
      'Straight: Five consecutive cards, mixed suits allowed (Bottom +2, Middle +4).',
      'Three of a Kind: Three cards of the same rank (Top only: 222=+10 through AAA=+22, Middle +2).',
      'Two Pair: Two different pairs plus one kicker (no royalty on Top/Middle/Bottom).',
      'One Pair: Two cards of the same rank plus kickers (Top only: 66=+1 through AA=+9).',
      'High Card: No made hand; highest cards break ties (no royalty).'
    ]
  },
  {
    title: 'Dealer / Restart',
    bullets: [
      'Dealer button alternates each round.',
      'Dealer starts the next round; if dealer is offline, takeover unlocks after 10s.'
    ]
  }
]

export default function App() {
  const roomStore = useMemo(() => createRoomStore(), [])
  const knownDeck = useMemo(() => buildDeck(), [])
  const [view, setView] = useState<View>('lobby')
  const [gameMode, setGameMode] = useState<GameMode>('online')
  const [playerCount, setPlayerCount] = useState(2)
  const [playerName, setPlayerName] = useState(() => readLocalPlayerName())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [scoreboardOpen, setScoreboardOpen] = useState(false)
  const rulesModalRef = useRef<HTMLElement>(null)
  const scoreboardModalRef = useRef<HTMLElement>(null)
  const settingsModalRef = useRef<HTMLElement>(null)
  useFocusTrap(rulesModalRef, rulesOpen)
  useFocusTrap(scoreboardModalRef, scoreboardOpen)
  useFocusTrap(settingsModalRef, settingsOpen)
  const [scoreboardEntries, setScoreboardEntries] = useState<ScoreboardEntry[]>([])
  const [fourColorDeck, setFourColorDeck] = useState(true)
  const [manualConfirmInitialPlacements, setManualConfirmInitialPlacements] = useState(() =>
    readManualConfirmInitialPlacements()
  )
  const [cpuProfile, setCpuProfile] = useState<StrategyProfile>(() => readCpuProfile())
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
  const actionCounter = useMemo(() => ({ value: 0 }), [])
  const localSeedRef = useMemo(() => ({ value: '' }), [])
  const useCrypto = false

  const roomSlugRef = useRef<string | null>(null)
  const stateRef = useRef<GameState | null>(null)
  const autoJoinRef = useRef(false)
  const nameBroadcastTimerRef = useRef<number | null>(null)
  const autoDrawRef = useRef('')
  const autoInitialPlacementRef = useRef('')
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
  const activeGameIdRef = useRef<string | null>(null)
  const activeActionsVersionRef = useRef(0)
  const cpuPlannerTimeoutRef = useRef<number | null>(null)
  const cpuPlannerKeyRef = useRef('')
  const roomReadyRef = useRef(false)
  const outboundActionQueueRef = useRef<QueuedOutboundAction[]>([])
  const outboundFlushInFlightRef = useRef(false)
  const localJoinedAtRef = useRef<number | undefined>(undefined)
  const lastPresenceWriteAtRef = useRef(0)
  const presenceWriteTimerRef = useRef<number | null>(null)
  const pendingPresenceUpdateRef = useRef<PresenceUpdateInput | null>(null)
  const presenceWriteInFlightRef = useRef(false)

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

  const queueOutboundAction = useCallback((action: GameAction, gameId: string | null) => {
    if (outboundActionQueueRef.current.some((entry) => entry.action.id === action.id)) return
    outboundActionQueueRef.current.push({ action, gameId })
  }, [])

  const flushOutboundQueue = useCallback(
    (roomId: string) => {
      if (!roomReadyRef.current) return
      if (outboundFlushInFlightRef.current) return
      if (outboundActionQueueRef.current.length === 0) return
      outboundFlushInFlightRef.current = true
      const queued = [...outboundActionQueueRef.current]
      outboundActionQueueRef.current = []
      const run = async () => {
        for (const entry of queued) {
          const expectedGameId = entry.gameId ?? activeGameIdRef.current
          if (!expectedGameId) {
            queueOutboundAction(entry.action, null)
            continue
          }
          try {
            await roomStore.appendAction({
              roomId,
              actorId: localPlayerId,
              action: entry.action,
              expectedGameId
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to append action'
            const suppressMissingRoomError =
              bootstrapInProgressRef.current &&
              bootstrapRoomRef.current === roomId &&
              message.includes('does not exist')
            if (!suppressMissingRoomError) {
              setSyncError(message)
            }
            // Requeue on transient bootstrap races or temporary network errors.
            queueOutboundAction(entry.action, expectedGameId)
          }
        }
      }
      void run().finally(() => {
        outboundFlushInFlightRef.current = false
      })
    },
    [localPlayerId, queueOutboundAction, roomStore]
  )

  const flushPresenceUpdate = useCallback(() => {
    if (presenceWriteInFlightRef.current) return
    const payload = pendingPresenceUpdateRef.current
    if (!payload) return

    const elapsedMs = Date.now() - lastPresenceWriteAtRef.current
    if (elapsedMs < MIN_PRESENCE_WRITE_MS) {
      if (presenceWriteTimerRef.current === null) {
        presenceWriteTimerRef.current = window.setTimeout(() => {
          presenceWriteTimerRef.current = null
          flushPresenceUpdate()
        }, MIN_PRESENCE_WRITE_MS - elapsedMs)
      }
      return
    }

    pendingPresenceUpdateRef.current = null
    presenceWriteInFlightRef.current = true
    lastPresenceWriteAtRef.current = Date.now()
    void roomStore
      .touchPresence(payload)
      .catch((error) => {
        setSyncError(error instanceof Error ? error.message : 'Failed to update room presence')
      })
      .finally(() => {
        presenceWriteInFlightRef.current = false
        if (!pendingPresenceUpdateRef.current) return
        const waitMs = Math.max(0, MIN_PRESENCE_WRITE_MS - (Date.now() - lastPresenceWriteAtRef.current))
        if (presenceWriteTimerRef.current !== null) return
        presenceWriteTimerRef.current = window.setTimeout(() => {
          presenceWriteTimerRef.current = null
          flushPresenceUpdate()
        }, waitMs)
      })
  }, [roomStore])

  const queuePresenceUpdate = useCallback(
    (payload: PresenceUpdateInput) => {
      pendingPresenceUpdateRef.current = payload
      flushPresenceUpdate()
    },
    [flushPresenceUpdate]
  )

  const applySnapshot = useCallback(
    (snapshot: RoomSnapshot) => {
      const previousGameId = activeGameIdRef.current
      const incomingGameId = snapshot.meta?.currentGameId ?? null
      roomReadyRef.current = Boolean(snapshot.meta)
      activeGameIdRef.current = incomingGameId
      activeActionsVersionRef.current = snapshot.meta?.actionsVersion ?? 0
      const now = Date.now()
      const participantMap: Record<string, ParticipantPresence> = {}
      snapshot.participants.forEach((participant) => {
        if (participant.playerId === WAITING_OPPONENT_ID) return
        participantMap[participant.playerId] = participant
      })
      setParticipantPresenceById(participantMap)
      const localPresence = participantMap[localPlayerId]
      if (localPresence?.joinedAt) {
        localJoinedAtRef.current = localPresence.joinedAt
      }

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
        queuePresenceUpdate({
          roomId: snapshot.roomId,
          playerId: localPlayerId,
          playerName,
          role: roomRole,
          joinedAt: localJoinedAtRef.current,
          pingToken: latestPingTokenRef.current || undefined,
          pingAt: latestPingAtRef.current || undefined,
          ackForPeerPingToken: peerPresence.pingToken,
          ackAt: now
        })
      }

      const hydrated = hydrateRoomState({
        localPlayerId,
        localPlayerName: playerName,
        localRole: roomRole,
        participants: snapshot.participants,
        actionRecords: snapshot.actions,
        initialDealerSeat: snapshot.meta?.dealerSeat ?? snapshot.gameState?.dealerSeat
      })
      const resolvedState = resolveIncomingState({
        hydratedState: hydrated.state,
        persistedState: snapshot.gameState,
        droppedActionCount: hydrated.droppedActionIds.length
      })
      setConnectedPeers(hydrated.connectedPeerIds)

      const signature = `${snapshot.roomId}|${snapshot.meta?.currentGameId ?? 'none'}|${
        snapshot.gameState?.actionLog.length ?? -1
      }|${hydrated.connectedPeerIds.join(',')}|${hydrated.actionLog.map((action) => action.id).join(',')}`
      if (signature === lastHydrationSignatureRef.current) {
        flushOutboundQueue(snapshot.roomId)
        return
      }
      lastHydrationSignatureRef.current = signature

      if (resolvedState) {
        const shouldIgnore = shouldIgnoreRegressiveSnapshot({
          previousGameId,
          incomingGameId,
          currentActionCount: stateRef.current?.actionLog.length ?? 0,
          incomingActionCount: resolvedState.actionLog.length
        })
        if (shouldIgnore) {
          flushOutboundQueue(snapshot.roomId)
          return
        }
        actionCounter.value = seedActionCounterFromLog(resolvedState.actionLog, localPlayerId, actionCounter.value)
        setState(resolvedState)
        if (snapshot.gameStateIncluded && !snapshot.gameState) {
          void roomStore
            .upsertGameState(snapshot.roomId, resolvedState, snapshot.meta?.currentGameId)
            .catch(() => undefined)
        }
        flushOutboundQueue(snapshot.roomId)
      } else {
        setState(null)
      }

      const bootstrapElapsedMs = now - bootstrapStartedAtRef.current
      const bootstrapMatchesRoom =
        bootstrapInProgressRef.current && bootstrapRoomRef.current === snapshot.roomId
      const suppressDroppedWarnings = bootstrapMatchesRoom && bootstrapElapsedMs <= BOOTSTRAP_WARNING_GRACE_MS
      const authoritativeSnapshot = snapshot.gameStateIncluded
      if (bootstrapMatchesRoom && (hydrated.droppedActionIds.length === 0 || bootstrapElapsedMs > BOOTSTRAP_WARNING_GRACE_MS)) {
        bootstrapInProgressRef.current = false
        bootstrapRoomRef.current = null
      }

      if (hydrated.droppedActionIds.length > 0) {
        if (!suppressDroppedWarnings && authoritativeSnapshot) {
          setSyncError(`Dropped invalid actions: ${hydrated.droppedActionIds.join(', ')}`)
        } else {
          setSyncError((current) =>
            current && current.startsWith('Dropped invalid actions:') ? null : current
          )
        }
      } else {
        setSyncError((current) =>
          current && current.startsWith('Dropped invalid actions:') ? null : current
        )
      }
    },
    [actionCounter, flushOutboundQueue, localPlayerId, playerName, queuePresenceUpdate, roomRole, roomStore]
  )

  const returnToLobby = useCallback(() => {
    const activeRoom = roomSlugRef.current
    if (activeRoom) {
      void roomStore.leaveRoom(activeRoom, localPlayerId).catch(() => undefined)
      clearRoomCache(activeRoom)
    }
    roomSlugRef.current = null
    setRoomSlug(null)
    setGameMode('online')
    setState(null)
    setConnectedPeers([])
    setParticipantPresenceById({})
    setConnectivityByPlayerId({ [localPlayerId]: true })
    setWaitingMessage(null)
    setView('lobby')
    setJoining(false)
    setSyncError(null)
    clearCpuLocalSession()
    lastHydrationSignatureRef.current = ''
    latestPingTokenRef.current = ''
    latestPingAtRef.current = 0
    latestAckAtRef.current = 0
    acknowledgedPeerPingRef.current = ''
    lastPersistedStateSignatureRef.current = ''
    bootstrapInProgressRef.current = false
    bootstrapRoomRef.current = null
    bootstrapStartedAtRef.current = 0
    activeGameIdRef.current = null
    activeActionsVersionRef.current = 0
    cpuPlannerKeyRef.current = ''
    if (cpuPlannerTimeoutRef.current !== null) {
      window.clearTimeout(cpuPlannerTimeoutRef.current)
      cpuPlannerTimeoutRef.current = null
    }
    roomReadyRef.current = false
    outboundActionQueueRef.current = []
    outboundFlushInFlightRef.current = false
    localJoinedAtRef.current = undefined
    lastPresenceWriteAtRef.current = 0
    pendingPresenceUpdateRef.current = null
    presenceWriteInFlightRef.current = false
    if (presenceWriteTimerRef.current !== null) {
      window.clearTimeout(presenceWriteTimerRef.current)
      presenceWriteTimerRef.current = null
    }
  }, [localPlayerId, roomStore])

  const dispatchAndSync = useCallback(
    (action: GameAction) => {
      dispatchAction(action)
      if (gameMode === 'cpu_local') return
      const activeRoom = roomSlugRef.current
      if (!activeRoom) return
      queueOutboundAction(action, activeGameIdRef.current)
      if (!roomReadyRef.current) return
      flushOutboundQueue(activeRoom)
    },
    [dispatchAction, flushOutboundQueue, gameMode, queueOutboundAction]
  )

  const dispatchBatchAndSync = useCallback(
    (actions: GameAction[]) => {
      dispatchActions(actions)
      if (gameMode === 'cpu_local') return
      const activeRoom = roomSlugRef.current
      if (!activeRoom) return
      actions.forEach((action) => queueOutboundAction(action, activeGameIdRef.current))
      if (!roomReadyRef.current) return
      flushOutboundQueue(activeRoom)
    },
    [dispatchActions, flushOutboundQueue, gameMode, queueOutboundAction]
  )

  const startCpuGame = useCallback(async () => {
    const previousRoom = roomSlugRef.current
    if (previousRoom) {
      await roomStore.leaveRoom(previousRoom, localPlayerId).catch(() => undefined)
      clearRoomCache(previousRoom)
    }

    const session = resolveCpuSessionForLocalPlayer(readCpuLocalSession(), localPlayerId)
    if (!session) {
      clearCpuLocalSession()
    }

    const localPlayer: Player = {
      id: localPlayerId,
      name: playerName,
      seat: 0,
      connected: true,
      ready: false
    }
    const cpuPlayer: Player = {
      id: CPU_BOT_ID,
      name: CPU_BOT_NAME,
      seat: 1,
      connected: true,
      ready: false
    }

    const localState = session ? session.state : initialGameState([localPlayer, cpuPlayer])
    actionCounter.value = seedActionCounterFromLog(localState.actionLog, localPlayerId, session?.actionCounter ?? 0)

    roomSlugRef.current = null
    setRoomSlug(null)
    setGameMode('cpu_local')
    setView('table')
    setRoomRole('host')
    setPlayerCount(2)
    setConnectedPeers([CPU_BOT_ID])
    setParticipantPresenceById({})
    setConnectivityByPlayerId({ [localPlayerId]: true, [CPU_BOT_ID]: true })
    setWaitingMessage(null)
    setSyncError(null)
    setJoining(false)
    setState(localState)

    lastHydrationSignatureRef.current = ''
    lastPersistedStateSignatureRef.current = ''
    latestPingTokenRef.current = ''
    latestPingAtRef.current = 0
    latestAckAtRef.current = 0
    acknowledgedPeerPingRef.current = ''
    bootstrapInProgressRef.current = false
    bootstrapRoomRef.current = null
    bootstrapStartedAtRef.current = 0
    activeGameIdRef.current = null
    activeActionsVersionRef.current = 0
    cpuPlannerKeyRef.current = ''
    if (cpuPlannerTimeoutRef.current !== null) {
      window.clearTimeout(cpuPlannerTimeoutRef.current)
      cpuPlannerTimeoutRef.current = null
    }
    roomReadyRef.current = false
    outboundActionQueueRef.current = []
    outboundFlushInFlightRef.current = false
    localJoinedAtRef.current = undefined
    lastPresenceWriteAtRef.current = 0
    pendingPresenceUpdateRef.current = null
    presenceWriteInFlightRef.current = false
    if (presenceWriteTimerRef.current !== null) {
      window.clearTimeout(presenceWriteTimerRef.current)
      presenceWriteTimerRef.current = null
    }
  }, [actionCounter, localPlayerId, playerName, roomStore])

  const startDatabaseGame = useCallback(
    async (room: string, host: boolean) => {
      const slug = toRoomSlug(room)
      if (!slug) return
      clearCpuLocalSession()
      if (!roomStore.isConfigured) {
        setSyncError('Firebase is not configured. Set VITE_FIREBASE_DATABASE_URL and related env vars.')
        return
      }

      const previousRoom = roomSlugRef.current
      if (previousRoom && previousRoom !== slug) {
        await roomStore.leaveRoom(previousRoom, localPlayerId).catch(() => undefined)
        clearRoomCache(previousRoom)
      }

      setGameMode('online')
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
        localRole: host ? 'host' : 'guest',
        participants: [localPresence],
        actionRecords: []
      })
      setParticipantPresenceById({ [localPlayerId]: localPresence })
      localJoinedAtRef.current = localPresence.joinedAt
      setConnectivityByPlayerId({ [localPlayerId]: true })
      setWaitingMessage('Waiting for opponent to connect...')
      setState(seeded.state)
      setSyncError(null)
      setJoining(true)
      lastHydrationSignatureRef.current = ''
      activeGameIdRef.current = null
      activeActionsVersionRef.current = 0
      roomReadyRef.current = false
      outboundActionQueueRef.current = []
      outboundFlushInFlightRef.current = false
      bootstrapInProgressRef.current = true
      bootstrapRoomRef.current = slug
      bootstrapStartedAtRef.current = Date.now()

      try {
        let snapshot: RoomSnapshot
        let effectiveRole: RoomRole = host ? 'host' : 'guest'
        const cached = loadRoomCache(slug)

        if (cached) {
          const meta = await roomStore.fetchRoomMeta(slug)
          const cacheMatchesSession =
            meta !== null && meta.currentGameId === cached.gameId && meta.actionsVersion >= cached.actionsVersion
          if (meta && cacheMatchesSession) {
            let replayFailed = false
            let replayedState = cached.state
            const replayedActions = [...cached.actions]
            if (meta.actionsVersion > cached.actionsVersion) {
              const remoteActions = sortActionRecords(await roomStore.fetchRoomActions(slug, { gameId: meta.currentGameId }))
              const cachedActionIds = new Set(cached.actions.map((action) => action.id))
              const missingActions = remoteActions.filter((record) => !cachedActionIds.has(record.id))
              for (const record of missingActions) {
                try {
                  replayedState = applyAction(replayedState, record.action)
                  replayedActions.push(record.action)
                } catch {
                  replayFailed = true
                  break
                }
              }
            }

            if (!replayFailed) {
              const joinedSnapshot = await roomStore.joinRoom({
                roomId: slug,
                playerId: localPlayerId,
                playerName,
                role: cached.role,
                includeSnapshot: false
              })
              const localParticipant = joinedSnapshot.participants.find(
                (participant) => participant.playerId === localPlayerId
              )
              if (localParticipant) {
                effectiveRole = localParticipant.role
              } else {
                effectiveRole = cached.role
              }
              const joinedAt = localParticipant?.joinedAt ?? cached.joinedAt
              setRoomRole(effectiveRole)
              const now = Date.now()
              const participantMap: Record<string, ParticipantPresence> = {}
              joinedSnapshot.participants.forEach((participant) => {
                if (participant.playerId === WAITING_OPPONENT_ID) return
                participantMap[participant.playerId] = participant
              })
              setParticipantPresenceById(participantMap)
              localJoinedAtRef.current = joinedAt

              const peerPresence = Object.values(participantMap).find(
                (participant) => participant.playerId !== localPlayerId
              )
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
              setConnectedPeers(
                joinedSnapshot.participants
                  .filter((participant) => participant.playerId !== localPlayerId)
                  .filter((participant) => participant.playerId !== WAITING_OPPONENT_ID)
                  .map((participant) => participant.playerId)
              )

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
                queuePresenceUpdate({
                  roomId: slug,
                  playerId: localPlayerId,
                  playerName,
                  role: effectiveRole,
                  joinedAt: localJoinedAtRef.current,
                  pingToken: latestPingTokenRef.current || undefined,
                  pingAt: latestPingAtRef.current || undefined,
                  ackForPeerPingToken: peerPresence.pingToken,
                  ackAt: now
                })
              }

              roomReadyRef.current = true
              activeGameIdRef.current = meta.currentGameId
              activeActionsVersionRef.current = meta.actionsVersion
              actionCounter.value = seedActionCounterFromLog(replayedActions, localPlayerId, actionCounter.value)
              setState(replayedState)
              setSyncError(null)
              bootstrapInProgressRef.current = false
              bootstrapRoomRef.current = null
              bootstrapStartedAtRef.current = 0
              saveRoomCache(slug, {
                gameId: meta.currentGameId,
                actionsVersion: meta.actionsVersion,
                state: replayedState,
                actions: replayedActions,
                role: effectiveRole,
                joinedAt
              })
              flushOutboundQueue(slug)
              return
            }
          }
        }

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
            clearRoomCache(slug)
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
        activeGameIdRef.current = null
        activeActionsVersionRef.current = 0
        roomReadyRef.current = false
        outboundActionQueueRef.current = []
        outboundFlushInFlightRef.current = false
        localJoinedAtRef.current = undefined
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
    [actionCounter, applySnapshot, flushOutboundQueue, localPlayerId, playerName, queuePresenceUpdate, roomStore]
  )

  const roundRestartDecision = useMemo(
    () =>
      getRoundRestartDecision({
        state,
        localPlayerId,
        connectivityByPlayerId,
        participantPresenceById,
        now: Date.now(),
        takeoverTimeoutMs: ROUND_TAKEOVER_TIMEOUT_MS
      }),
    [connectivityByPlayerId, localPlayerId, participantPresenceById, state]
  )
  const canStartNextRound =
    gameMode === 'cpu_local' && state?.phase === 'score' ? true : roundRestartDecision.canStartNextRound
  const nextRoundLabel =
    gameMode === 'cpu_local' && state?.phase === 'score' ? 'Next Round' : roundRestartDecision.nextRoundLabel
  const nextRoundHint =
    gameMode === 'cpu_local' && state?.phase === 'score' ? null : roundRestartDecision.nextRoundHint

  const resetRoundAndSync = useCallback(() => {
    if (gameMode === 'cpu_local') {
      const current = stateRef.current
      if (!current) return
      dispatchAction({ id: `cpu:reset:${current.actionLog.length}`, type: 'resetRound' })
      setSyncError(null)
      return
    }
    const activeRoom = roomSlugRef.current
    if (!activeRoom) return
    if (!roundRestartDecision.canStartNextRound) {
      setSyncError(roundRestartDecision.nextRoundHint ?? 'Only the dealer can start the next round.')
      return
    }
    const expectedGameId = activeGameIdRef.current
    if (!expectedGameId) {
      setSyncError('Game session is not ready yet. Please retry in a moment.')
      return
    }
    void roomStore
      .resetRoundSession({ roomId: activeRoom, expectedGameId })
      .then((snapshot) => {
        setSyncError(null)
        applySnapshot(snapshot)
      })
      .catch((error) => {
        setSyncError(error instanceof Error ? error.message : 'Failed to reset round')
      })
  }, [applySnapshot, dispatchAction, gameMode, roomStore, roundRestartDecision.canStartNextRound, roundRestartDecision.nextRoundHint])

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    writeLocalPlayerName(playerName)
  }, [playerName])

  useEffect(() => {
    writeCpuProfile(cpuProfile)
  }, [cpuProfile])

  useEffect(() => {
    writeManualConfirmInitialPlacements(manualConfirmInitialPlacements)
  }, [manualConfirmInitialPlacements])

  useEffect(() => {
    if (gameMode !== 'cpu_local' || !state) return
    if (!isCpuLocalState(state, localPlayerId)) return
    const nextActionCounter = seedActionCounterFromLog(state.actionLog, localPlayerId, actionCounter.value)
    actionCounter.value = nextActionCounter
    writeCpuLocalSession({
      version: 1,
      localPlayerId,
      state,
      actionCounter: nextActionCounter,
      savedAt: Date.now()
    })
  }, [actionCounter, gameMode, localPlayerId, state])

  useEffect(() => {
    if (!scoreboardOpen) return
    if (typeof window === 'undefined') return
    const refresh = () => setScoreboardEntries(readScoreboardEntriesFromLocalStorage(window.localStorage))
    refresh()
    const onStorage = () => refresh()
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [scoreboardOpen])

  useEffect(() => {
    if (!scoreboardOpen && !rulesOpen && !settingsOpen) return
    if (typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (rulesOpen) {
          setRulesOpen(false)
          return
        }
        if (scoreboardOpen) {
          setScoreboardOpen(false)
          return
        }
        if (settingsOpen) {
          setSettingsOpen(false)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [rulesOpen, scoreboardOpen, settingsOpen])

  useEffect(() => {
    roomSlugRef.current = roomSlug
  }, [roomSlug])

  useEffect(() => {
    pendingPresenceUpdateRef.current = null
    presenceWriteInFlightRef.current = false
    lastPresenceWriteAtRef.current = 0
    if (presenceWriteTimerRef.current !== null) {
      window.clearTimeout(presenceWriteTimerRef.current)
      presenceWriteTimerRef.current = null
    }
  }, [roomSlug])

  useEffect(() => {
    if (roomSlug === null) {
      lastHydrationSignatureRef.current = ''
      lastPersistedStateSignatureRef.current = ''
    }
  }, [roomSlug])

  useEffect(() => {
    if (!roomSlug || !state) return
    const expectedGameId = activeGameIdRef.current
    if (!expectedGameId) return
    saveRoomCache(roomSlug, {
      gameId: expectedGameId,
      actionsVersion: activeActionsVersionRef.current,
      state,
      actions: state.actionLog,
      role: roomRole,
      joinedAt: localJoinedAtRef.current ?? Date.now()
    })
    const signature = `${expectedGameId}:${state.phase}`
    if (lastPersistedStateSignatureRef.current === signature) return
    lastPersistedStateSignatureRef.current = signature
    void roomStore.upsertGameState(roomSlug, state, expectedGameId).catch(() => undefined)
  }, [roomRole, roomSlug, roomStore, state])

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
      queuePresenceUpdate({
        roomId: roomSlug,
        playerId: localPlayerId,
        playerName,
        role: roomRole,
        joinedAt: localJoinedAtRef.current,
        pingToken,
        pingAt,
        ackForPeerPingToken: acknowledgedPeerPingRef.current || undefined,
        ackAt: latestAckAtRef.current || undefined
      })
    }
    void heartbeat()
    const timerId = window.setInterval(heartbeat, HEARTBEAT_MS)
    return () => window.clearInterval(timerId)
  }, [localPlayerId, playerName, queuePresenceUpdate, roomRole, roomSlug])

  useEffect(() => {
    if (autoJoinRef.current) return
    const params = new URLSearchParams(window.location.search)
    const route = resolveRoute(window.location.pathname, params)
    if (route.kind === 'lobby') return
    autoJoinRef.current = true
    if (route.kind === 'cpu') {
      void startCpuGame()
      return
    }
    void startDatabaseGame(route.room, !route.join)
  }, [startCpuGame, startDatabaseGame])

  useEffect(() => {
    if (roomSlug && view !== 'lobby') {
      const url = buildSharePath(roomSlug, roomRole)
      window.history.pushState({ room: roomSlug }, '', url)
    } else if (gameMode === 'cpu_local' && view !== 'lobby') {
      const onCpuRoute = window.location.pathname.toLowerCase() === '/cpu' && window.location.search.length === 0
      if (onCpuRoute) {
        window.history.replaceState({ mode: 'cpu_local' }, '', '/cpu')
      } else {
        window.history.pushState({ mode: 'cpu_local' }, '', '/cpu')
      }
    } else if (view === 'lobby') {
      window.history.pushState({}, '', '/')
    }
  }, [gameMode, roomRole, roomSlug, view])

  useEffect(() => {
    const onPopState = () => {
      const route = resolveRoute(window.location.pathname, new URLSearchParams(window.location.search))
      if (route.kind === 'cpu') {
        void startCpuGame()
        return
      }
      if (route.kind === 'lobby') {
        returnToLobby()
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [returnToLobby, startCpuGame])

  useEffect(() => {
    return () => {
      cpuPlannerKeyRef.current = ''
      if (cpuPlannerTimeoutRef.current !== null) {
        window.clearTimeout(cpuPlannerTimeoutRef.current)
        cpuPlannerTimeoutRef.current = null
      }
      pendingPresenceUpdateRef.current = null
      presenceWriteInFlightRef.current = false
      if (presenceWriteTimerRef.current !== null) {
        window.clearTimeout(presenceWriteTimerRef.current)
        presenceWriteTimerRef.current = null
      }
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
    if (!local || local.ready) return
    const gameId = activeGameIdRef.current
    if (!gameId) return
    const readyActionId = `auto:ready:${gameId}:${localPlayerId}`
    if (state.actionLog.some((action) => action.id === readyActionId)) return
    dispatchAndSync({ id: readyActionId, type: 'ready', playerId: localPlayerId })
  }, [dispatchAndSync, localPlayerId, state])

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
    if (state.commits[localPlayerId]) return
    const gameId = activeGameIdRef.current
    if (!gameId) return
    const commitActionId = `auto:commitSeed:${gameId}:${localPlayerId}`
    if (state.actionLog.some((action) => action.id === commitActionId)) return
    const run = async () => {
      const { seed } = createSeedPair()
      localSeedRef.value = seed
      const commit = await commitSeed(seed)
      dispatchAndSync({ id: commitActionId, type: 'commitSeed', playerId: localPlayerId, commit })
    }
    void run()
  }, [dispatchAndSync, localPlayerId, state, useCrypto])

  useEffect(() => {
    if (!state) return
    if (state.phase !== 'reveal') return
    if (!useCrypto) return
    if (state.reveals[localPlayerId]) return
    if (!localSeedRef.value) return
    const gameId = activeGameIdRef.current
    if (!gameId) return
    const revealActionId = `auto:revealSeed:${gameId}:${localPlayerId}`
    if (state.actionLog.some((action) => action.id === revealActionId)) return
    dispatchAndSync({ id: revealActionId, type: 'revealSeed', playerId: localPlayerId, seed: localSeedRef.value })
  }, [dispatchAndSync, localPlayerId, state, useCrypto])

  useEffect(() => {
    if (!state) return
    if (state.phase !== 'reveal') return
    if (!useCrypto) return
    const gameId = activeGameIdRef.current
    if (!gameId) return
    const allRevealed = state.players.every((player) => Boolean(state.reveals[player.id]))
    if (!allRevealed || state.combinedSeed) return
    const orderedSeeds = [...state.players]
      .sort((a, b) => a.seat - b.seat)
      .map((player) => state.reveals[player.id])
      .filter((seed): seed is string => Boolean(seed))
    if (orderedSeeds.length !== state.players.length) return
    const run = async () => {
      const combined = await combineSeeds(orderedSeeds)
      const combinedId = `auto:setCombinedSeed:${gameId}`
      const startId = `auto:startRound:${gameId}`
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
    const gameId = activeGameIdRef.current
    if (!gameId) return
    const dealerId = state.players.find((player) => player.seat === state.dealerSeat)?.id
    if (dealerId !== localPlayerId) return
    const { seed } = createSeedPair()
    const combinedId = `auto:setCombinedSeed:${gameId}`
    const startId = `auto:startRound:${gameId}`
    if (state.actionLog.some((action) => action.id === startId)) return
    dispatchBatchAndSync([
      { id: combinedId, type: 'setCombinedSeed', seed },
      { id: startId, type: 'startRound' }
    ])
  }, [dispatchBatchAndSync, localPlayerId, state, useCrypto])

  useEffect(() => {
    if (gameMode !== 'cpu_local' || !state) {
      cpuPlannerKeyRef.current = ''
      if (cpuPlannerTimeoutRef.current !== null) {
        window.clearTimeout(cpuPlannerTimeoutRef.current)
        cpuPlannerTimeoutRef.current = null
      }
      return
    }

    const plan = planCpuActions({
      state,
      cpuPlayerId: CPU_BOT_ID,
      knownDeck,
      delayMs: CPU_ACTION_DELAY_MS,
      profile: cpuProfile
    })
    if (!plan) {
      cpuPlannerKeyRef.current = ''
      return
    }

    if (cpuPlannerKeyRef.current === plan.key) return
    cpuPlannerKeyRef.current = plan.key
    if (cpuPlannerTimeoutRef.current !== null) {
      window.clearTimeout(cpuPlannerTimeoutRef.current)
      cpuPlannerTimeoutRef.current = null
    }
    cpuPlannerTimeoutRef.current = window.setTimeout(() => {
      cpuPlannerTimeoutRef.current = null
      dispatchBatchAndSync(plan.actions)
    }, plan.delayMs)
  }, [cpuProfile, dispatchBatchAndSync, gameMode, knownDeck, state])

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
      return
    }
    const current = state.players.find((player) => player.seat === state.turnSeat)
    if (!current || current.id !== localPlayerId || state.turnStage !== 'draw') {
      autoDrawRef.current = ''
    }
  }, [localPlayerId, state])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (!state || state.phase !== 'initial') {
      autoInitialPlacementRef.current = ''
      return
    }
    const myPending = state.pending[localPlayerId]
    if (!myPending || myPending.length === 0) {
      autoInitialPlacementRef.current = ''
      return
    }
    const myLines = state.lines[localPlayerId]
    if (!myLines) {
      autoInitialPlacementRef.current = ''
      return
    }
    if (!roomReadyRef.current) return
    const gameId = activeGameIdRef.current
    if (!gameId) return
    const pendingSignature = myPending.map((card) => `${card.rank}${card.suit}`).join(',')
    const linesSignature = `${myLines.top.length}-${myLines.middle.length}-${myLines.bottom.length}`
    const autoPlacementKey = `${gameId}:${localPlayerId}:${linesSignature}:${pendingSignature}`
    if (autoInitialPlacementRef.current === autoPlacementKey) return
    autoInitialPlacementRef.current = autoPlacementKey

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
    for (let i = 0; i < myPending.length; i += 1) {
      const card = myPending[i]
      const target = rows[i]
      if (!card || !target) break
      actions.push({
        id: buildInitialPlacementActionId({
          gameId,
          playerId: localPlayerId,
          card,
          target
        }),
        type: 'placeCard',
        playerId: localPlayerId,
        card,
        target
      })
    }
    if (actions.length > 0) {
      dispatchBatchAndSync(actions)
    }
  }, [dispatchBatchAndSync, localPlayerId, state])

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
      localRole: roomRole,
      participants: fallbackParticipants,
      actionRecords: []
    }).state
  }, [localPlayerId, participantPresenceById, playerName, roomRole, state, view])

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <a className="brand brand-link" href="/">
            OFC-GPT
          </a>
        </div>
        <div className="header-actions">
          <button
            className="button cpu-cta"
            onClick={() => {
              setRulesOpen(false)
              setScoreboardOpen(false)
              setSettingsOpen(false)
              void startCpuGame()
            }}
          >
            CPU Play
          </button>
          <button
            className="button secondary"
            onClick={() => {
              setScoreboardOpen(false)
              setSettingsOpen(false)
              setRulesOpen(true)
            }}
          >
            Rules
          </button>
          <button
            className="button secondary"
            onClick={() => {
              if (typeof window !== 'undefined') {
                setScoreboardEntries(readScoreboardEntriesFromLocalStorage(window.localStorage))
              }
              setRulesOpen(false)
              setSettingsOpen(false)
              setScoreboardOpen(true)
            }}
          >
            Scoreboard
          </button>
          <button
            className="button secondary"
            onClick={() => {
              setRulesOpen(false)
              setScoreboardOpen(false)
              setSettingsOpen((open) => !open)
            }}
          >
            Settings
          </button>
        </div>
      </header>

      {rulesOpen && (
        <div className="modal-backdrop" onClick={() => setRulesOpen(false)} role="presentation">
          <section
            ref={rulesModalRef}
            className="panel rules-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Open Face Chinese Poker Rules"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-header">
              <h3>Open Face Chinese Poker Rules</h3>
              <button className="settings-close" onClick={() => setRulesOpen(false)} aria-label="Close rules">
                &times;
              </button>
            </div>
            <p className="rules-intro">Quick reference for classic heads-up play used in this app.</p>
            <div className="rules-scroll">
              {RULES_SECTIONS.map((section) => (
                <section key={section.title} className="rules-card">
                  <h4>{section.title}</h4>
                  <ul>
                    {section.bullets.map((bullet) => (
                      <li key={bullet}>{bullet}</li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </section>
        </div>
      )}

      {scoreboardOpen && (
        <div className="modal-backdrop" onClick={() => setScoreboardOpen(false)} role="presentation">
          <section
            ref={scoreboardModalRef}
            className="panel scoreboard-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Scoreboard"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-header">
              <h3>Scoreboard</h3>
              <button className="settings-close" onClick={() => setScoreboardOpen(false)} aria-label="Close scoreboard">
                &times;
              </button>
            </div>
            {scoreboardEntries.length === 0 ? (
              <p className="rivalry-empty">No rivalry scores yet.</p>
            ) : (
              <div className="scoreboard-list">
                {scoreboardEntries.map((entry) => (
                  <div key={entry.opponentId} className="scoreboard-row">
                    <div className="scoreboard-main">
                      <span>{entry.name}</span>
                      <span className={scoreClass(entry.total)}>{formatSigned(entry.total)}</span>
                    </div>
                    <div className="scoreboard-meta">
                      W {entry.wins} • L {entry.losses} • T {entry.ties}
                      {entry.roundsPlayed > 0 && <> • {entry.roundsPlayed} rounds</>}
                    </div>
                    {(entry.streak > 1 || entry.streak < -1 || entry.bestScore !== 0) && (
                      <div className="scoreboard-extra">
                        {entry.streak > 1 && <span className="streak-win">{'\uD83D\uDD25'} {entry.streak} streak</span>}
                        {entry.streak < -1 && <span className="streak-loss">{entry.streak * -1} loss streak</span>}
                        {entry.bestScore > 0 && <span className="scoreboard-best">Best: {formatSigned(entry.bestScore)}</span>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)} role="presentation">
          <section
            ref={settingsModalRef}
            className="panel settings-panel settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-header">
              <h3>Settings</h3>
              <button className="settings-close" onClick={() => setSettingsOpen(false)} aria-label="Close settings">
                &times;
              </button>
            </div>
            <div className="settings-group">
              <div className="settings-group-label">Display</div>
              <label className="setting-field">
                <span>Player Name</span>
                <input value={playerName} onChange={(event) => setPlayerName(event.target.value)} />
              </label>
              <label className="setting-row">
                <input type="checkbox" checked={fourColorDeck} onChange={(event) => setFourColorDeck(event.target.checked)} />
                4-Color Deck
              </label>
            </div>
            <div className="settings-group">
              <div className="settings-group-label">Gameplay</div>
              <label className="setting-field">
                <span>CPU Profile</span>
                <select
                  value={cpuProfile}
                  onChange={(event) => setCpuProfile(event.target.value as StrategyProfile)}
                >
                  {CPU_PROFILE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="setting-row">
                <input
                  type="checkbox"
                  checked={manualConfirmInitialPlacements}
                  onChange={(event) => setManualConfirmInitialPlacements(event.target.checked)}
                />
                Manually confirm initial placements (first 5 cards)
              </label>
            </div>
          </section>
        </div>
      )}

      {syncError && (
        <section className="panel sync-error-panel">
          <p>{syncError}</p>
        </section>
      )}

      {view === 'lobby' ? (
        <Lobby
          onStart={(room, host) => {
            void startDatabaseGame(room, host)
          }}
          rooms={rooms}
          roomsLoading={roomsLoading}
          roomsError={roomsError}
          onJoinListedRoom={(listedRoomId) => {
            void startDatabaseGame(listedRoomId, false)
          }}
          initialRoom={(() => {
            const route = resolveRoute(window.location.pathname, new URLSearchParams(window.location.search))
            return route.kind === 'room' ? route.room : undefined
          })()}
        />
      ) : activeTableState ? (
        <GameTable
          state={activeTableState}
          localPlayerId={localPlayerId}
          roomName={roomSlug ?? undefined}
          connectivityByPlayerId={connectivityByPlayerId}
          waitingMessage={waitingMessage}
          onPlace={(card, target) => {
            const parsedCard = stringToCard(card)
            const gameId = activeGameIdRef.current
            const actionId = gameId
              ? buildPlayPlacementActionId({
                  gameId,
                  playerId: localPlayerId,
                  card: parsedCard,
                  target
                })
              : nextActionId()
            dispatchAndSync({
              id: actionId,
              type: 'placeCard',
              playerId: localPlayerId,
              card: parsedCard,
              target
            })
          }}
          onSubmitInitial={(draft) => {
            const actions: GameAction[] = []
            const gameId = activeGameIdRef.current
            draft.top.forEach((card) => {
              const actionId = gameId
                ? buildInitialPlacementActionId({
                    gameId,
                    playerId: localPlayerId,
                    card,
                    target: 'top'
                  })
                : nextActionId()
              actions.push({ id: actionId, type: 'placeCard', playerId: localPlayerId, card, target: 'top' })
            })
            draft.middle.forEach((card) => {
              const actionId = gameId
                ? buildInitialPlacementActionId({
                    gameId,
                    playerId: localPlayerId,
                    card,
                    target: 'middle'
                  })
                : nextActionId()
              actions.push({ id: actionId, type: 'placeCard', playerId: localPlayerId, card, target: 'middle' })
            })
            draft.bottom.forEach((card) => {
              const actionId = gameId
                ? buildInitialPlacementActionId({
                    gameId,
                    playerId: localPlayerId,
                    card,
                    target: 'bottom'
                  })
                : nextActionId()
              actions.push({ id: actionId, type: 'placeCard', playerId: localPlayerId, card, target: 'bottom' })
            })
            dispatchBatchAndSync(actions)
          }}
          onResetRound={resetRoundAndSync}
          canStartNextRound={canStartNextRound}
          nextRoundLabel={nextRoundLabel}
          nextRoundHint={nextRoundHint}
          manualConfirmInitialPlacements={manualConfirmInitialPlacements}
          mode={gameMode}
          fourColor={fourColorDeck}
        />
      ) : (
        <section className="panel hydrate-panel">
          <h2>Hydrating table...</h2>
          {joining ? (
            <p>Joining room...</p>
          ) : (
            <p>
              Connected {connectedPeers.length + 1} / {playerCount}
            </p>
          )}
        </section>
      )}
    </div>
  )
}
