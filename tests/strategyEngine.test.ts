import { describe, expect, it } from 'vitest'
import { buildDeck } from '../src/engine/deck'
import { stringToCard } from '../src/engine/cards'
import { chooseInitialPlacement, choosePlayPlacement } from '../src/strategy/placementEngine'

function lines(top: string[], middle: string[], bottom: string[]) {
  return {
    top: top.map(stringToCard),
    middle: middle.map(stringToCard),
    bottom: bottom.map(stringToCard)
  }
}

describe('strategy engine', () => {
  it('returns a legal play target', () => {
    const decision = choosePlayPlacement({
      botLines: lines(['2S'], ['3D', '4C'], ['5H', '6H']),
      botPending: [stringToCard('AS')],
      visibleOpponentLines: lines([], [], []),
      knownDeck: buildDeck(),
      drawIndex: 3,
      signatureSeed: 'play-legal'
    })

    expect(['top', 'middle', 'bottom']).toContain(decision.target)
    expect(decision.byTarget[decision.target]).not.toBeNull()
  })

  it('is deterministic for identical play inputs', () => {
    const input = {
      botLines: lines(['2S'], ['3D', '4C'], ['5H', '6H']),
      botPending: [stringToCard('AS')],
      visibleOpponentLines: lines(['KH'], ['7S', '7D'], ['9C', '9D']),
      knownDeck: buildDeck(),
      drawIndex: 5,
      signatureSeed: 'same-seed'
    }

    const first = choosePlayPlacement(input)
    const second = choosePlayPlacement(input)
    expect(second).toEqual(first)
  })

  it('respects forced-line situations', () => {
    const decision = choosePlayPlacement({
      botLines: lines(['2S', '3S', '4S'], ['2D', '3D', '4D', '5D', '6D'], ['7C', '8C', '9C', 'TC']),
      botPending: [stringToCard('AH')],
      visibleOpponentLines: lines([], [], []),
      knownDeck: buildDeck(),
      drawIndex: 7,
      signatureSeed: 'forced-line'
    })

    expect(decision.target).toBe('bottom')
  })

  it('applies fantasy-pressure profile bonuses to entry-heavy top placements', () => {
    const baseInput = {
      botLines: lines(['QH', 'QD'], ['2D', '3D', '4D', '5D', '6D'], ['7C', '8C', '9C', 'TC']),
      botPending: [stringToCard('QS')],
      visibleOpponentLines: lines([], [], []),
      knownDeck: buildDeck(),
      drawIndex: 9,
      signatureSeed: 'profile-fantasy'
    }

    const conservative = choosePlayPlacement({ ...baseInput, profile: 'conservative_ev' })
    const fantasyPressure = choosePlayPlacement({ ...baseInput, profile: 'fantasy_pressure' })

    expect(conservative.byTarget.top).not.toBeNull()
    expect(fantasyPressure.byTarget.top).not.toBeNull()
    expect((fantasyPressure.byTarget.top ?? Number.NEGATIVE_INFINITY)).toBeGreaterThan(
      conservative.byTarget.top ?? Number.NEGATIVE_INFINITY
    )
  })

  it('scores only legal targets in play decisions', () => {
    const decision = choosePlayPlacement({
      botLines: lines(['2S', '3S', '4S'], ['2D', '3D', '4D', '5D', '6D'], ['7C', '8C', '9C', 'TC']),
      botPending: [stringToCard('AH')],
      visibleOpponentLines: lines([], [], []),
      knownDeck: buildDeck(),
      drawIndex: 8,
      signatureSeed: 'forced-scoring'
    })

    expect(decision.target).toBe('bottom')
    expect(decision.byTarget.bottom).not.toBeNull()
    expect(decision.byTarget.top).toBeNull()
    expect(decision.byTarget.middle).toBeNull()
  })

  it('builds a complete legal initial placement for pending cards', () => {
    const decision = chooseInitialPlacement({
      botLines: lines([], [], []),
      botPending: ['AS', 'KD', 'QH', 'JC', 'TC'].map(stringToCard),
      visibleOpponentLines: lines([], [], []),
      knownDeck: buildDeck(),
      drawIndex: 0,
      signatureSeed: 'initial-place'
    })

    expect(decision.top.length).toBeLessThanOrEqual(3)
    expect(decision.middle.length).toBeLessThanOrEqual(5)
    expect(decision.bottom.length).toBeLessThanOrEqual(5)
    expect(decision.top.length + decision.middle.length + decision.bottom.length).toBe(5)
  })

  it('is deterministic for identical initial inputs', () => {
    const input = {
      botLines: lines(['2S'], ['3D', '4C'], ['5H', '6H']),
      botPending: ['AS', 'KD', 'QH', 'JC', 'TC'].map(stringToCard),
      visibleOpponentLines: lines(['KH'], ['7S', '7D'], ['9C', '9D']),
      knownDeck: buildDeck(),
      drawIndex: 0,
      signatureSeed: 'initial-same-seed'
    }

    const first = chooseInitialPlacement(input)
    const second = chooseInitialPlacement(input)
    expect(second).toEqual(first)
  })

  it('respects constrained initial-placement capacity', () => {
    const decision = chooseInitialPlacement({
      botLines: lines(['AS', 'KS', 'QS'], ['2D', '3D', '4D', '5D', '6D'], ['7C', '8C', '9C', 'TC']),
      botPending: [stringToCard('AH')],
      visibleOpponentLines: lines([], [], []),
      knownDeck: buildDeck(),
      drawIndex: 0,
      signatureSeed: 'initial-constrained'
    })

    expect(decision.top).toHaveLength(3)
    expect(decision.middle).toHaveLength(5)
    expect(decision.bottom).toHaveLength(5)
    expect(decision.bottom.some((card) => card.rank === 'A' && card.suit === 'H')).toBe(true)
  })

  it('keeps initial-placement latency bounded in a standard opening state', () => {
    const started = performance.now()
    chooseInitialPlacement({
      botLines: lines([], [], []),
      botPending: ['AS', 'KD', 'QH', 'JC', 'TC'].map(stringToCard),
      visibleOpponentLines: lines([], [], []),
      knownDeck: buildDeck(),
      drawIndex: 0,
      signatureSeed: 'initial-latency'
    })
    const elapsedMs = performance.now() - started

    expect(elapsedMs).toBeLessThan(1500)
  })
})
