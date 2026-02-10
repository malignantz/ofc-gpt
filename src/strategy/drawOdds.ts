import type { Card, Rank, Suit } from '../engine/cards'
import { cardToString, rankValue, ranks, suits } from '../engine/cards'
import type { LinesState } from '../state/gameState'

export type DrawContext = {
  deckSize: number
  rankCounts: Record<Rank, number>
  suitCounts: Record<Suit, number>
  isLive: (card: Card) => boolean
}

export type DrawContextInput = {
  knownDeck: Card[]
  botLines: LinesState
  botPending: Card[]
  visibleOpponentLines: LinesState
}

function emptyRankCounts(): Record<Rank, number> {
  return {
    '2': 0,
    '3': 0,
    '4': 0,
    '5': 0,
    '6': 0,
    '7': 0,
    '8': 0,
    '9': 0,
    T: 0,
    J: 0,
    Q: 0,
    K: 0,
    A: 0
  }
}

function emptySuitCounts(): Record<Suit, number> {
  return {
    S: 0,
    H: 0,
    D: 0,
    C: 0
  }
}

function combination(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  if (k === 0 || k === n) return 1
  const effectiveK = Math.min(k, n - k)
  let numerator = 1
  let denominator = 1
  for (let i = 1; i <= effectiveK; i += 1) {
    numerator *= n - (effectiveK - i)
    denominator *= i
  }
  return numerator / denominator
}

export function buildDrawContext(input: DrawContextInput): DrawContext {
  const used = new Set<string>()
  const addCards = (cards: Card[]) => {
    for (const card of cards) used.add(cardToString(card))
  }

  addCards(input.botLines.top)
  addCards(input.botLines.middle)
  addCards(input.botLines.bottom)
  addCards(input.botPending)
  addCards(input.visibleOpponentLines.top)
  addCards(input.visibleOpponentLines.middle)
  addCards(input.visibleOpponentLines.bottom)

  const liveCards = input.knownDeck.filter((card) => !used.has(cardToString(card)))
  const rankCounts = emptyRankCounts()
  const suitCounts = emptySuitCounts()

  for (const card of liveCards) {
    rankCounts[card.rank] += 1
    suitCounts[card.suit] += 1
  }

  const liveKeys = new Set(liveCards.map(cardToString))
  return {
    deckSize: liveCards.length,
    rankCounts,
    suitCounts,
    isLive: (card: Card) => liveKeys.has(cardToString(card))
  }
}

export function flushProbability(
  suitedCount: number,
  suitRemaining: number,
  deckSize: number,
  slotsLeft: number
): number {
  if (suitedCount >= 5) return 1
  if (slotsLeft <= 0 || deckSize <= 0) return 0
  const needed = Math.max(0, 5 - suitedCount)
  if (needed > slotsLeft) return 0
  if (suitRemaining <= 0) return 0

  const denominator = combination(deckSize, slotsLeft)
  if (denominator <= 0) return 0

  let probability = 0
  const maxHits = Math.min(slotsLeft, suitRemaining)
  for (let hits = needed; hits <= maxHits; hits += 1) {
    probability +=
      (combination(suitRemaining, hits) * combination(deckSize - suitRemaining, slotsLeft - hits)) /
      denominator
  }
  return Math.min(1, Math.max(0, probability))
}

const RANK_BY_VALUE: Record<number, Rank> = {
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: 'T',
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A'
}

function straightWindows(): number[][] {
  const windows: number[][] = []
  for (let high = 14; high >= 5; high -= 1) {
    windows.push([high, high - 1, high - 2, high - 3, high - 4])
  }
  windows.push([14, 5, 4, 3, 2])
  return windows
}

export function straightOuts(currentRanks: Rank[], context: DrawContext): { outs: number; probability: number } {
  if (context.deckSize <= 0 || currentRanks.length === 0) {
    return { outs: 0, probability: 0 }
  }

  const currentValues = new Set(currentRanks.map((rank) => rankValue(rank)))
  const outRanks = new Set<Rank>()

  for (const window of straightWindows()) {
    const windowSet = new Set(window)
    let subset = true
    for (const value of currentValues) {
      if (!windowSet.has(value)) {
        subset = false
        break
      }
    }
    if (!subset) continue

    const missing = window.filter((value) => !currentValues.has(value))
    if (missing.length !== 1) continue
    const missingRank = RANK_BY_VALUE[missing[0] ?? 0]
    if (!missingRank) continue
    outRanks.add(missingRank)
  }

  let outs = 0
  for (const rank of outRanks) {
    outs += context.rankCounts[rank]
  }

  return {
    outs,
    probability: Math.min(1, outs / context.deckSize)
  }
}

export function pairProbability(_rank: Rank, rankRemaining: number, deckSize: number, slotsLeft: number): number {
  if (slotsLeft <= 0 || deckSize <= 0 || rankRemaining <= 0) return 0
  const safeDraws = combination(deckSize - rankRemaining, slotsLeft)
  const totalDraws = combination(deckSize, slotsLeft)
  if (totalDraws <= 0) return 0
  return Math.min(1, Math.max(0, 1 - safeDraws / totalDraws))
}

export function dominantSuit(cards: Card[]): Suit | null {
  if (cards.length === 0) return null
  const counts = emptySuitCounts()
  for (const card of cards) counts[card.suit] += 1
  let best: Suit = 'S'
  for (const suit of suits) {
    if (counts[suit] > counts[best]) best = suit
  }
  return counts[best] > 0 ? best : null
}

export function distinctRanks(cards: Card[]): Rank[] {
  const seen = new Set<Rank>()
  for (const card of cards) {
    seen.add(card.rank)
  }
  return ranks.filter((rank) => seen.has(rank))
}
