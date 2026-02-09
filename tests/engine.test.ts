import { describe, expect, it } from 'vitest'
import { buildDeck } from '../src/engine/deck'
import { dealClassicOFC } from '../src/engine/deal'
import { stringToCard } from '../src/engine/cards'
import { analyzeFoul, isFoul } from '../src/engine/validation'
import { royaltiesBottom, royaltiesMiddle, royaltiesTop, scoreHeadsUp, scoreHeadsUpDetailed } from '../src/engine/scoring'

const seed = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

describe('dealClassicOFC', () => {
  it('deals 5 cards per player and returns round draw order', () => {
    const deck = buildDeck()
    const { hands, drawOrder } = dealClassicOFC(deck, seed, 3)

    expect(hands).toHaveLength(3)
    hands.forEach((hand) => expect(hand).toHaveLength(5))
    expect(drawOrder).toHaveLength(3 * 8)
  })

  it('is deterministic for the same seed', () => {
    const deck = buildDeck()
    const a = dealClassicOFC(deck, seed, 2)
    const b = dealClassicOFC(deck, seed, 2)
    const aFirst = a.hands[0]
    const bFirst = b.hands[0]
    if (!aFirst || !bFirst) throw new Error('Expected first hand for both deals')

    expect(aFirst.map((card) => card.rank + card.suit)).toEqual(bFirst.map((card) => card.rank + card.suit))
  })
})

describe('foul detection', () => {
  it('detects a foul when top beats middle', () => {
    const foul = isFoul({
      top: ['AS', 'AD', '2C'].map(stringToCard),
      middle: ['2S', '4D', '6C', '8H', '9S'].map(stringToCard),
      bottom: ['7S', '8D', '9C', 'TH', 'JS'].map(stringToCard)
    })

    expect(foul).toBe(true)
  })

  it('accepts proper ordering', () => {
    const ok = isFoul({
      top: ['2S', '3D', '4C'].map(stringToCard),
      middle: ['2H', '2D', '5C', '7H', '9S'].map(stringToCard),
      bottom: ['AS', 'KS', 'QS', 'JS', 'TS'].map(stringToCard)
    })

    expect(ok).toBe(false)
  })

  it('treats incomplete lines as foul', () => {
    const foul = isFoul({
      top: ['2S', '3D', '4C'].map(stringToCard),
      middle: ['2H', '2D', '5C', '7H'].map(stringToCard),
      bottom: ['AS', 'KS', 'QS', 'JS', 'TS'].map(stringToCard)
    })

    expect(foul).toBe(true)
  })

  it('identifies middle as offending when top outranks middle', () => {
    const analysis = analyzeFoul({
      top: ['AS', 'AD', '2C'].map(stringToCard),
      middle: ['2S', '4D', '6C', '8H', '9S'].map(stringToCard),
      bottom: ['7S', '8D', '9C', 'TH', 'JS'].map(stringToCard)
    })

    expect(analysis.isFoul).toBe(true)
    expect(analysis.offenderLines).toEqual(['middle'])
    expect(analysis.topBeatsMiddle).toBe(true)
    expect(analysis.middleBeatsBottom).toBe(false)
  })

  it('identifies bottom as offending when middle outranks bottom', () => {
    const analysis = analyzeFoul({
      top: ['2S', '3D', '4C'].map(stringToCard),
      middle: ['5H', '5D', '5C', '7H', '9S'].map(stringToCard),
      bottom: ['2C', '3C', '5D', '7C', '9D'].map(stringToCard)
    })

    expect(analysis.isFoul).toBe(true)
    expect(analysis.offenderLines).toEqual(['bottom'])
    expect(analysis.topBeatsMiddle).toBe(false)
    expect(analysis.middleBeatsBottom).toBe(true)
  })
})

describe('scoring', () => {
  it('scores a sweep', () => {
    const player = {
      top: ['AS', 'AD', 'AC'].map(stringToCard),
      middle: ['2S', '3S', '4S', '5S', '6S'].map(stringToCard),
      bottom: ['KS', 'QS', 'JS', 'TS', '9S'].map(stringToCard)
    }
    const opponent = {
      top: ['2S', '3D', '4C'].map(stringToCard),
      middle: ['2H', '2D', '5C', '7H', '9S'].map(stringToCard),
      bottom: ['2C', '3C', '4C', '8D', '9D'].map(stringToCard)
    }

    const result = scoreHeadsUp(player, opponent)
    expect(result.player.base).toBe(6)
  })

  it('awards top royalties for pair and trips', () => {
    const pair = royaltiesTop(['AS', 'AD', '2C'].map(stringToCard))
    const trips = royaltiesTop(['7S', '7D', '7C'].map(stringToCard))
    expect(pair).toBeGreaterThan(0)
    expect(trips).toBeGreaterThan(pair)
  })

  it('awards middle and bottom royalties by category', () => {
    const middle = royaltiesMiddle(['2S', '3S', '4S', '5S', '6S'].map(stringToCard))
    const bottom = royaltiesBottom(['2S', '3S', '4S', '5S', '6S'].map(stringToCard))
    expect(middle).toBeGreaterThan(bottom)
  })

  it('returns detailed line comparisons and royalties by line', () => {
    const player = {
      top: ['AS', 'AD', '2C'].map(stringToCard),
      middle: ['2S', '3S', '4S', '5S', '6S'].map(stringToCard),
      bottom: ['9S', 'TS', 'JS', 'QS', 'KS'].map(stringToCard)
    }
    const opponent = {
      top: ['2H', '3D', '4C'].map(stringToCard),
      middle: ['2D', '2C', '5D', '7C', '9D'].map(stringToCard),
      bottom: ['AS', 'KS', 'QS', 'JS', '9S'].map(stringToCard)
    }

    const detailed = scoreHeadsUpDetailed(player, opponent)
    expect(detailed.lines).toEqual({ top: 1, middle: 1, bottom: 1 })
    expect(detailed.sweep).toBe(true)
    expect(detailed.player.base).toBe(6)
    expect(detailed.player.royaltiesByLine).toEqual({ top: 9, middle: 30, bottom: 15, total: 54 })
    expect(detailed.opponent.royaltiesByLine).toEqual({ top: 0, middle: 0, bottom: 4, total: 4 })
    expect(detailed.player.royalties).toBe(50)
    expect(detailed.player.total).toBe(56)
  })

  it('keeps scoreHeadsUp totals compatible with detailed foul handling', () => {
    const player = {
      top: ['AS', 'AD', 'AC'].map(stringToCard),
      middle: ['2S', '4D', '6C', '8H', '9S'].map(stringToCard),
      bottom: ['7S', '8D', '9C', 'TH', 'JS'].map(stringToCard)
    }
    const opponent = {
      top: ['2S', '3D', '4C'].map(stringToCard),
      middle: ['2H', '2D', '5C', '7H', '9S'].map(stringToCard),
      bottom: ['AS', 'KS', 'QS', 'JS', 'TS'].map(stringToCard)
    }

    const detailed = scoreHeadsUpDetailed(player, opponent)
    const simple = scoreHeadsUp(player, opponent)

    expect(detailed.fouls).toEqual({ player: true, opponent: false })
    expect(detailed.lines).toEqual({ top: -1, middle: -1, bottom: -1 })
    expect(detailed.sweep).toBe(true)
    expect(detailed.player.total).toBe(simple.player.total)
    expect(detailed.player.base).toBe(simple.player.base)
    expect(detailed.player.royalties).toBe(simple.player.royalties)
    expect(detailed.opponent.total).toBe(simple.opponent.total)
  })
})
