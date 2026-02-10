import { describe, expect, it } from 'vitest'
import {
  draftSnapshotSignature,
  forcedLineFromLengths,
  handRankLabelForDisplay,
  resolvePersistedInitialDraft,
  sortLineCardsForDisplay
} from '../src/ui/components/GameTable'

describe('forced line detection', () => {
  it('returns null when multiple lines still have space', () => {
    expect(
      forcedLineFromLengths({
        top: 2,
        middle: 4,
        bottom: 4
      })
    ).toBeNull()
  })

  it('returns the only line with available slots', () => {
    expect(
      forcedLineFromLengths({
        top: 3,
        middle: 5,
        bottom: 2
      })
    ).toBe('bottom')
  })

  it('returns null when every line is already full', () => {
    expect(
      forcedLineFromLengths({
        top: 3,
        middle: 5,
        bottom: 5
      })
    ).toBeNull()
  })
})

describe('initial draft signature', () => {
  it('is stable for identical card content across new array instances', () => {
    const first = draftSnapshotSignature(
      { top: ['AS'], middle: ['KH'], bottom: ['2C'] },
      ['JD', 'TC']
    )
    const second = draftSnapshotSignature(
      { top: ['AS'], middle: ['KH'], bottom: ['2C'] },
      ['JD', 'TC']
    )
    expect(second).toBe(first)
  })

  it('changes when card placement changes', () => {
    const first = draftSnapshotSignature(
      { top: ['AS'], middle: [], bottom: [] },
      ['KH']
    )
    const second = draftSnapshotSignature(
      { top: [], middle: ['AS'], bottom: [] },
      ['KH']
    )
    expect(second).not.toBe(first)
  })
})

describe('persisted initial draft restoration', () => {
  const authoritativeLines = { top: [], middle: [], bottom: [] as string[] }
  const authoritativePending = ['AS', 'KH', 'QD', 'JC', 'TC']
  const baseSignature = draftSnapshotSignature(authoritativeLines, authoritativePending)

  it('restores a compatible persisted draft for the same round', () => {
    const restored = resolvePersistedInitialDraft({
      persisted: {
        version: 1,
        roundKey: 'round-1',
        baseSignature,
        draftLines: { top: ['AS'], middle: ['KH', 'QD'], bottom: [] },
        draftPending: ['JC', 'TC'],
        savedAt: Date.now()
      },
      roundKey: 'round-1',
      baseSignature,
      authoritativeLines,
      authoritativePending
    })

    expect(restored).toEqual({
      draftLines: { top: ['AS'], middle: ['KH', 'QD'], bottom: [] },
      draftPending: ['JC', 'TC']
    })
  })

  it('rejects persisted drafts from another round', () => {
    const restored = resolvePersistedInitialDraft({
      persisted: {
        version: 1,
        roundKey: 'round-previous',
        baseSignature,
        draftLines: { top: ['AS'], middle: ['KH'], bottom: [] },
        draftPending: ['QD', 'JC', 'TC'],
        savedAt: Date.now()
      },
      roundKey: 'round-current',
      baseSignature,
      authoritativeLines,
      authoritativePending
    })

    expect(restored).toBeNull()
  })

  it('rejects persisted drafts with mismatched card content', () => {
    const restored = resolvePersistedInitialDraft({
      persisted: {
        version: 1,
        roundKey: 'round-1',
        baseSignature,
        draftLines: { top: ['AS'], middle: ['KH'], bottom: [] },
        draftPending: ['QD', 'JC', '9C'],
        savedAt: Date.now()
      },
      roundKey: 'round-1',
      baseSignature,
      authoritativeLines,
      authoritativePending
    })

    expect(restored).toBeNull()
  })
})

describe('line display ordering', () => {
  const ranksOnly = (cards: string[]) => cards.map((card) => card[0]).join('')

  it('orders a one-pair five-card line as pair then kickers', () => {
    const ordered = sortLineCardsForDisplay('middle', ['QS', '4C', 'AD', '4D', '5H'])
    expect(ranksOnly(ordered)).toBe('44AQ5')
  })

  it('orders a straight in sequence', () => {
    const ordered = sortLineCardsForDisplay('middle', ['6S', '2D', '4H', '5C', '3S'])
    expect(ranksOnly(ordered)).toBe('23456')
  })

  it('orders a flush by descending rank', () => {
    const ordered = sortLineCardsForDisplay('bottom', ['2S', 'QS', 'AS', '3S', 'JS'])
    expect(ranksOnly(ordered)).toBe('AQJ32')
  })

  it('does not reorder incomplete lines', () => {
    const cards = ['AS', '2D']
    const ordered = sortLineCardsForDisplay('top', cards)
    expect(ordered).toEqual(cards)
  })
})

describe('line hand-rank labels', () => {
  it('labels one-pair and stronger five-card hands', () => {
    expect(handRankLabelForDisplay('middle', ['QS', '4C', 'AD', '4D', '5H'])).toBe('One Pair')
    expect(handRankLabelForDisplay('middle', ['6S', '2D', '4H', '5C', '3S'])).toBe('Straight')
    expect(handRankLabelForDisplay('bottom', ['2S', 'QS', 'AS', '3S', 'JS'])).toBe('Flush')
  })

  it('omits high-card and incomplete hands', () => {
    expect(handRankLabelForDisplay('middle', ['AS', 'KD', '9C', '7H', '2D'])).toBeNull()
    expect(handRankLabelForDisplay('top', ['AS', 'KD'])).toBeNull()
  })
})
