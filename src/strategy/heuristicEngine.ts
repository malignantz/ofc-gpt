import type { Card, Rank } from '../engine/cards'
import { rankValue } from '../engine/cards'
import { compareRanks, evaluateFive, evaluateThree } from '../engine/handEval'
import { royaltiesBottom, royaltiesMiddle, royaltiesTop } from '../engine/scoring'
import type { LinesState } from '../state/gameState'
import { hashString32 } from './deterministicRng'
import {
  buildDrawContext,
  distinctRanks,
  dominantSuit,
  flushProbability,
  pairProbability,
  straightOuts
} from './drawOdds'
import type {
  InitialPlacementDecision,
  InitialPlacementInput,
  PlacementDecision,
  PlacementTarget,
  PlayPlacementInput
} from './types'

const LINE_LIMITS: Record<PlacementTarget, number> = { top: 3, middle: 5, bottom: 5 }
const TARGET_PRIORITY: PlacementTarget[] = ['bottom', 'middle', 'top']
const NO_UTILITY = -100

function cloneLines(lines: LinesState): LinesState {
  return {
    top: [...lines.top],
    middle: [...lines.middle],
    bottom: [...lines.bottom]
  }
}

function legalTargets(lines: LinesState): PlacementTarget[] {
  return TARGET_PRIORITY.filter((target) => lines[target].length < LINE_LIMITS[target])
}

function fallbackTarget(lines: LinesState): PlacementTarget {
  return legalTargets(lines)[0] ?? 'top'
}

function withPlacedCard(lines: LinesState, target: PlacementTarget, card: Card): LinesState {
  const next = cloneLines(lines)
  next[target] = [...next[target], card]
  return next
}

function weightedKickerScore(values: number[]): number {
  return values.reduce((acc, value, index) => acc + value / (index + 1), 0)
}

function rankHistogram(cards: Card[]): Map<Rank, number> {
  const counts = new Map<Rank, number>()
  for (const card of cards) {
    counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1)
  }
  return counts
}

function partialLineHeuristic(cards: Card[]): number {
  let score = 0
  for (const card of cards) {
    score += rankValue(card.rank) * 0.5
  }
  const counts = rankHistogram(cards)
  for (const count of counts.values()) {
    if (count === 2) score += 5
    if (count === 3) score += 12
    if (count === 4) score += 20
  }
  return score
}

function lineStrengthScore(lines: LinesState, line: PlacementTarget): number {
  const cards = lines[line]
  if (line === 'top') {
    if (cards.length !== LINE_LIMITS.top) {
      return partialLineHeuristic(cards)
    }
    const rank = evaluateThree(cards)
    const royalties = royaltiesTop(cards)
    return rank.category * 18 + weightedKickerScore(rank.kickers) + royalties * 3
  }

  if (cards.length !== LINE_LIMITS[line]) {
    return partialLineHeuristic(cards) + (line === 'bottom' ? 2 : 0)
  }

  const rank = evaluateFive(cards)
  const royalties = line === 'middle' ? royaltiesMiddle(cards) : royaltiesBottom(cards)
  const lineBias = line === 'bottom' ? 4 : 2
  return rank.category * 22 + weightedKickerScore(rank.kickers) + royalties * 3 + lineBias
}

function rowRoyalty(line: PlacementTarget, cards: Card[]): number {
  if (line === 'top') return cards.length === 3 ? royaltiesTop(cards) : 0
  if (cards.length !== 5) return 0
  return line === 'middle' ? royaltiesMiddle(cards) : royaltiesBottom(cards)
}

function hardFoul(lines: LinesState): boolean {
  if (lines.top.length === 3 && lines.middle.length === 5) {
    if (compareRanks(evaluateThree(lines.top), evaluateFive(lines.middle)) > 0) {
      return true
    }
  }
  if (lines.middle.length === 5 && lines.bottom.length === 5) {
    if (compareRanks(evaluateFive(lines.middle), evaluateFive(lines.bottom)) > 0) {
      return true
    }
  }
  return false
}

function softFoulPenalty(lines: LinesState): number {
  let penalty = 0

  if (lines.top.length === 3 && lines.middle.length < 5) {
    const topRank = evaluateThree(lines.top)
    if (topRank.category >= 1) {
      const middlePairs = Array.from(rankHistogram(lines.middle).values()).some((count) => count >= 2)
      if (!middlePairs) {
        const topPrimary = topRank.kickers[0] ?? 0
        penalty += 7 + topRank.category * 4 + Math.max(0, topPrimary - 10)
      }
    }
  }

  if (lines.middle.length === 5 && lines.bottom.length < 5) {
    const middleRank = evaluateFive(lines.middle)
    if (middleRank.category >= 2) {
      penalty += 5 + middleRank.category * 2
    }
  }

  return penalty
}

function orderingSafetyPenalty(lines: LinesState): number {
  const top = lineStrengthScore(lines, 'top')
  const middle = lineStrengthScore(lines, 'middle')
  const bottom = lineStrengthScore(lines, 'bottom')

  let penalty = 0
  const topMiddleGap = middle - top
  const middleBottomGap = bottom - middle

  if (topMiddleGap < 0) {
    penalty += 12 + Math.abs(topMiddleGap) * 1.4
  } else if (topMiddleGap < 2) {
    penalty += (2 - topMiddleGap) * 2
  }

  if (middleBottomGap < 0) {
    penalty += 12 + Math.abs(middleBottomGap) * 1.4
  } else if (middleBottomGap < 2) {
    penalty += (2 - middleBottomGap) * 2
  }

  penalty += softFoulPenalty(lines)
  return penalty
}

function rowDrawExpectedValue(line: PlacementTarget, cards: Card[], deckSize: number, context: ReturnType<typeof buildDrawContext>): number {
  if (line === 'top') {
    if (cards.length >= 3 || deckSize <= 0) return rowRoyalty('top', cards)
    const slotsLeft = 3 - cards.length
    const counts = rankHistogram(cards)
    let best = 0
    for (const [rank, count] of counts.entries()) {
      if (count <= 0) continue
      const royalty = Math.max(0, rankValue(rank) - 5)
      if (royalty <= 0) continue
      const probability = pairProbability(rank, context.rankCounts[rank], deckSize, slotsLeft)
      best = Math.max(best, probability * royalty)
    }
    return best
  }

  if (cards.length >= 5 || deckSize <= 0) {
    return rowRoyalty(line, cards)
  }

  const slotsLeft = 5 - cards.length
  const flushRoyalty = line === 'middle' ? 8 : 4
  const straightRoyalty = line === 'middle' ? 4 : 2

  let flushEv = 0
  const suit = dominantSuit(cards)
  if (suit) {
    const suitedCount = cards.filter((card) => card.suit === suit).length
    if (suitedCount >= 3) {
      flushEv = flushProbability(suitedCount, context.suitCounts[suit], deckSize, slotsLeft) * flushRoyalty
    }
  }

  let straightEv = 0
  const ranks = distinctRanks(cards)
  if (ranks.length >= 3) {
    const straight = straightOuts(ranks, context)
    straightEv = straight.probability * straightRoyalty
  }

  return flushEv + straightEv
}

function rowFillBalanceDelta(before: LinesState, after: LinesState, target: PlacementTarget): number {
  const limit = LINE_LIMITS[target]
  const beforeFill = before[target].length / limit
  const afterFill = after[target].length / limit
  let delta = (afterFill - beforeFill) * 1.5

  const otherTargets = TARGET_PRIORITY.filter((line) => line !== target)
  const empties = otherTargets.filter((line) => after[line].length === 0).length
  if (after[target].length === limit && empties > 0) {
    delta -= 1 + empties * 0.5
  }

  return delta
}

function opponentAwarenessDelta(
  before: LinesState,
  after: LinesState,
  opponent: LinesState,
  target: PlacementTarget
): number {
  const oppStrength = lineStrengthScore(opponent, target)
  const beforeDeficit = oppStrength - lineStrengthScore(before, target)
  const afterDeficit = oppStrength - lineStrengthScore(after, target)

  if (beforeDeficit > 0) {
    const improvement = Math.max(0, beforeDeficit - afterDeficit)
    return Math.min(1, improvement / 12)
  }

  if (afterDeficit < beforeDeficit) {
    return 0.2
  }

  return 0
}

function rankDefaultBias(card: Card, target: PlacementTarget): number {
  const value = rankValue(card.rank)
  if (value <= 6) {
    if (target === 'top') return 0.5
    if (target === 'middle') return 0.2
    return 0
  }

  if (value <= 10) {
    if (target === 'middle') return 0.5
    if (target === 'bottom') return 0.2
    return 0.1
  }

  if (target === 'bottom') return 0.5
  if (target === 'middle') return 0.2
  return 0.05
}

function candidateScore(input: {
  base: LinesState
  next: LinesState
  target: PlacementTarget
  card: Card
  opponent: LinesState
  context: ReturnType<typeof buildDrawContext>
}): number {
  if (hardFoul(input.next)) return Number.NEGATIVE_INFINITY

  const royaltyCompletion = rowRoyalty(input.target, input.next[input.target]) - rowRoyalty(input.target, input.base[input.target])

  const drawBefore = rowDrawExpectedValue(input.target, input.base[input.target], input.context.deckSize, input.context)
  const drawAfter = rowDrawExpectedValue(input.target, input.next[input.target], input.context.deckSize, input.context)
  const drawAdvance = drawAfter - drawBefore

  const orderingSafety = orderingSafetyPenalty(input.base) - orderingSafetyPenalty(input.next)
  const fillBalance = rowFillBalanceDelta(input.base, input.next, input.target)
  const opponentAware = opponentAwarenessDelta(input.base, input.next, input.opponent, input.target)
  const rankBias = rankDefaultBias(input.card, input.target)

  return royaltyCompletion + drawAdvance + orderingSafety + fillBalance + opponentAware + rankBias
}

function evaluateStaticLines(lines: LinesState, opponent: LinesState, context: ReturnType<typeof buildDrawContext>): number {
  if (hardFoul(lines)) return Number.NEGATIVE_INFINITY

  const royalties =
    rowRoyalty('top', lines.top) + rowRoyalty('middle', lines.middle) + rowRoyalty('bottom', lines.bottom)

  const drawPotential =
    rowDrawExpectedValue('top', lines.top, context.deckSize, context) +
    rowDrawExpectedValue('middle', lines.middle, context.deckSize, context) +
    rowDrawExpectedValue('bottom', lines.bottom, context.deckSize, context)

  const ordering = -orderingSafetyPenalty(lines)

  const fillScore =
    (lines.top.length / 3) * 1.2 +
    (lines.middle.length / 5) * 1.2 +
    (lines.bottom.length / 5) * 1.2 -
    Math.abs(lines.top.length / 3 - lines.middle.length / 5) * 0.6 -
    Math.abs(lines.middle.length / 5 - lines.bottom.length / 5) * 0.6

  const opponentEdge =
    (lineStrengthScore(lines, 'top') - lineStrengthScore(opponent, 'top')) * 0.015 +
    (lineStrengthScore(lines, 'middle') - lineStrengthScore(opponent, 'middle')) * 0.015 +
    (lineStrengthScore(lines, 'bottom') - lineStrengthScore(opponent, 'bottom')) * 0.015

  return royalties + drawPotential + ordering + fillScore + opponentEdge
}

function compareTargets(
  score: number,
  bestScore: number,
  signatureSeed: string,
  target: PlacementTarget,
  bestTarget: PlacementTarget | null
): boolean {
  if (score > bestScore) return true
  if (score < bestScore) return false
  if (!bestTarget) return true
  const targetTie = hashString32(`${signatureSeed}:${target}`)
  const bestTie = hashString32(`${signatureSeed}:${bestTarget}`)
  return targetTie < bestTie
}

export function heuristicPlayPlacement(input: PlayPlacementInput): PlacementDecision {
  const byTarget: Record<PlacementTarget, number | null> = { top: null, middle: null, bottom: null }
  const card = input.botPending[0]
  if (!card) {
    return {
      target: fallbackTarget(input.botLines),
      utility: NO_UTILITY,
      byTarget
    }
  }

  const legal = legalTargets(input.botLines)
  if (legal.length === 0) {
    return {
      target: 'top',
      utility: NO_UTILITY,
      byTarget
    }
  }

  const context = buildDrawContext({
    knownDeck: input.knownDeck,
    botLines: input.botLines,
    botPending: input.botPending,
    visibleOpponentLines: input.visibleOpponentLines
  })

  let bestTarget: PlacementTarget | null = null
  let bestUtility = Number.NEGATIVE_INFINITY

  for (const target of legal) {
    const next = withPlacedCard(input.botLines, target, card)
    const utility = candidateScore({
      base: input.botLines,
      next,
      target,
      card,
      opponent: input.visibleOpponentLines,
      context
    })
    byTarget[target] = utility

    if (compareTargets(utility, bestUtility, `${input.signatureSeed}:heuristic:${input.drawIndex}`, target, bestTarget)) {
      bestTarget = target
      bestUtility = utility
    }
  }

  if (!bestTarget || !Number.isFinite(bestUtility)) {
    const target = fallbackTarget(input.botLines)
    return {
      target,
      utility: NO_UTILITY,
      byTarget
    }
  }

  return {
    target: bestTarget,
    utility: bestUtility,
    byTarget
  }
}

function enumeratePlacements(lines: LinesState, cards: Card[]): LinesState[] {
  const results: LinesState[] = []

  const visit = (index: number, current: LinesState) => {
    if (index >= cards.length) {
      results.push(cloneLines(current))
      return
    }

    const card = cards[index]
    if (!card) {
      visit(index + 1, current)
      return
    }

    const targets = legalTargets(current)
    for (const target of targets) {
      const next = withPlacedCard(current, target, card)
      visit(index + 1, next)
    }
  }

  visit(0, cloneLines(lines))
  return results
}

export function heuristicInitialPlacement(input: InitialPlacementInput): InitialPlacementDecision {
  if (input.botPending.length === 0) {
    return {
      top: [...input.botLines.top],
      middle: [...input.botLines.middle],
      bottom: [...input.botLines.bottom],
      utility: 0
    }
  }

  const candidates = enumeratePlacements(input.botLines, input.botPending)
  if (candidates.length === 0) {
    return {
      top: [...input.botLines.top],
      middle: [...input.botLines.middle],
      bottom: [...input.botLines.bottom],
      utility: NO_UTILITY
    }
  }

  const context = buildDrawContext({
    knownDeck: input.knownDeck,
    botLines: input.botLines,
    botPending: input.botPending,
    visibleOpponentLines: input.visibleOpponentLines
  })

  let best = candidates[0]
  let bestScore = Number.NEGATIVE_INFINITY
  let bestTie = Number.MAX_SAFE_INTEGER

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i]
    if (!candidate) continue
    const score = evaluateStaticLines(candidate, input.visibleOpponentLines, context)
    const tie = hashString32(`${input.signatureSeed}:heuristic:initial:${input.drawIndex}:${i}`)
    const isBetter =
      score > bestScore || (score === bestScore && tie < bestTie)
    if (isBetter) {
      best = candidate
      bestScore = score
      bestTie = tie
    }
  }

  if (!best || !Number.isFinite(bestScore)) {
    return {
      top: [...input.botLines.top],
      middle: [...input.botLines.middle],
      bottom: [...input.botLines.bottom],
      utility: NO_UTILITY
    }
  }

  return {
    top: [...best.top],
    middle: [...best.middle],
    bottom: [...best.bottom],
    utility: bestScore
  }
}
