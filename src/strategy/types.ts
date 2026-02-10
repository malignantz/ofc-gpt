import type { Card } from '../engine/cards'
import type { GameAction, GameState, LinesState } from '../state/gameState'

export type StrategyProfile = 'conservative_ev' | 'balanced_ev' | 'fantasy_pressure' | 'heuristic'

export type PlacementTarget = keyof LinesState

export type PlacementDecision = {
  target: PlacementTarget
  utility: number
  byTarget: Record<PlacementTarget, number | null>
}

export type InitialPlacementDecision = {
  top: Card[]
  middle: Card[]
  bottom: Card[]
  utility: number
}

export type PlannerOutput = {
  actions: GameAction[]
  delayMs: number
  key: string
}

export type PlayPlacementInput = {
  botLines: LinesState
  botPending: Card[]
  visibleOpponentLines: LinesState
  knownDeck: Card[]
  drawIndex: number
  signatureSeed: string
  profile?: StrategyProfile
}

export type InitialPlacementInput = {
  botLines: LinesState
  botPending: Card[]
  visibleOpponentLines: LinesState
  knownDeck: Card[]
  drawIndex: number
  signatureSeed: string
  profile?: StrategyProfile
}

export type CpuPlannerInput = {
  state: GameState
  cpuPlayerId: string
  knownDeck: Card[]
  delayMs: number
  profile?: StrategyProfile
}
