import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { stringToCard } from '../src/engine/cards'
import { GameState, initialGameState, Player } from '../src/state/gameState'
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

  it('does not render room label in cpu mode', () => {
    const html = renderToStaticMarkup(
      <GameTable
        state={initialGameState(players)}
        localPlayerId="p1"
        mode="cpu_local"
        onPlace={() => undefined}
        onSubmitInitial={() => undefined}
        onResetRound={() => undefined}
      />
    )

    expect(html).not.toContain('Room:')
    expect(html).not.toContain('status-room')
  })

  it('renders cpu-specific initial waiting text after initial placement submit', () => {
    const html = renderToStaticMarkup(
      <GameTable
        state={initialSubmittedState()}
        localPlayerId="p1"
        mode="cpu_local"
        onPlace={() => undefined}
        onSubmitInitial={() => undefined}
        onResetRound={() => undefined}
      />
    )

    expect(html).toContain('CPU is arranging...')
    expect(html).not.toContain('Waiting for others...')
  })

  it('renders cpu-specific play waiting text on opponent turn', () => {
    const html = renderToStaticMarkup(
      <GameTable
        state={playWaitingState()}
        localPlayerId="p1"
        mode="cpu_local"
        onPlace={() => undefined}
        onSubmitInitial={() => undefined}
        onResetRound={() => undefined}
      />
    )

    expect(html).toContain('CPU is playing...')
    expect(html).not.toContain('Waiting for Guest...')
  })

  it('suppresses reconnecting text in cpu mode', () => {
    const html = renderToStaticMarkup(
      <GameTable
        state={playWaitingState()}
        localPlayerId="p1"
        mode="cpu_local"
        connectivityByPlayerId={{ p1: true, p2: false }}
        onPlace={() => undefined}
        onSubmitInitial={() => undefined}
        onResetRound={() => undefined}
      />
    )

    expect(html).not.toContain('Reconnecting')
  })

  it('keeps online waiting and reconnecting messaging', () => {
    const waitingHtml = renderToStaticMarkup(
      <GameTable
        state={playWaitingState()}
        localPlayerId="p1"
        mode="online"
        onPlace={() => undefined}
        onSubmitInitial={() => undefined}
        onResetRound={() => undefined}
      />
    )
    expect(waitingHtml).toContain('Waiting for Guest...')

    const reconnectingHtml = renderToStaticMarkup(
      <GameTable
        state={playWaitingState()}
        localPlayerId="p1"
        mode="online"
        connectivityByPlayerId={{ p1: true, p2: false }}
        onPlace={() => undefined}
        onSubmitInitial={() => undefined}
        onResetRound={() => undefined}
      />
    )
    expect(reconnectingHtml).toContain('Reconnecting')
  })

  it('shows royalty labels with bonus names', () => {
    const state = scoreState({
      p1: {
        top: ['AS', 'AD', '2C'],
        middle: ['5H', '5D', '5C', '7H', '9S'],
        bottom: ['7S', '8D', '9C', 'TH', 'JS']
      },
      p2: {
        top: ['2S', '3D', '4C'],
        middle: ['2H', '2D', '5C', '7C', '9D'],
        bottom: ['AS', 'KS', 'QS', 'JS', 'TS']
      }
    })

    const html = renderToStaticMarkup(
      <GameTable
        state={state}
        localPlayerId="p1"
        onPlace={() => undefined}
        onSubmitInitial={() => undefined}
        onResetRound={() => undefined}
      />
    )

    expect(html).toContain('Three of a Kind (+2)')
  })

  it('shows foul offender line details', () => {
    const state = scoreState({
      p1: {
        top: ['AS', 'AD', '2C'],
        middle: ['2S', '4D', '6C', '8H', '9S'],
        bottom: ['7S', '8D', '9C', 'TH', 'JS']
      },
      p2: {
        top: ['2S', '3D', '4C'],
        middle: ['5H', '5D', '5C', '7H', '9S'],
        bottom: ['2C', '3C', '5D', '7C', '9D']
      }
    })

    const html = renderToStaticMarkup(
      <GameTable
        state={state}
        localPlayerId="p1"
        onPlace={() => undefined}
        onSubmitInitial={() => undefined}
        onResetRound={() => undefined}
      />
    )

    expect(html).toContain('Foul: Middle')
    expect(html).toContain('Foul: Bottom')
  })

})

function initialSubmittedState(): GameState {
  const state = initialGameState(players)
  state.phase = 'initial'
  state.lines = {
    ...state.lines,
    p1: {
      top: ['AS', 'AD', '2C'].map(stringToCard),
      middle: ['3H', '4D'].map(stringToCard),
      bottom: []
    }
  }
  state.pending = { p1: [], p2: [] }
  return state
}

function playWaitingState(): GameState {
  const state = initialGameState(players)
  state.phase = 'play'
  state.turnSeat = 1
  state.turnStage = 'draw'
  return state
}

function scoreState(linesByPlayer: {
  p1: { top: string[]; middle: string[]; bottom: string[] }
  p2: { top: string[]; middle: string[]; bottom: string[] }
}): GameState {
  const state = initialGameState(players)
  state.phase = 'score'
  state.lines = {
    p1: {
      top: linesByPlayer.p1.top.map(stringToCard),
      middle: linesByPlayer.p1.middle.map(stringToCard),
      bottom: linesByPlayer.p1.bottom.map(stringToCard)
    },
    p2: {
      top: linesByPlayer.p2.top.map(stringToCard),
      middle: linesByPlayer.p2.middle.map(stringToCard),
      bottom: linesByPlayer.p2.bottom.map(stringToCard)
    }
  }
  state.pending = { p1: [], p2: [] }
  return state
}
