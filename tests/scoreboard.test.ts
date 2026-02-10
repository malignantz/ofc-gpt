import { describe, expect, it } from 'vitest'
import { extractScoreboardEntries, readScoreboardEntriesFromLocalStorage } from '../src/ui/utils/scoreboard'

describe('scoreboard utils', () => {
  it('sorts entries by absolute total descending', () => {
    const entries = extractScoreboardEntries({
      p1: {
        rivals: {
          a: { opponentId: 'a', name: 'Alpha', total: 12, wins: 2, losses: 1, ties: 0, updatedAt: 10 },
          b: { opponentId: 'b', name: 'Beta', total: -25, wins: 1, losses: 3, ties: 0, updatedAt: 20 },
          c: { opponentId: 'c', name: 'Gamma', total: 7, wins: 2, losses: 2, ties: 1, updatedAt: 30 }
        }
      }
    })

    expect(entries.map((entry) => entry.opponentId)).toEqual(['b', 'a', 'c'])
  })

  it('aggregates duplicate opponents across local players', () => {
    const entries = extractScoreboardEntries({
      p1: {
        rivals: {
          o: { opponentId: 'o', name: 'Opponent', total: 10, wins: 2, losses: 0, ties: 0, updatedAt: 100 }
        }
      },
      p2: {
        rivals: {
          o: { opponentId: 'o', name: 'Opponent', total: -3, wins: 0, losses: 1, ties: 0, updatedAt: 120 }
        }
      }
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      opponentId: 'o',
      total: 7,
      wins: 2,
      losses: 1,
      ties: 0,
      updatedAt: 120
    })
  })

  it('includes CPU opponent entries in scoreboard aggregation', () => {
    const entries = extractScoreboardEntries({
      p1: {
        rivals: {
          __cpu_bot__: {
            opponentId: '__cpu_bot__',
            name: 'CPU',
            total: 11,
            wins: 3,
            losses: 1,
            ties: 0,
            updatedAt: 200
          }
        }
      }
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      opponentId: '__cpu_bot__',
      name: 'CPU',
      total: 11,
      wins: 3,
      losses: 1,
      ties: 0
    })
  })

  it('returns empty array on invalid localStorage payload', () => {
    const entries = readScoreboardEntriesFromLocalStorage({
      getItem: () => '{not-json'
    })
    expect(entries).toEqual([])
  })
})
