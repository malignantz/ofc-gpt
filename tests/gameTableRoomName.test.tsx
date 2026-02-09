import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { initialGameState, Player } from '../src/state/gameState'
import { GameTable } from '../src/ui/components/GameTable'

const players: Player[] = [
  { id: 'p1', name: 'Host', seat: 0, connected: true, ready: false },
  { id: 'p2', name: 'Guest', seat: 1, connected: true, ready: false }
]

describe('GameTable room name display', () => {
  it('shows room name in table header when provided', () => {
    const html = renderToStaticMarkup(
      <GameTable
        state={initialGameState(players)}
        localPlayerId="p1"
        roomName="wolf-tree-4"
        onPlace={() => undefined}
        onSubmitInitial={() => undefined}
        onResetRound={() => undefined}
      />
    )

    expect(html).toContain('Room: wolf-tree-4')
  })
})

