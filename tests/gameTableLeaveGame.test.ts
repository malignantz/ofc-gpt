import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Player } from '../src/state/gameState'
import { initialGameState } from '../src/state/gameState'
import { GameTable } from '../src/ui/components/GameTable'

const players: Player[] = [
  { id: 'p1', name: 'Host', seat: 0, connected: true, ready: false },
  { id: 'p2', name: 'CPU', seat: 1, connected: true, ready: false }
]

describe('GameTable leave game control', () => {
  it('renders Leave Game button when callback is provided', () => {
    const html = renderToStaticMarkup(
      createElement(GameTable, {
        state: initialGameState(players),
        localPlayerId: 'p1',
        onPlace: () => undefined,
        onSubmitInitial: () => undefined,
        onResetRound: () => undefined,
        onLeaveGame: () => undefined
      })
    )

    expect(html).toContain('Leave Game')
  })

  it('does not render Leave Game button when callback is omitted', () => {
    const html = renderToStaticMarkup(
      createElement(GameTable, {
        state: initialGameState(players),
        localPlayerId: 'p1',
        onPlace: () => undefined,
        onSubmitInitial: () => undefined,
        onResetRound: () => undefined
      })
    )

    expect(html).not.toContain('Leave Game')
  })
})
