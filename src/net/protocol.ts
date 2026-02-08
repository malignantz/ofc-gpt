import { GameAction } from '../state/gameState'

export type NetMessage =
  | { type: 'action'; action: GameAction }
  | { type: 'ack'; actionId: string; receiverId: string }
  | { type: 'syncRequest'; requestId: string }
  | { type: 'syncResponse'; requestId: string; log: GameAction[] }
  | { type: 'presence'; playerId: string }

const NET_MESSAGE_TYPES = new Set<string>(['action', 'ack', 'syncRequest', 'syncResponse', 'presence'])

export function isNetMessage(value: unknown): value is NetMessage {
  return typeof value === 'object' && value !== null && 'type' in value && NET_MESSAGE_TYPES.has((value as { type: string }).type)
}
