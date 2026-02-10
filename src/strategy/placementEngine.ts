import { Card, cardToString, rankValue } from '../engine/cards'
import { compareRanks, evaluateFive, evaluateThree } from '../engine/handEval'
import { royaltiesBottom, royaltiesMiddle, royaltiesTop, scoreHeadsUpDetailed } from '../engine/scoring'
import type { LinesState } from '../state/gameState'
import { hashString32, shuffleDeterministic } from './deterministicRng'
import { heuristicInitialPlacement, heuristicPlayPlacement } from './heuristicEngine'
import type {
  InitialPlacementDecision,
  InitialPlacementInput,
  PlacementDecision,
  PlacementTarget,
  PlayPlacementInput
} from './types'

const LINE_LIMITS: Record<PlacementTarget, number> = { top: 3, middle: 5, bottom: 5 }
const TARGET_PRIORITY: PlacementTarget[] = ['bottom', 'middle', 'top']
const N_PLAY_ROLLOUTS = 96
const N_INITIAL_ROLLOUTS = 24
const BEAM_WIDTH = 40
const FINALISTS = 24

type UtilitySummary = {
  utility: number
  mean: number
  stdDev: number
  foulRate: number
}

type BeamNode = {
  lines: LinesState
  heuristic: number
}

function cloneLines(lines: LinesState): LinesState {
  return {
    top: [...lines.top],
    middle: [...lines.middle],
    bottom: [...lines.bottom]
  }
}

function cardKey(card: Card): string {
  return cardToString(card)
}

function lineCardCount(lines: LinesState): number {
  return lines.top.length + lines.middle.length + lines.bottom.length
}

function linesComplete(lines: LinesState): boolean {
  return (
    lines.top.length === LINE_LIMITS.top &&
    lines.middle.length === LINE_LIMITS.middle &&
    lines.bottom.length === LINE_LIMITS.bottom
  )
}

function legalTargets(lines: LinesState): PlacementTarget[] {
  return TARGET_PRIORITY.filter((target) => lines[target].length < LINE_LIMITS[target])
}

function withPlacedCard(lines: LinesState, target: PlacementTarget, card: Card): LinesState {
  const next = cloneLines(lines)
  next[target] = [...next[target], card]
  return next
}

function weightedKickerScore(values: number[]): number {
  return values.reduce((acc, value, index) => acc + value / (index + 1), 0)
}

function rankHistogram(cards: Card[]): Map<string, number> {
  const counts = new Map<string, number>()
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
  for (const [, count] of counts.entries()) {
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

function orderingPenalty(lines: LinesState): number {
  let penalty = 0
  if (lines.top.length === LINE_LIMITS.top && lines.middle.length === LINE_LIMITS.middle) {
    const topVsMiddle = compareRanks(evaluateThree(lines.top), evaluateFive(lines.middle))
    if (topVsMiddle > 0) penalty += 100
  }
  if (lines.middle.length === LINE_LIMITS.middle && lines.bottom.length === LINE_LIMITS.bottom) {
    const middleVsBottom = compareRanks(evaluateFive(lines.middle), evaluateFive(lines.bottom))
    if (middleVsBottom > 0) penalty += 100
  }
  return penalty
}

function softOrderingPenalty(lines: LinesState): number {
  let penalty = 0
  if (lines.top.length === LINE_LIMITS.top && lines.middle.length < LINE_LIMITS.middle) {
    const topRank = evaluateThree(lines.top)
    penalty += topRank.category * 8
  }
  if (lines.middle.length === LINE_LIMITS.middle && lines.bottom.length < LINE_LIMITS.bottom) {
    const middleRank = evaluateFive(lines.middle)
    penalty += middleRank.category * 7
  }
  return penalty
}

function greedyPlacementScore(lines: LinesState, target: PlacementTarget, card: Card): number {
  if (lines[target].length >= LINE_LIMITS[target]) return Number.NEGATIVE_INFINITY
  const next = withPlacedCard(lines, target, card)
  const before = lineStrengthScore(lines, target)
  const after = lineStrengthScore(next, target)
  const lineBias = target === 'bottom' ? 3 : target === 'middle' ? 1 : 0
  const hardPenalty = orderingPenalty(next)
  const softPenalty = softOrderingPenalty(next)
  return after - before + lineBias - hardPenalty - softPenalty
}

function chooseGreedyTarget(lines: LinesState, card: Card, seedKey: string): PlacementTarget | null {
  const targets = legalTargets(lines)
  if (targets.length === 0) return null
  let bestTarget: PlacementTarget | null = null
  let bestScore = Number.NEGATIVE_INFINITY
  let bestTie = Number.MAX_SAFE_INTEGER
  for (const target of targets) {
    const score = greedyPlacementScore(lines, target, card)
    const tie = hashString32(`${seedKey}:${target}`)
    if (score > bestScore || (score === bestScore && tie < bestTie)) {
      bestScore = score
      bestTarget = target
      bestTie = tie
    }
  }
  return bestTarget
}

function completeLinesGreedy(base: LinesState, cards: Card[], seedKey: string): LinesState {
  const lines = cloneLines(base)
  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i]
    if (!card) continue
    const target = chooseGreedyTarget(lines, card, `${seedKey}:${i}`)
    if (!target) break
    lines[target] = [...lines[target], card]
  }
  return lines
}

function buildUnknownPool(input: {
  knownDeck: Card[]
  botLines: LinesState
  botPending: Card[]
  visibleOpponentLines: LinesState
}): Card[] {
  const used = new Set<string>()
  const addCards = (cards: Card[]) => {
    for (const card of cards) {
      used.add(cardKey(card))
    }
  }
  addCards(input.botLines.top)
  addCards(input.botLines.middle)
  addCards(input.botLines.bottom)
  addCards(input.botPending)
  addCards(input.visibleOpponentLines.top)
  addCards(input.visibleOpponentLines.middle)
  addCards(input.visibleOpponentLines.bottom)
  return input.knownDeck.filter((card) => !used.has(cardKey(card)))
}

function linesSignature(lines: LinesState): string {
  return `${lines.top.map(cardKey).join(',')}|${lines.middle.map(cardKey).join(',')}|${lines.bottom.map(cardKey).join(',')}`
}

function simulateRollout(input: {
  botStart: LinesState
  opponentStart: LinesState
  unknownPool: Card[]
  seed: string
}): { total: number; foul: boolean } {
  const botNeeded = Math.max(0, 13 - lineCardCount(input.botStart))
  const oppNeeded = Math.max(0, 13 - lineCardCount(input.opponentStart))
  const required = botNeeded + oppNeeded
  if (required > input.unknownPool.length) {
    return { total: -120, foul: true }
  }

  const shuffled = shuffleDeterministic(input.unknownPool, hashString32(input.seed))
  const botFuture = shuffled.slice(0, botNeeded)
  const oppFuture = shuffled.slice(botNeeded, botNeeded + oppNeeded)

  const botFinal = completeLinesGreedy(input.botStart, botFuture, `${input.seed}:bot`)
  const oppFinal = completeLinesGreedy(input.opponentStart, oppFuture, `${input.seed}:opp`)

  if (!linesComplete(botFinal) || !linesComplete(oppFinal)) {
    return { total: -120, foul: true }
  }

  const detailed = scoreHeadsUpDetailed(botFinal, oppFinal)
  return { total: detailed.player.total, foul: detailed.fouls.player }
}

function computeUtility(input: {
  botCandidate: LinesState
  visibleOpponentLines: LinesState
  unknownPool: Card[]
  rollouts: number
  seedPrefix: string
}): UtilitySummary {
  const sampleCount = Math.max(1, input.rollouts)
  let sum = 0
  let sumSquares = 0
  let foulCount = 0

  for (let i = 0; i < sampleCount; i += 1) {
    const simulation = simulateRollout({
      botStart: input.botCandidate,
      opponentStart: input.visibleOpponentLines,
      unknownPool: input.unknownPool,
      seed: `${input.seedPrefix}:${i}`
    })
    sum += simulation.total
    sumSquares += simulation.total * simulation.total
    if (simulation.foul) foulCount += 1
  }

  const mean = sum / sampleCount
  const variance = Math.max(0, sumSquares / sampleCount - mean * mean)
  const stdDev = Math.sqrt(variance)
  const foulRate = foulCount / sampleCount
  const utility = mean - 0.3 * stdDev - foulRate * 40
  return { utility, mean, stdDev, foulRate }
}

function fallbackTarget(lines: LinesState): PlacementTarget {
  return legalTargets(lines)[0] ?? 'top'
}

export function choosePlayPlacement(input: PlayPlacementInput): PlacementDecision {
  if (input.profile === 'heuristic') {
    return heuristicPlayPlacement(input)
  }

  const botCard = input.botPending[0]
  const byTarget: Record<PlacementTarget, number | null> = { top: null, middle: null, bottom: null }
  if (!botCard) {
    return {
      target: fallbackTarget(input.botLines),
      utility: -100,
      byTarget
    }
  }

  const legal = legalTargets(input.botLines)
  if (legal.length === 0) {
    return {
      target: 'top',
      utility: -100,
      byTarget
    }
  }

  const unknownPool = buildUnknownPool(input)
  let bestTarget = legal[0] ?? 'top'
  let bestUtility = Number.NEGATIVE_INFINITY

  for (const target of legal) {
    const candidate = withPlacedCard(input.botLines, target, botCard)
    const utility = computeUtility({
      botCandidate: candidate,
      visibleOpponentLines: input.visibleOpponentLines,
      unknownPool,
      rollouts: N_PLAY_ROLLOUTS,
      seedPrefix: `${input.signatureSeed}:play:${target}:${input.drawIndex}`
    }).utility
    byTarget[target] = utility
    if (utility > bestUtility) {
      bestUtility = utility
      bestTarget = target
    }
  }

  if (!Number.isFinite(bestUtility)) {
    bestTarget = fallbackTarget(input.botLines)
    bestUtility = -100
  }

  return {
    target: bestTarget,
    utility: bestUtility,
    byTarget
  }
}

function buildFallbackInitial(lines: LinesState, pending: Card[]): InitialPlacementDecision {
  const placed = cloneLines(lines)
  for (const card of pending) {
    const target = fallbackTarget(placed)
    placed[target] = [...placed[target], card]
  }
  return {
    top: placed.top,
    middle: placed.middle,
    bottom: placed.bottom,
    utility: -100
  }
}

export function chooseInitialPlacement(input: InitialPlacementInput): InitialPlacementDecision {
  if (input.profile === 'heuristic') {
    return heuristicInitialPlacement(input)
  }

  if (input.botPending.length === 0) {
    return {
      top: [...input.botLines.top],
      middle: [...input.botLines.middle],
      bottom: [...input.botLines.bottom],
      utility: 0
    }
  }

  let beam: BeamNode[] = [{ lines: cloneLines(input.botLines), heuristic: 0 }]
  for (let cardIndex = 0; cardIndex < input.botPending.length; cardIndex += 1) {
    const card = input.botPending[cardIndex]
    if (!card) continue

    const expanded: BeamNode[] = []
    for (const node of beam) {
      const targets = legalTargets(node.lines)
      for (const target of targets) {
        const nextLines = withPlacedCard(node.lines, target, card)
        const nextHeuristic = node.heuristic + greedyPlacementScore(node.lines, target, card)
        expanded.push({ lines: nextLines, heuristic: nextHeuristic })
      }
    }

    if (expanded.length === 0) {
      return buildFallbackInitial(input.botLines, input.botPending)
    }

    expanded.sort((left, right) => {
      if (right.heuristic !== left.heuristic) return right.heuristic - left.heuristic
      return linesSignature(left.lines).localeCompare(linesSignature(right.lines))
    })
    beam = expanded.slice(0, BEAM_WIDTH)
  }

  const finalists = beam.slice(0, FINALISTS)
  if (finalists.length === 0) {
    return buildFallbackInitial(input.botLines, input.botPending)
  }

  const unknownPool = buildUnknownPool(input)
  let bestNode = finalists[0]
  let bestUtility = Number.NEGATIVE_INFINITY

  for (let i = 0; i < finalists.length; i += 1) {
    const finalist = finalists[i]
    if (!finalist) continue
    const evaluation = computeUtility({
      botCandidate: finalist.lines,
      visibleOpponentLines: input.visibleOpponentLines,
      unknownPool,
      rollouts: N_INITIAL_ROLLOUTS,
      seedPrefix: `${input.signatureSeed}:initial:${input.drawIndex}:${i}`
    })
    if (evaluation.utility > bestUtility) {
      bestUtility = evaluation.utility
      bestNode = finalist
    }
  }

  if (!Number.isFinite(bestUtility)) {
    return buildFallbackInitial(input.botLines, input.botPending)
  }
  if (!bestNode) {
    return buildFallbackInitial(input.botLines, input.botPending)
  }

  return {
    top: [...bestNode.lines.top],
    middle: [...bestNode.lines.middle],
    bottom: [...bestNode.lines.bottom],
    utility: bestUtility
  }
}
