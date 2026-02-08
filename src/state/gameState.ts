import { Card } from '../engine/cards'

export type Seat = 0 | 1 | 2 | 3

export type Player = {
  id: string
  name: string
  seat: Seat
  connected: boolean
  ready: boolean
}

export type LinesState = {
  top: Card[]
  middle: Card[]
  bottom: Card[]
}

export type GameState = {
  players: Player[]
  phase: 'lobby' | 'commit' | 'reveal' | 'initial' | 'play' | 'score'
  actionLog: GameAction[]
  lines: Record<string, LinesState>
  pending: Record<string, Card[]>
  commits: Record<string, string>
  reveals: Record<string, string>
  combinedSeed?: string
  deck: Card[]
  drawOrder: Card[]
  drawIndex: number
  dealerSeat: Seat
  turnSeat: Seat
  turnStage: 'draw' | 'place'
}

export type GameAction =
  | ({ id: string; type: 'ready'; playerId: string })
  | ({ id: string; type: 'setName'; playerId: string; name: string })
  | ({ id: string; type: 'commitSeed'; playerId: string; commit: string })
  | ({ id: string; type: 'revealSeed'; playerId: string; seed: string })
  | ({ id: string; type: 'setCombinedSeed'; seed: string })
  | ({ id: string; type: 'startRound' })
  | ({ id: string; type: 'resetRound' })
  | ({ id: string; type: 'placeCard'; playerId: string; card: Card; target: keyof LinesState })
  | ({ id: string; type: 'drawCard'; playerId: string })
  | ({ id: string; type: 'syncRequest'; playerId: string })
  | ({ id: string; type: 'syncResponse'; playerId: string; log: GameAction[] })

export const emptyLines = (): LinesState => ({ top: [], middle: [], bottom: [] })

export function initialGameState(players: Player[]): GameState {
  const lines: Record<string, LinesState> = {}
  const pending: Record<string, Card[]> = {}
  const normalizedPlayers = players.map((player) => ({
    ...player,
    ready: player.ready ?? false
  }))
  normalizedPlayers.forEach((player) => {
    lines[player.id] = emptyLines()
    pending[player.id] = []
  })

  return {
    players: normalizedPlayers,
    phase: 'lobby',
    actionLog: [],
    lines,
    pending,
    commits: {},
    reveals: {},
    deck: [],
    drawOrder: [],
    drawIndex: 0,
    dealerSeat: 0,
    turnSeat: 0,
    turnStage: 'draw'
  }
}
