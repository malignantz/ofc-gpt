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
  PlayPlacementInput,
  StrategyProfile
} from './types'

const LINE_LIMITS: Record<PlacementTarget, number> = { top: 3, middle: 5, bottom: 5 }
const TARGET_PRIORITY: PlacementTarget[] = ['bottom', 'middle', 'top']
const PLAY_STAGE1_ROLLOUTS = 16
const PLAY_STAGE2_ROLLOUTS = 24
const PLAY_STAGE3_ROLLOUTS = 24
const PLAY_TOP_K = 2

const INITIAL_STAGE1_ROLLOUTS = 4
const INITIAL_STAGE2_ROLLOUTS = 12
const INITIAL_STAGE3_ROLLOUTS = 12
const INITIAL_TOP_K = 24

const ROLLOUT_GAP_THRESHOLD = 1.5

type UtilitySummary = {
  utility: number
  mean: number
  stdDev: number
  foulRate: number
  entrySignal: number
  reentrySignal: number
}

type RolloutStats = {
  samples: number
  sum: number
  sumSquares: number
  foulCount: number
}

type CandidateSpec = {
  key: string
  lines: LinesState
  seedPrefix: string
}

type CandidateEvaluation = CandidateSpec & {
  stats: RolloutStats
  summary: UtilitySummary
}

type UtilityWeights = {
  variancePenalty: number
  foulPenalty: number
  entryBonus: number
  reentryBonus: number
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

function strategyWeights(profile?: StrategyProfile): UtilityWeights {
  // Default profile weights balance raw EV against foul avoidance and fantasyline pressure.
  switch (profile) {
    case 'fantasy_pressure':
      return {
        variancePenalty: 0.25,
        foulPenalty: 34,
        entryBonus: 14,
        reentryBonus: 8
      }
    case 'balanced_ev':
      return {
        variancePenalty: 0.3,
        foulPenalty: 40,
        entryBonus: 9,
        reentryBonus: 5
      }
    case 'conservative_ev':
    default:
      return {
        variancePenalty: 0.35,
        foulPenalty: 44,
        entryBonus: 6,
        reentryBonus: 3
      }
  }
}

function topEntrySignal(cards: Card[]): number {
  if (cards.length === 0) return 0
  if (cards.length === 3) {
    const topRank = evaluateThree(cards)
    if (topRank.category === 2) return 1.35
    if (topRank.category === 1) {
      const pairRank = topRank.kickers[0] ?? 0
      if (pairRank >= 12) return 1
      if (pairRank >= 10) return 0.45
      return 0.2
    }
    return 0
  }

  if (cards.length === 2) {
    const [first, second] = cards
    if (!first || !second) return 0
    const firstValue = rankValue(first.rank)
    const secondValue = rankValue(second.rank)
    if (first.rank === second.rank) {
      if (firstValue >= 12) return 0.75
      if (firstValue >= 10) return 0.35
      return 0.15
    }
    const high = Math.max(firstValue, secondValue)
    return high >= 13 ? 0.12 : 0.04
  }

  const first = cards[0]
  if (!first) return 0
  const firstValue = rankValue(first.rank)
  if (firstValue >= 13) return 0.08
  if (firstValue >= 11) return 0.04
  return 0
}

function fantasySignals(lines: LinesState): { entrySignal: number; reentrySignal: number } {
  const entrySignal = topEntrySignal(lines.top)

  let reentrySignal = entrySignal * 0.45
  if (lines.middle.length === LINE_LIMITS.middle) {
    reentrySignal += royaltiesMiddle(lines.middle) / 30
  } else {
    reentrySignal += Math.min(0.35, partialLineHeuristic(lines.middle) / 90)
  }
  if (lines.bottom.length === LINE_LIMITS.bottom) {
    reentrySignal += royaltiesBottom(lines.bottom) / 20
  } else {
    reentrySignal += Math.min(0.3, partialLineHeuristic(lines.bottom) / 100)
  }

  return {
    entrySignal,
    reentrySignal
  }
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

function enumerateInitialCandidates(base: LinesState, pending: Card[]): LinesState[] {
  const results: LinesState[] = []

  const walk = (index: number, current: LinesState) => {
    if (index >= pending.length) {
      results.push(cloneLines(current))
      return
    }

    const card = pending[index]
    if (!card) {
      walk(index + 1, current)
      return
    }

    const targets = legalTargets(current)
    if (targets.length === 0) return

    for (const target of targets) {
      current[target].push(card)
      walk(index + 1, current)
      current[target].pop()
    }
  }

  walk(0, cloneLines(base))
  results.sort((left, right) => linesSignature(left).localeCompare(linesSignature(right)))
  return results
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

function emptyRolloutStats(): RolloutStats {
  return {
    samples: 0,
    sum: 0,
    sumSquares: 0,
    foulCount: 0
  }
}

function summarizeRolloutStats(input: {
  stats: RolloutStats
  weights: UtilityWeights
  lines: LinesState
}): UtilitySummary {
  const signals = fantasySignals(input.lines)
  const { stats } = input
  if (stats.samples <= 0) {
    return {
      utility: -100 + signals.entrySignal * input.weights.entryBonus + signals.reentrySignal * input.weights.reentryBonus,
      mean: -100,
      stdDev: 0,
      foulRate: 1,
      entrySignal: signals.entrySignal,
      reentrySignal: signals.reentrySignal
    }
  }
  const mean = stats.sum / stats.samples
  const variance = Math.max(0, stats.sumSquares / stats.samples - mean * mean)
  const stdDev = Math.sqrt(variance)
  const foulRate = stats.foulCount / stats.samples
  const utility =
    mean -
    input.weights.variancePenalty * stdDev -
    foulRate * input.weights.foulPenalty +
    signals.entrySignal * input.weights.entryBonus +
    signals.reentrySignal * input.weights.reentryBonus
  return {
    utility,
    mean,
    stdDev,
    foulRate,
    entrySignal: signals.entrySignal,
    reentrySignal: signals.reentrySignal
  }
}

function utilityValue(summary: UtilitySummary): number {
  return Number.isFinite(summary.utility) ? summary.utility : Number.NEGATIVE_INFINITY
}

function compareEvaluations(left: CandidateEvaluation, right: CandidateEvaluation): number {
  const leftUtility = utilityValue(left.summary)
  const rightUtility = utilityValue(right.summary)
  if (leftUtility < rightUtility) return 1
  if (leftUtility > rightUtility) return -1
  return left.key.localeCompare(right.key)
}

function sampleCandidateRollouts(input: {
  candidate: CandidateEvaluation
  visibleOpponentLines: LinesState
  unknownPool: Card[]
  additionalRollouts: number
  weights: UtilityWeights
}): void {
  const rolloutCount = Math.max(0, input.additionalRollouts)
  for (let i = 0; i < rolloutCount; i += 1) {
    const sampleIndex = input.candidate.stats.samples
    const simulation = simulateRollout({
      botStart: input.candidate.lines,
      opponentStart: input.visibleOpponentLines,
      unknownPool: input.unknownPool,
      seed: `${input.candidate.seedPrefix}:${sampleIndex}`
    })
    input.candidate.stats.samples += 1
    input.candidate.stats.sum += simulation.total
    input.candidate.stats.sumSquares += simulation.total * simulation.total
    if (simulation.foul) input.candidate.stats.foulCount += 1
  }
  input.candidate.summary = summarizeRolloutStats({
    stats: input.candidate.stats,
    lines: input.candidate.lines,
    weights: input.weights
  })
}

function evaluateCandidatesAdaptive(input: {
  candidates: CandidateSpec[]
  visibleOpponentLines: LinesState
  unknownPool: Card[]
  profile?: StrategyProfile
  stage1Rollouts: number
  stage2Rollouts: number
  stage3Rollouts: number
  topK: number
  gapThreshold: number
}): CandidateEvaluation[] {
  const weights = strategyWeights(input.profile)
  const evaluations: CandidateEvaluation[] = input.candidates.map((candidate) => ({
    ...candidate,
    stats: emptyRolloutStats(),
    summary: summarizeRolloutStats({
      stats: emptyRolloutStats(),
      lines: candidate.lines,
      weights
    })
  }))
  if (evaluations.length === 0) return evaluations

  for (const evaluation of evaluations) {
    sampleCandidateRollouts({
      candidate: evaluation,
      visibleOpponentLines: input.visibleOpponentLines,
      unknownPool: input.unknownPool,
      additionalRollouts: input.stage1Rollouts,
      weights
    })
  }

  const finalistCount = Math.max(1, Math.min(evaluations.length, input.topK))
  let ranked = [...evaluations].sort(compareEvaluations)
  for (const evaluation of ranked.slice(0, finalistCount)) {
    sampleCandidateRollouts({
      candidate: evaluation,
      visibleOpponentLines: input.visibleOpponentLines,
      unknownPool: input.unknownPool,
      additionalRollouts: input.stage2Rollouts,
      weights
    })
  }

  ranked = [...evaluations].sort(compareEvaluations)
  if (input.stage3Rollouts > 0 && ranked.length > 1) {
    const first = ranked[0]
    const second = ranked[1]
    if (!first || !second) return ranked
    const gap = utilityValue(first.summary) - utilityValue(second.summary)
    if (!Number.isFinite(gap) || gap < input.gapThreshold) {
      const contenders = ranked.slice(0, Math.min(2, finalistCount))
      for (const evaluation of contenders) {
        sampleCandidateRollouts({
          candidate: evaluation,
          visibleOpponentLines: input.visibleOpponentLines,
          unknownPool: input.unknownPool,
          additionalRollouts: input.stage3Rollouts,
          weights
        })
      }
      ranked = [...evaluations].sort(compareEvaluations)
    }
  }

  return ranked
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
  const ranked = evaluateCandidatesAdaptive({
    candidates: legal.map((target) => ({
      key: target,
      lines: withPlacedCard(input.botLines, target, botCard),
      seedPrefix: `${input.signatureSeed}:play:${target}:${input.drawIndex}`
    })),
    visibleOpponentLines: input.visibleOpponentLines,
    unknownPool,
    profile: input.profile,
    stage1Rollouts: PLAY_STAGE1_ROLLOUTS,
    stage2Rollouts: PLAY_STAGE2_ROLLOUTS,
    stage3Rollouts: PLAY_STAGE3_ROLLOUTS,
    topK: PLAY_TOP_K,
    gapThreshold: ROLLOUT_GAP_THRESHOLD
  })

  for (const evaluation of ranked) {
    const target = evaluation.key as PlacementTarget
    byTarget[target] = evaluation.summary.utility
  }

  const best = ranked[0]
  const bestTarget = (best?.key as PlacementTarget | undefined) ?? legal[0] ?? 'top'
  const bestUtility = best?.summary.utility ?? Number.NEGATIVE_INFINITY

  if (!Number.isFinite(bestUtility)) {
    const fallback = fallbackTarget(input.botLines)
    return {
      target: fallback,
      utility: -100,
      byTarget
    }
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

  const candidates = enumerateInitialCandidates(input.botLines, input.botPending)
  if (candidates.length === 0) {
    return buildFallbackInitial(input.botLines, input.botPending)
  }

  const unknownPool = buildUnknownPool(input)
  const ranked = evaluateCandidatesAdaptive({
    candidates: candidates.map((candidate, index) => ({
      key: linesSignature(candidate),
      lines: candidate,
      seedPrefix: `${input.signatureSeed}:initial:${input.drawIndex}:${index}`
    })),
    visibleOpponentLines: input.visibleOpponentLines,
    unknownPool,
    profile: input.profile,
    stage1Rollouts: INITIAL_STAGE1_ROLLOUTS,
    stage2Rollouts: INITIAL_STAGE2_ROLLOUTS,
    stage3Rollouts: INITIAL_STAGE3_ROLLOUTS,
    topK: INITIAL_TOP_K,
    gapThreshold: ROLLOUT_GAP_THRESHOLD
  })

  const bestNode = ranked[0]
  const bestUtility = bestNode?.summary.utility ?? Number.NEGATIVE_INFINITY

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
