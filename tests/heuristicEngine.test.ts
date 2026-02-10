import { describe, expect, it } from 'vitest'
import { stringToCard } from '../src/engine/cards'
import { buildDeck } from '../src/engine/deck'
import { chooseInitialPlacement, choosePlayPlacement } from '../src/strategy/placementEngine'

function lines(top: string[], middle: string[], bottom: string[]) {
  return {
    top: top.map(stringToCard),
    middle: middle.map(stringToCard),
    bottom: bottom.map(stringToCard)
  }
}

describe('heuristic engine', () => {
  it('avoids avoidable fouls', () => {
    const decision = choosePlayPlacement({
      botLines: lines(['QH', 'QS'], ['2C', '5D', '7H', '9S', 'JD'], ['AH', 'AC', '3S', '4D']),
      botPending: [stringToCard('QD')],
      visibleOpponentLines: lines([], [], []),
      knownDeck: buildDeck(),
      drawIndex: 7,
      signatureSeed: 'heuristic-foul-avoid',
      profile: 'heuristic'
    })

    expect(decision.target).toBe('bottom')
    expect(decision.byTarget.top).toBe(Number.NEGATIVE_INFINITY)
  })

  it('completes top royalties when safely available', () => {
    const decision = choosePlayPlacement({
      botLines: lines(['QH', '2S'], ['AH', 'AD', '3C', '7D', '9S'], ['2C', '5C', '8D', 'KH']),
      botPending: [stringToCard('QS')],
      visibleOpponentLines: lines([], [], []),
      knownDeck: buildDeck(),
      drawIndex: 3,
      signatureSeed: 'heuristic-top-royalty',
      profile: 'heuristic'
    })

    expect(decision.target).toBe('top')
  })

  it('finishes a made flush in middle when the card fits', () => {
    const decision = choosePlayPlacement({
      botLines: lines(['2D'], ['3S', '7S', 'TS', 'KS'], ['AH', 'AD', 'AC', '2H', '2S']),
      botPending: [stringToCard('AS')],
      visibleOpponentLines: lines([], [], []),
      knownDeck: buildDeck(),
      drawIndex: 5,
      signatureSeed: 'heuristic-flush-finish',
      profile: 'heuristic'
    })

    expect(decision.target).toBe('middle')
  })

  it('protects ordering by avoiding aggressive top pairs without support', () => {
    const decision = choosePlayPlacement({
      botLines: lines(['KH', '2C'], ['3D', '5S', '7H', '9C'], ['AH', 'AD', 'AC', '2H', '2S']),
      botPending: [stringToCard('KS')],
      visibleOpponentLines: lines([], [], []),
      knownDeck: buildDeck(),
      drawIndex: 8,
      signatureSeed: 'heuristic-order-safety',
      profile: 'heuristic'
    })

    expect(decision.target).toBe('middle')
  })

  it('handles forced placements', () => {
    const decision = choosePlayPlacement({
      botLines: lines(['2S', '3S', '4S'], ['2D', '3D', '4D', '5D', '6D'], ['7C', '8C', '9C', 'TC']),
      botPending: [stringToCard('AH')],
      visibleOpponentLines: lines([], [], []),
      knownDeck: buildDeck(),
      drawIndex: 9,
      signatureSeed: 'heuristic-forced',
      profile: 'heuristic'
    })

    expect(decision.target).toBe('bottom')
  })

  it('builds a legal initial placement for all pending cards', () => {
    const decision = chooseInitialPlacement({
      botLines: lines([], [], []),
      botPending: ['AS', 'KS', 'QS', 'JH', '2D'].map(stringToCard),
      visibleOpponentLines: lines([], [], []),
      knownDeck: buildDeck(),
      drawIndex: 0,
      signatureSeed: 'heuristic-initial',
      profile: 'heuristic'
    })

    expect(decision.top.length).toBeLessThanOrEqual(3)
    expect(decision.middle.length).toBeLessThanOrEqual(5)
    expect(decision.bottom.length).toBeLessThanOrEqual(5)
    expect(decision.top.length + decision.middle.length + decision.bottom.length).toBe(5)
  })
})
