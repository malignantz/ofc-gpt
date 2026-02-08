import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { stringToCard } from '../engine/cards'
import { combineSeeds, commitSeed, createSeedPair } from '../crypto/commitReveal'
import { GameAction, GameState, Player, initialGameState } from '../state/gameState'
import { applyAction } from '../state/reducer'
import { Lobby } from './components/Lobby'
import { GameTable } from './components/GameTable'
import { RoomClient } from '../net/roomClient'
import type { NetMessage } from '../net/protocol'
import { toRoomSlug } from './utils/roomNames'

export type View = 'lobby' | 'table'

const LOCAL_PLAYER_ID_KEY = 'ofc:local-player-id'
const LOCAL_PLAYER_NAME_KEY = 'ofc:player-name'
const ACTIVE_GAME_SNAPSHOT_KEY_PREFIX = 'ofc:active-game-v1:'
const RECOVER_GAME_AVAILABLE = false

type ActiveGameSnapshot = {
  localPlayerId: string
  roomSlug: string
  playerCount: number
  expectedPlayers: number
  host: boolean
  state: GameState
  savedAt: number
}

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

function activeGameSnapshotKey(localPlayerId: string): string {
  return `${ACTIVE_GAME_SNAPSHOT_KEY_PREFIX}${localPlayerId}`
}

function readActiveGameSnapshot(localPlayerId: string): ActiveGameSnapshot | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(activeGameSnapshotKey(localPlayerId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as ActiveGameSnapshot
    if (!parsed || parsed.localPlayerId !== localPlayerId || !parsed.roomSlug || !parsed.state) return null
    return parsed
  } catch {
    return null
  }
}

function writeActiveGameSnapshot(localPlayerId: string, snapshot: ActiveGameSnapshot) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(activeGameSnapshotKey(localPlayerId), JSON.stringify(snapshot))
  } catch {
    // Ignore storage write failures.
  }
}

function clearActiveGameSnapshot(localPlayerId: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(activeGameSnapshotKey(localPlayerId))
  } catch {
    // Ignore storage remove failures.
  }
}

export default function App() {
  const [view, setView] = useState<View>('lobby')
  const [playerCount, setPlayerCount] = useState(2)
  const [playerName, setPlayerName] = useState(() => readLocalPlayerName())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [fourColorDeck, setFourColorDeck] = useState(true)
  const [hideSubmitButton, setHideSubmitButton] = useState(false)
  const [recoverGameEnabled, setRecoverGameEnabled] = useState(false)
  const [localPlayerId] = useState(() => getOrCreateLocalPlayerId())
  const [state, setState] = useState<GameState | null>(null)
  const stateRef = useRef<GameState | null>(null)
  const [roomClient, setRoomClient] = useState<RoomClient | null>(null)
  const [connectedPeers, setConnectedPeers] = useState<string[]>([])
  const actionCounter = useMemo(() => ({ value: 0 }), [])
  const localSeedRef = useMemo(() => ({ value: '' }), [])
  const [copiedShare, setCopiedShare] = useState(false)
  const signalingUrl = useMemo(
    () => (import.meta.env.VITE_SIGNALING_URL as string | undefined) ?? 'ws://localhost:8787',
    []
  )
  const autoJoinRef = useRef(false)
  const [roomSlug, setRoomSlug] = useState<string | null>(null)
  const [expectedPlayers, setExpectedPlayers] = useState<number | null>(null)
  const roomSlugRef = useRef<string | null>(null)
  const expectedPlayersRef = useRef<number | null>(null)
  const playerCountRef = useRef(2)
  const viewRef = useRef<View>('lobby')
  const hostRef = useRef(true)
  const recoverGameEnabledRef = useRef(false)
  const pendingNetMessages = useRef<Array<{ fromId: string; message: NetMessage }>>([])
  const readySentRef = useRef(false)
  const commitSentRef = useRef(false)
  const revealSentRef = useRef(false)
  const lastBroadcastNameRef = useRef('')
  const nameBroadcastTimerRef = useRef<number | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const reconnectingRef = useRef(false)
  const autoDrawRef = useRef<string>('')
  const deferredActionsRef = useRef<{ action: GameAction; attempts: number }[]>([])
  const useCrypto = false

  const getParamInsensitive = (params: URLSearchParams, key: string) => {
    const lowered = key.toLowerCase()
    for (const [k, value] of params.entries()) {
      if (k.toLowerCase() === lowered) return value
    }
    return null
  }

  const enqueueDeferred = (action: GameAction) => {
    if (deferredActionsRef.current.some((entry) => entry.action.id === action.id)) return
    deferredActionsRef.current.push({ action, attempts: 0 })
  }

  const dispatchAction = (action: GameAction) => {
    setState((current) => {
      if (!current) return current
      if (current.actionLog.some((entry) => entry.id === action.id)) {
        return current
      }
      try {
        return applyAction(current, action)
      } catch (error) {
        console.warn('[net] Action deferred', action, error)
        enqueueDeferred(action)
        return current
      }
    })
  }

  const dispatchActions = (actions: GameAction[]) => {
    setState((current) => {
      if (!current) return current
      let next = current
      const filtered = actions.filter((action) => !current.actionLog.some((entry) => entry.id === action.id))
      for (const action of filtered) {
        try {
          next = applyAction(next, action)
        } catch (error) {
          console.warn('[net] Action deferred', action, error)
          enqueueDeferred(action)
        }
      }
      return next
    })
  }

  const nextActionId = () => {
    actionCounter.value += 1
    return `${localPlayerId}-${actionCounter.value}`
  }

  const dispatchAndBroadcast = (action: GameAction) => {
    dispatchAction(action)
    roomClient?.send({ type: 'action', action })
  }

  const dispatchBatchAndBroadcast = (actions: GameAction[]) => {
    dispatchActions(actions)
    actions.forEach((action) => roomClient?.send({ type: 'action', action }))
  }

  useEffect(() => {
    writeLocalPlayerName(playerName)
  }, [playerName])

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    roomSlugRef.current = roomSlug
  }, [roomSlug])

  useEffect(() => {
    expectedPlayersRef.current = expectedPlayers
  }, [expectedPlayers])

  useEffect(() => {
    playerCountRef.current = playerCount
  }, [playerCount])

  useEffect(() => {
    viewRef.current = view
  }, [view])

  useEffect(() => {
    recoverGameEnabledRef.current = recoverGameEnabled
  }, [recoverGameEnabled])

  useEffect(() => {
    if (!RECOVER_GAME_AVAILABLE && recoverGameEnabled) {
      setRecoverGameEnabled(false)
    }
  }, [recoverGameEnabled])

  const handleNetworkMessage = useCallback(
    (fromId: string, message: NetMessage) => {
      if (fromId && fromId !== localPlayerId) {
        setConnectedPeers((current) => (current.includes(fromId) ? current : [...current, fromId]))
      }
      const current = stateRef.current
      if (!current) {
        pendingNetMessages.current.push({ fromId, message })
        return
      }
      console.debug('[net] message', fromId, message)
      if (message.type === 'action') {
        dispatchAction(message.action)
        return
      }
      if (message.type === 'syncRequest') {
        console.debug('[net] sync request from', fromId)
        const response: NetMessage = { type: 'syncResponse', requestId: message.requestId, log: current.actionLog }
        roomClient?.sendTo(fromId, response)
        return
      }
      if (message.type === 'syncResponse') {
        console.debug('[net] sync response', message.log.length)
        if (message.log.length > current.actionLog.length) {
          dispatchActions(message.log)
        }
      }
    },
    [localPlayerId, roomClient]
  )

  const startNetworkedGame = (
    room: string,
    host: boolean,
    options?: { restoredState?: GameState | null; expectedPlayersOverride?: number }
  ) => {
    const slug = toRoomSlug(room)
    console.debug('[net] start', { room: slug, host })
    hostRef.current = host
    roomClient?.destroy()
    const client = new RoomClient({
      signalingUrl,
      roomId: slug,
      clientId: localPlayerId,
      onMessage: (fromId, message) => handleNetworkMessage(fromId, message),
      onPeerJoined: (peerId) => {
        console.debug('[net] peer joined', peerId)
        setConnectedPeers((current) => [...new Set([...current, peerId])])
        const requestId = `sync-${localPlayerId}-${Date.now()}`
        client.sendTo(peerId, { type: 'syncRequest', requestId })
      },
      onPeerList: (peerIds) => {
        console.debug('[net] peer list', peerIds)
        setConnectedPeers(peerIds)
        peerIds.forEach((peerId) => {
          const requestId = `sync-${localPlayerId}-${Date.now()}`
          client.sendTo(peerId, { type: 'syncRequest', requestId })
        })
      },
      onPeerConnected: (peerId) => {
        console.debug('[net] peer connected', peerId)
        const requestId = `sync-${localPlayerId}-${Date.now()}`
        client.sendTo(peerId, { type: 'syncRequest', requestId })
      },
      onPeerDisconnected: (peerId) => {
        console.debug('[net] peer disconnected', peerId)
        setConnectedPeers((current) => current.filter((id) => id !== peerId))
      },
      onConnectionError: () => {
        if (viewRef.current !== 'table') return
        if (reconnectingRef.current) return
        reconnectingRef.current = true
        if (reconnectTimerRef.current !== null) {
          window.clearTimeout(reconnectTimerRef.current)
        }
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null
          const snapshot = recoverGameEnabledRef.current ? readActiveGameSnapshot(localPlayerId) : null
          const restored = recoverGameEnabledRef.current
            ? snapshot && snapshot.roomSlug === slug
              ? snapshot.state
              : stateRef.current
            : null
          const targetCount =
            snapshot && snapshot.roomSlug === slug
              ? snapshot.expectedPlayers
              : expectedPlayersRef.current ?? playerCountRef.current
          startNetworkedGame(slug, hostRef.current, {
            restoredState: restored ?? null,
            expectedPlayersOverride: targetCount
          })
          window.setTimeout(() => {
            reconnectingRef.current = false
          }, 0)
        }, 900)
      }
    })
    setRoomClient(client)
    setRoomSlug(slug)
    setExpectedPlayers(options?.expectedPlayersOverride ?? playerCount)
    setConnectedPeers([])
    client.connect(host)
    const bootstrapRequestId = `sync-bootstrap-${localPlayerId}-${Date.now()}`
    client.send({ type: 'syncRequest', requestId: bootstrapRequestId })
    setState(options?.restoredState ?? null)
    setView('table')
  }

  useEffect(() => {
    if (!roomClient) return
    if (state) return
    const allIds = [localPlayerId, ...connectedPeers]
    const targetCount = expectedPlayers ?? playerCount
    console.debug('[net] peers', { allIds, targetCount })
    if (allIds.length < targetCount) return
    const ordered = [...allIds].sort()
    const gamePlayers: Player[] = ordered.map((id, index) => ({
      id,
      name: id === localPlayerId ? playerName : `Player ${index + 1}`,
      seat: index as Player['seat'],
      connected: true,
      ready: false
    }))
    console.debug('[net] game init', ordered)
    setState(initialGameState(gamePlayers))
  }, [connectedPeers, localPlayerId, playerCount, playerName, roomClient, state, expectedPlayers])

  useEffect(() => {
    if (!state) return
    if (pendingNetMessages.current.length === 0) return
    const buffered = [...pendingNetMessages.current]
    pendingNetMessages.current = []
    buffered.forEach(({ fromId, message }) => handleNetworkMessage(fromId, message))
  }, [handleNetworkMessage, state])

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
        } catch (error) {
          const attempts = entry.attempts + 1
          if (attempts < 6) {
            remaining.push({ action: entry.action, attempts })
          } else {
            console.warn('[net] Dropping action after retries', entry.action)
          }
        }
      }
      deferredActionsRef.current = remaining
      return next
    })
  }, [state])

  useEffect(() => {
    if (!recoverGameEnabled) {
      clearActiveGameSnapshot(localPlayerId)
      return
    }
    if (view !== 'table' || !roomSlug || !state) return
    if (state.phase === 'score') {
      clearActiveGameSnapshot(localPlayerId)
      return
    }
    writeActiveGameSnapshot(localPlayerId, {
      localPlayerId,
      roomSlug,
      playerCount,
      expectedPlayers: expectedPlayers ?? playerCount,
      host: hostRef.current,
      state,
      savedAt: Date.now()
    })
  }, [expectedPlayers, localPlayerId, playerCount, recoverGameEnabled, roomSlug, state, view])

  useEffect(() => {
    if (!recoverGameEnabled) return
    if (autoJoinRef.current) return
    const snapshot = readActiveGameSnapshot(localPlayerId)
    if (!snapshot) return
    if (snapshot.state.phase === 'score') {
      clearActiveGameSnapshot(localPlayerId)
      return
    }
    autoJoinRef.current = true
    setPlayerCount(snapshot.playerCount)
    setExpectedPlayers(snapshot.expectedPlayers)
    startNetworkedGame(snapshot.roomSlug, snapshot.host, {
      restoredState: snapshot.state,
      expectedPlayersOverride: snapshot.expectedPlayers
    })
  }, [localPlayerId, recoverGameEnabled])

  useEffect(() => {
    if (autoJoinRef.current) return
    const params = new URLSearchParams(window.location.search)
    const join = getParamInsensitive(params, 'join')
    const playersParam = getParamInsensitive(params, 'players')
    const pathRoom = window.location.pathname.replace(/^\//, '')
    const room = getParamInsensitive(params, 'room') ?? (pathRoom.length > 0 ? decodeURIComponent(pathRoom) : null)
    if (!room) return

    if (playersParam) {
      const count = Number(playersParam)
      if (!Number.isNaN(count)) {
        const normalized = Math.min(4, Math.max(2, count))
        setPlayerCount(normalized)
        setExpectedPlayers(normalized)
        console.debug('[net] auto-join players', normalized)
      }
    }

    const joinFlag = join?.toLowerCase()
    const asJoiner = joinFlag === '1' || joinFlag === 'true'

    autoJoinRef.current = true
    console.debug('[net] auto-start room', room, { asJoiner })
    startNetworkedGame(room, !asJoiner)
  }, [])

  useEffect(() => {
    if (roomSlug && view !== 'lobby') {
      const url = `/${roomSlug}?players=${playerCount}`
      console.debug('[net] pushState', url)
      window.history.pushState({ room: roomSlug }, '', url)
    } else if (view === 'lobby') {
      window.history.pushState({}, '', '/')
    }
  }, [roomSlug, view, playerCount])

  useEffect(() => {
    const onPopState = () => {
      if (window.location.pathname === '/' || window.location.pathname === '') {
        clearActiveGameSnapshot(localPlayerId)
        setView('lobby')
        setRoomSlug(null)
        setRoomClient((prev) => { prev?.destroy(); return null })
        setState(null)
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [localPlayerId])

  useEffect(() => {
    if (!state) return
    if (state.phase !== 'lobby') return
    const local = state.players.find((player) => player.id === localPlayerId)
    if (!local || local.ready || readySentRef.current) return
    readySentRef.current = true
    dispatchAndBroadcast({ id: nextActionId(), type: 'ready', playerId: localPlayerId })
  }, [localPlayerId, state])

  useEffect(() => {
    if (!state) {
      if (nameBroadcastTimerRef.current !== null) {
        window.clearTimeout(nameBroadcastTimerRef.current)
        nameBroadcastTimerRef.current = null
      }
      lastBroadcastNameRef.current = ''
      return
    }
    const local = state.players.find((player) => player.id === localPlayerId)
    if (!local) return
    const shouldBroadcast = local.name !== playerName || lastBroadcastNameRef.current !== playerName
    if (!shouldBroadcast) {
      if (nameBroadcastTimerRef.current !== null) {
        window.clearTimeout(nameBroadcastTimerRef.current)
        nameBroadcastTimerRef.current = null
      }
      return
    }

    if (nameBroadcastTimerRef.current !== null) {
      window.clearTimeout(nameBroadcastTimerRef.current)
    }
    nameBroadcastTimerRef.current = window.setTimeout(() => {
      const current = stateRef.current
      if (!current) return
      const localNow = current.players.find((player) => player.id === localPlayerId)
      if (!localNow) return
      const stillNeedsBroadcast =
        localNow.name !== playerName || lastBroadcastNameRef.current !== playerName
      if (!stillNeedsBroadcast) return

      lastBroadcastNameRef.current = playerName
      dispatchAndBroadcast({
        id: nextActionId(),
        type: 'setName',
        playerId: localPlayerId,
        name: playerName
      })
      nameBroadcastTimerRef.current = null
    }, 1500)

    return () => {
      if (nameBroadcastTimerRef.current !== null) {
        window.clearTimeout(nameBroadcastTimerRef.current)
        nameBroadcastTimerRef.current = null
      }
    }
  }, [localPlayerId, playerName, state])

  useEffect(() => {
    return () => {
      if (nameBroadcastTimerRef.current !== null) {
        window.clearTimeout(nameBroadcastTimerRef.current)
      }
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current)
      }
    }
  }, [])

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
      dispatchAndBroadcast({ id: nextActionId(), type: 'commitSeed', playerId: localPlayerId, commit })
    }
    void run()
  }, [localPlayerId, state])

  useEffect(() => {
    if (!state) return
    if (state.phase !== 'reveal') return
    if (!useCrypto) return
    if (state.reveals[localPlayerId] || revealSentRef.current) return
    if (!localSeedRef.value) return
    revealSentRef.current = true
    dispatchAndBroadcast({ id: nextActionId(), type: 'revealSeed', playerId: localPlayerId, seed: localSeedRef.value })
  }, [localPlayerId, state])

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
      dispatchBatchAndBroadcast([
        { id: combinedId, type: 'setCombinedSeed', seed: combined },
        { id: startId, type: 'startRound' }
      ])
    }
    void run()
  }, [state])

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
    dispatchBatchAndBroadcast([
      { id: combinedId, type: 'setCombinedSeed', seed },
      { id: startId, type: 'startRound' }
    ])
  }, [localPlayerId, state, useCrypto])

  // In peer-symmetric mode, other players act from their own clients.
  useEffect(() => {
    if (!state || state.phase !== 'play') return
    const current = state.players.find((player) => player.seat === state.turnSeat)
    if (!current || current.id !== localPlayerId) return
    if (state.turnStage !== 'draw') return
    const key = `${state.turnSeat}-${state.drawIndex}`
    if (autoDrawRef.current === key) return
    autoDrawRef.current = key
    dispatchAndBroadcast({ id: nextActionId(), type: 'drawCard', playerId: localPlayerId })
  }, [localPlayerId, state])

  useEffect(() => {
    if (!state || state.phase !== 'play') {
      autoDrawRef.current = ''
    }
  }, [state?.phase])

  // Dev-only: auto-place initial 5-card hand randomly across rows
  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (!state || state.phase !== 'initial') return
    const myPending = state.pending[localPlayerId]
    if (!myPending || myPending.length === 0) return
    const myLines = state.lines[localPlayerId]
    if (!myLines) return

    const limits = { top: 3, middle: 5, bottom: 5 } as const
    const remaining = { top: limits.top - myLines.top.length, middle: limits.middle - myLines.middle.length, bottom: limits.bottom - myLines.bottom.length }
    const actions: GameAction[] = []
    const rows: (keyof typeof limits)[] = []
    for (const row of ['bottom', 'middle', 'top'] as const) {
      for (let i = 0; i < remaining[row]; i++) rows.push(row)
    }
    // Shuffle target rows
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[rows[i], rows[j]] = [rows[j]!, rows[i]!]
    }
    for (let i = 0; i < myPending.length; i++) {
      const card = myPending[i]!
      const target = rows[i]
      if (!target) break
      actions.push({ id: nextActionId(), type: 'placeCard', playerId: localPlayerId, card, target })
    }
    if (actions.length > 0) {
      dispatchBatchAndBroadcast(actions)
    }
  }, [localPlayerId, state])

  // Detect broken game state (e.g. server reset) and bail to lobby
  useEffect(() => {
    if (!state) return
    const gamePhases = ['initial', 'play', 'score'] as const
    if (!(gamePhases as readonly string[]).includes(state.phase)) return
    const hasCards = state.deck.length > 0
    const hasAnyPending = state.players.some((p) => (state.pending[p.id]?.length ?? 0) > 0)
    const hasAnyLines = state.players.some((p) => {
      const lines = state.lines[p.id]
      if (!lines) return false
      return lines.top.length > 0 || lines.middle.length > 0 || lines.bottom.length > 0
    })
    if (!hasCards && !hasAnyPending && !hasAnyLines) {
      console.warn('[app] Broken game state detected — no cards in play. Returning to lobby.')
      clearActiveGameSnapshot(localPlayerId)
      roomClient?.destroy()
      setView('lobby')
      setRoomSlug(null)
      setRoomClient(null)
      setState(null)
    }
  }, [localPlayerId, roomClient, state])

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <div className="brand">Open-Face Chinese Poker</div>
          <div className="subtitle">P2P • Serverless • Fair Shuffle</div>
        </div>
        <button className="button secondary" onClick={() => setSettingsOpen((open) => !open)}>
          Settings
        </button>
      </header>

      {settingsOpen && (
        <section className="panel settings-panel">
          <div className="settings-header">
            <h3>Settings</h3>
            <button className="settings-close" onClick={() => setSettingsOpen(false)} aria-label="Close settings">&times;</button>
          </div>
          <label className="setting-field">
            <span>Player Name</span>
            <input value={playerName} onChange={(e) => setPlayerName(e.target.value)} />
          </label>
          <label className="setting-row">
            <input type="checkbox" checked={fourColorDeck} onChange={(e) => setFourColorDeck(e.target.checked)} />
            4-Color Deck
          </label>
          <label className="setting-row">
            <input
              type="checkbox"
              checked={hideSubmitButton}
              onChange={(e) => setHideSubmitButton(e.target.checked)}
            />
            Hide Submit Button (initial)
          </label>
          <label className="setting-row setting-disabled">
            <input
              type="checkbox"
              checked={RECOVER_GAME_AVAILABLE ? recoverGameEnabled : false}
              readOnly
              disabled
            />
            Recover Game (WIP) - Disabled
          </label>
          <label className="setting-row setting-disabled">
            <input type="checkbox" checked={false} readOnly disabled />
            Fair Shuffle (commit–reveal) — WIP
          </label>
        </section>
      )}

      {view === 'lobby' ? (
        <Lobby
          playerCount={playerCount}
          playerName={playerName}
          onPlayerNameChange={setPlayerName}
          onPlayerCountChange={setPlayerCount}
          onStart={(room, host) => startNetworkedGame(room, host)}
          initialRoom={
            getParamInsensitive(new URLSearchParams(window.location.search), 'room') ??
            (window.location.pathname.replace(/^\//, '') || undefined)
          }
        />
      ) : state ? (
        <GameTable
          state={state}
          localPlayerId={localPlayerId}
          onPlace={(card, target) =>
            dispatchAndBroadcast({
              id: nextActionId(),
              type: 'placeCard',
              playerId: localPlayerId,
              card: stringToCard(card),
              target
            })
          }
          onSubmitInitial={(draft) => {
            const actions: GameAction[] = []
            draft.top.forEach((card) =>
              actions.push({ id: nextActionId(), type: 'placeCard', playerId: localPlayerId, card, target: 'top' })
            )
            draft.middle.forEach((card) =>
              actions.push({ id: nextActionId(), type: 'placeCard', playerId: localPlayerId, card, target: 'middle' })
            )
            draft.bottom.forEach((card) =>
              actions.push({ id: nextActionId(), type: 'placeCard', playerId: localPlayerId, card, target: 'bottom' })
            )
            dispatchBatchAndBroadcast(actions)
          }}
          onResetRound={() => dispatchAndBroadcast({ id: nextActionId(), type: 'resetRound' })}
          hideSubmit={hideSubmitButton}
          fourColor={fourColorDeck}
        />
      ) : (
        <section className="panel">
          <h2>Waiting for players...</h2>
          <p>
            Connected {connectedPeers.length + 1} / {playerCount}
          </p>
          <p style={{ marginTop: 12 }}>Share Link</p>
          <div className="share-row">
            <span className="share-link">
              {`${window.location.origin}/${roomSlug ?? ''}?players=${playerCount}&join=1`}
            </span>
            <button
              className="button secondary"
              onClick={() => {
                navigator.clipboard.writeText(
                  `${window.location.origin}/${roomSlug ?? ''}?players=${playerCount}&join=1`
                )
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
