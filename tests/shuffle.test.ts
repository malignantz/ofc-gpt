import { describe, expect, it } from 'vitest'
import { buildDeck, shuffle } from '../src/engine/deck'
import { cardToString } from '../src/engine/cards'
import { hexToBytes } from '../src/crypto/hash'
import { seededRngFromBytes } from '../src/crypto/seededRng'

function shuffleWithSeed(seedHex: string) {
  const rng = seededRngFromBytes(hexToBytes(seedHex))
  return shuffle(buildDeck(), rng)
}

function deckToStrings(deck = buildDeck()) {
  return deck.map(cardToString)
}

describe('shuffle', () => {
  it('produces a permutation (no loss or duplicates)', () => {
    const seed = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
    const shuffled = shuffleWithSeed(seed)
    const deckStrings = deckToStrings()
    const shuffledStrings = shuffled.map(cardToString)

    expect(shuffledStrings).toHaveLength(deckStrings.length)
    expect(new Set(shuffledStrings).size).toBe(deckStrings.length)

    const sortedOriginal = [...deckStrings].sort()
    const sortedShuffled = [...shuffledStrings].sort()
    expect(sortedShuffled).toEqual(sortedOriginal)
  })

  it('does not mutate the original deck', () => {
    const seed = 'f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff00112233445566778899aabbccddeeff'
    const deck = buildDeck()
    const before = deckToStrings(deck)
    shuffle(deck, seededRngFromBytes(hexToBytes(seed)))
    const after = deckToStrings(deck)
    expect(after).toEqual(before)
  })

  it('is deterministic for the same seed', () => {
    const seed = '1111111122222222333333334444444455555555666666667777777788888888'
    const a = shuffleWithSeed(seed).map(cardToString)
    const b = shuffleWithSeed(seed).map(cardToString)
    expect(a).toEqual(b)
  })

  it('changes when the seed changes (first 4 bytes differ)', () => {
    const seedA = '01020304aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const seedB = '05060708bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const a = shuffleWithSeed(seedA).map(cardToString)
    const b = shuffleWithSeed(seedB).map(cardToString)
    expect(a).not.toEqual(b)
  })

  it('creates varied top cards across diverse seeds', () => {
    const seeds = [
      '0000000100000000000000000000000000000000000000000000000000000000',
      '0000000200000000000000000000000000000000000000000000000000000000',
      '0000000300000000000000000000000000000000000000000000000000000000',
      '0000000400000000000000000000000000000000000000000000000000000000',
      '0000000500000000000000000000000000000000000000000000000000000000',
      '0000000600000000000000000000000000000000000000000000000000000000',
      '0000000700000000000000000000000000000000000000000000000000000000',
      '0000000800000000000000000000000000000000000000000000000000000000'
    ]

    const topCards = seeds.map((seed) => {
      const topCard = shuffleWithSeed(seed)[0]
      if (!topCard) throw new Error('Shuffled deck is unexpectedly empty')
      return cardToString(topCard)
    })
    const uniqueTop = new Set(topCards).size
    expect(uniqueTop).toBeGreaterThan(1)
  })
})
