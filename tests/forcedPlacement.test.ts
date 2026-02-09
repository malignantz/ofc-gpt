import { describe, expect, it } from 'vitest'
import { draftSnapshotSignature, forcedLineFromLengths } from '../src/ui/components/GameTable'

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
