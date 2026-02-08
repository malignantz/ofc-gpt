import { describe, expect, it } from 'vitest'
import { seededRngFromBytes } from '../src/crypto/seededRng'
import { commitSeed, verifyReveal, combineSeeds } from '../src/crypto/commitReveal'

const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])

describe('seededRngFromBytes', () => {
  it('is deterministic for the same bytes', () => {
    const rngA = seededRngFromBytes(bytes)
    const rngB = seededRngFromBytes(bytes)

    const seriesA = [rngA(), rngA(), rngA()]
    const seriesB = [rngB(), rngB(), rngB()]

    expect(seriesA).toEqual(seriesB)
  })
})

describe('commit-reveal helpers', () => {
  it('verifies a reveal against a commit', async () => {
    const seed = 'abcdef'
    const commit = await commitSeed(seed)
    const ok = await verifyReveal(seed, commit)
    expect(ok).toBe(true)
  })

  it('combines seeds deterministically', async () => {
    const a = await combineSeeds(['a', 'b', 'c'])
    const b = await combineSeeds(['a', 'b', 'c'])
    expect(a).toBe(b)
  })
})
