import { Card, rankValue } from './cards'

export type HandRank = {
  category: number
  kickers: number[]
}

export function compareRanks(a: HandRank, b: HandRank): number {
  if (a.category !== b.category) return a.category - b.category
  for (let i = 0; i < Math.max(a.kickers.length, b.kickers.length); i += 1) {
    const diff = (a.kickers[i] ?? 0) - (b.kickers[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function evaluateFive(cards: Card[]): HandRank {
  if (cards.length !== 5) throw new Error('Five cards required')

  const ranks = cards.map((card) => rankValue(card.rank)).sort((a, b) => b - a)
  const suits = cards.map((card) => card.suit)
  const isFlush = new Set(suits).size === 1

  const uniqueRanks = Array.from(new Set(ranks)).sort((a, b) => b - a)
  const counts = rankCounts(ranks)
  const highRank = ranks[0]
  const lowRank = ranks[4]
  if (highRank === undefined || lowRank === undefined) {
    throw new Error('Invalid five-card rank state')
  }

  const isWheel = ranks.toString() === '14,5,4,3,2'
  const isStraight = uniqueRanks.length === 5 && (highRank - lowRank === 4 || isWheel)

  if (isStraight && isFlush) {
    return { category: 8, kickers: [isWheel ? 5 : highRank] }
  }

  const countValues = Object.values(counts).sort((a, b) => b - a)
  const topCount = countValues[0] ?? 0
  const secondCount = countValues[1] ?? 0

  if (topCount === 4) {
    const quad = findRankByCount(counts, 4)
    const kicker = uniqueRanks.find((rank) => rank !== quad) ?? 0
    return { category: 7, kickers: [quad, kicker] }
  }

  if (topCount === 3 && secondCount === 2) {
    const triple = findRankByCount(counts, 3)
    const pair = findRankByCount(counts, 2)
    return { category: 6, kickers: [triple, pair] }
  }

  if (isFlush) {
    return { category: 5, kickers: ranks }
  }

  if (isStraight) {
    return { category: 4, kickers: [isWheel ? 5 : highRank] }
  }

  if (topCount === 3) {
    const triple = findRankByCount(counts, 3)
    const kickers = uniqueRanks.filter((rank) => rank !== triple)
    return { category: 3, kickers: [triple, ...kickers] }
  }

  if (topCount === 2 && secondCount === 2) {
    const pairs = uniqueRanks.filter((rank) => counts[rank] === 2)
    const kicker = uniqueRanks.find((rank) => counts[rank] === 1) ?? 0
    return { category: 2, kickers: [...pairs, kicker] }
  }

  if (topCount === 2) {
    const pair = findRankByCount(counts, 2)
    const kickers = uniqueRanks.filter((rank) => rank !== pair)
    return { category: 1, kickers: [pair, ...kickers] }
  }

  return { category: 0, kickers: ranks }
}

export function evaluateThree(cards: Card[]): HandRank {
  if (cards.length !== 3) throw new Error('Three cards required')

  const ranks = cards.map((card) => rankValue(card.rank)).sort((a, b) => b - a)
  const counts = rankCounts(ranks)
  const countValues = Object.values(counts).sort((a, b) => b - a)
  const topCount = countValues[0] ?? 0

  if (topCount === 3) {
    const topRank = ranks[0]
    if (topRank === undefined) throw new Error('Invalid three-card rank state')
    return { category: 2, kickers: [topRank] }
  }

  if (topCount === 2) {
    const pair = findRankByCount(counts, 2)
    const kicker = findRankByCount(counts, 1)
    return { category: 1, kickers: [pair, kicker] }
  }

  return { category: 0, kickers: ranks }
}

function rankCounts(ranks: number[]): Record<number, number> {
  return ranks.reduce<Record<number, number>>((acc, rank) => {
    acc[rank] = (acc[rank] ?? 0) + 1
    return acc
  }, {})
}

function findRankByCount(counts: Record<number, number>, target: number): number {
  const found = Object.entries(counts).find(([, count]) => count === target)?.[0]
  if (!found) throw new Error(`Expected rank with count ${target}`)
  return Number(found)
}
