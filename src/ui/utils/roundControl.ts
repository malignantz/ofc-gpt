import { GameState } from '../../state/gameState'
import { ParticipantPresence } from '../../sync/roomStore'

export const ROUND_TAKEOVER_TIMEOUT_MS = 10_000

export type RoundRestartDecision = {
  dealerPlayerId: string | null
  isLocalDealer: boolean
  canStartNextRound: boolean
  nextRoundLabel: string
  nextRoundHint: string | null
  takeoverCountdownSeconds: number | null
}

export function getRoundRestartDecision(input: {
  state: GameState | null
  localPlayerId: string
  connectivityByPlayerId?: Record<string, boolean>
  participantPresenceById?: Record<string, ParticipantPresence>
  now?: number
  takeoverTimeoutMs?: number
}): RoundRestartDecision {
  const defaultDecision: RoundRestartDecision = {
    dealerPlayerId: null,
    isLocalDealer: false,
    canStartNextRound: false,
    nextRoundLabel: 'Next Round',
    nextRoundHint: null,
    takeoverCountdownSeconds: null
  }
  const state = input.state
  if (!state || state.phase !== 'score') return defaultDecision

  const dealer = state.players.find((player) => player.seat === state.dealerSeat)
  if (!dealer) {
    return { ...defaultDecision, nextRoundHint: 'Waiting for dealer assignment...' }
  }

  if (dealer.id === input.localPlayerId) {
    return {
      dealerPlayerId: dealer.id,
      isLocalDealer: true,
      canStartNextRound: true,
      nextRoundLabel: 'Next Round',
      nextRoundHint: null,
      takeoverCountdownSeconds: null
    }
  }

  const dealerOnline = input.connectivityByPlayerId?.[dealer.id] ?? false
  if (dealerOnline) {
    return {
      dealerPlayerId: dealer.id,
      isLocalDealer: false,
      canStartNextRound: false,
      nextRoundLabel: 'Next Round',
      nextRoundHint: `Waiting for ${dealer.name} (dealer) to start next round...`,
      takeoverCountdownSeconds: null
    }
  }

  const now = input.now ?? Date.now()
  const timeoutMs = input.takeoverTimeoutMs ?? ROUND_TAKEOVER_TIMEOUT_MS
  const lastSeenAt = input.participantPresenceById?.[dealer.id]?.lastSeenAt ?? 0
  const offlineMs = Math.max(0, now - lastSeenAt)
  if (offlineMs >= timeoutMs) {
    return {
      dealerPlayerId: dealer.id,
      isLocalDealer: false,
      canStartNextRound: true,
      nextRoundLabel: 'Take Over Next Round',
      nextRoundHint: `${dealer.name} is offline.`,
      takeoverCountdownSeconds: 0
    }
  }

  const remainingSeconds = Math.ceil((timeoutMs - offlineMs) / 1000)
  return {
    dealerPlayerId: dealer.id,
    isLocalDealer: false,
    canStartNextRound: false,
    nextRoundLabel: 'Next Round',
    nextRoundHint: `Dealer offline. Take over in ${remainingSeconds}s`,
    takeoverCountdownSeconds: remainingSeconds
  }
}

