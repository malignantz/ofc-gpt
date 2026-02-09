import { applyAction } from '../state/reducer'
import { GameAction, GameState, Player, initialGameState } from '../state/gameState'
import { ActionRecord, ParticipantPresence } from './roomStore'
import { WAITING_OPPONENT_ID } from './constants'

export type RoomHydrationResult = {
  state: GameState | null
  actionLog: GameAction[]
  connectedPeerIds: string[]
  droppedActionIds: string[]
}

function sortParticipants(participants: ParticipantPresence[]): ParticipantPresence[] {
  return [...participants].sort((left, right) => {
    if (left.role !== right.role) return left.role === 'host' ? -1 : 1
    if (left.joinedAt !== right.joinedAt) return left.joinedAt - right.joinedAt
    return left.playerId.localeCompare(right.playerId)
  })
}

export function sortActionRecords(records: ActionRecord[]): ActionRecord[] {
  return [...records].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
    return left.id.localeCompare(right.id)
  })
}

export function dedupeActionsById(actions: GameAction[]): GameAction[] {
  const seen = new Set<string>()
  const unique: GameAction[] = []
  for (const action of actions) {
    if (seen.has(action.id)) continue
    seen.add(action.id)
    unique.push(action)
  }
  return unique
}

export function seedActionCounterFromLog(log: Array<{ id: string }>, localPlayerId: string, currentValue: number): number {
  const prefix = `${localPlayerId}-`
  let nextValue = currentValue
  for (const action of log) {
    if (!action.id.startsWith(prefix)) continue
    const suffix = Number.parseInt(action.id.slice(prefix.length), 10)
    if (!Number.isFinite(suffix)) continue
    if (suffix > nextValue) nextValue = suffix
  }
  return nextValue
}

export function hydrateRoomState(input: {
  localPlayerId: string
  localPlayerName: string
  participants: ParticipantPresence[]
  actionRecords: ActionRecord[]
}): RoomHydrationResult {
  const sortedParticipants = sortParticipants(input.participants)
  const connectedPeerIds = sortedParticipants
    .filter((participant) => participant.playerId !== input.localPlayerId)
    .filter((participant) => participant.playerId !== WAITING_OPPONENT_ID)
    .map((participant) => participant.playerId)

  const localParticipant =
    sortedParticipants.find((participant) => participant.playerId === input.localPlayerId) ??
    ({
      playerId: input.localPlayerId,
      name: input.localPlayerName,
      role: 'host',
      joinedAt: 0,
      lastSeenAt: 0
    } satisfies ParticipantPresence)

  const remoteParticipant =
    sortedParticipants.find((participant) => participant.playerId !== input.localPlayerId) ??
    ({
      playerId: WAITING_OPPONENT_ID,
      name: 'Opponent',
      role: localParticipant.role === 'host' ? 'guest' : 'host',
      joinedAt: Number.MAX_SAFE_INTEGER,
      lastSeenAt: 0
    } satisfies ParticipantPresence)

  const participants: ParticipantPresence[] = [localParticipant, remoteParticipant]
    .slice(0, 2)
    .sort((left, right) => {
      if (left.role !== right.role) return left.role === 'host' ? -1 : 1
      if (left.joinedAt !== right.joinedAt) return left.joinedAt - right.joinedAt
      return left.playerId.localeCompare(right.playerId)
    })

  if (participants.length < 2) {
    return { state: null, actionLog: [], connectedPeerIds, droppedActionIds: [] }
  }

  const players: Player[] = participants.slice(0, 2).map((participant, index) => ({
    id: participant.playerId,
    name: participant.playerId === input.localPlayerId ? input.localPlayerName : participant.name,
    seat: index as Player['seat'],
    connected: true,
    ready: false
  }))

  const orderedActions = dedupeActionsById(sortActionRecords(input.actionRecords).map((record) => record.action))
  const droppedActionIds: string[] = []
  let state = initialGameState(players)
  let pending = [...orderedActions]
  let progress = true
  // Retry loop allows causal actions (e.g. startRound after setCombinedSeed) to settle
  // even if records arrive in unstable order for the same timestamp.
  while (pending.length > 0 && progress) {
    progress = false
    const nextPending: GameAction[] = []
    for (const action of pending) {
      try {
        state = applyAction(state, action)
        progress = true
      } catch {
        nextPending.push(action)
      }
    }
    pending = nextPending
  }
  droppedActionIds.push(...pending.map((action) => action.id))

  return {
    state,
    actionLog: state.actionLog,
    connectedPeerIds,
    droppedActionIds
  }
}
