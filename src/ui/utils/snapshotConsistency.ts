import { GameState } from '../../state/gameState'

export function shouldIgnoreRegressiveSnapshot(input: {
  previousGameId: string | null
  incomingGameId: string | null
  currentActionCount: number
  incomingActionCount: number
}): boolean {
  if (!input.previousGameId || !input.incomingGameId) return false
  if (input.previousGameId !== input.incomingGameId) return false
  return input.incomingActionCount < input.currentActionCount
}

export function resolveIncomingState(input: {
  hydratedState: GameState | null
  persistedState: GameState | null
  droppedActionCount: number
}): GameState | null {
  const { hydratedState, persistedState, droppedActionCount } = input
  if (droppedActionCount > 0 && persistedState) return persistedState
  if (!persistedState) return hydratedState
  if (!hydratedState) return persistedState
  if (persistedState.actionLog.length >= hydratedState.actionLog.length) {
    return persistedState
  }
  return hydratedState
}
