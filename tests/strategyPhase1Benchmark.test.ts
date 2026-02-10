import { describe, expect, it } from 'vitest'
import { buildDeck } from '../src/engine/deck'
import { cardToString, type Card } from '../src/engine/cards'
import { scoreHeadsUpDetailed } from '../src/engine/scoring'
import { chooseInitialPlacement, choosePlayPlacement } from '../src/strategy/placementEngine'
import { hashString32, shuffleDeterministic } from '../src/strategy/deterministicRng'
import type { LinesState } from '../src/state/gameState'
import type { StrategyProfile } from '../src/strategy/types'

const LINE_LIMITS = { top: 3, middle: 5, bottom: 5 } as const
const TARGET_PRIORITY: Array<keyof LinesState> = ['bottom', 'middle', 'top']
const PROFILES: StrategyProfile[] = ['conservative_ev', 'balanced_ev', 'fantasy_pressure']

type BenchmarkMetrics = {
  samples: number
  avgScore: number
  foulRate: number
  avgLatencyMs: number
}

type BenchmarkResult = {
  play: Record<StrategyProfile, BenchmarkMetrics>
  initial: Record<StrategyProfile, BenchmarkMetrics>
}

type PlayScenario = {
  botLines: LinesState
  botPending: Card[]
  visibleOpponentLines: LinesState
  knownDeck: Card[]
  drawIndex: number
  signatureSeed: string
}

type InitialScenario = {
  botLines: LinesState
  botPending: Card[]
  visibleOpponentLines: LinesState
  knownDeck: Card[]
  drawIndex: number
  signatureSeed: string
}

function emptyLines(): LinesState {
  return { top: [], middle: [], bottom: [] }
}

function cloneLines(lines: LinesState): LinesState {
  return {
    top: [...lines.top],
    middle: [...lines.middle],
    bottom: [...lines.bottom]
  }
}

function lineCount(lines: LinesState): number {
  return lines.top.length + lines.middle.length + lines.bottom.length
}

function withPlaced(lines: LinesState, target: keyof LinesState, card: Card): LinesState {
  const next = cloneLines(lines)
  next[target] = [...next[target], card]
  return next
}

function legalTargets(lines: LinesState): Array<keyof LinesState> {
  return TARGET_PRIORITY.filter((target) => lines[target].length < LINE_LIMITS[target])
}

function linesComplete(lines: LinesState): boolean {
  return (
    lines.top.length === LINE_LIMITS.top &&
    lines.middle.length === LINE_LIMITS.middle &&
    lines.bottom.length === LINE_LIMITS.bottom
  )
}

function cardKey(card: Card): string {
  return cardToString(card)
}

function completeByPriority(base: LinesState, cards: Card[]): LinesState {
  const lines = cloneLines(base)
  for (const card of cards) {
    const target = legalTargets(lines)[0]
    if (!target) break
    lines[target] = [...lines[target], card]
  }
  return lines
}

function buildUnknownPool(knownDeck: Card[], botLines: LinesState, oppLines: LinesState, botPending: Card[]): Card[] {
  const used = new Set<string>()
  for (const card of botLines.top) used.add(cardKey(card))
  for (const card of botLines.middle) used.add(cardKey(card))
  for (const card of botLines.bottom) used.add(cardKey(card))
  for (const card of oppLines.top) used.add(cardKey(card))
  for (const card of oppLines.middle) used.add(cardKey(card))
  for (const card of oppLines.bottom) used.add(cardKey(card))
  for (const card of botPending) used.add(cardKey(card))
  return knownDeck.filter((card) => !used.has(cardKey(card)))
}

function simulateOutcome(input: {
  botStart: LinesState
  opponentStart: LinesState
  knownDeck: Card[]
  botPending: Card[]
  seed: string
}): { score: number; foul: boolean } {
  const unknownPool = buildUnknownPool(input.knownDeck, input.botStart, input.opponentStart, input.botPending)
  const botNeeded = Math.max(0, 13 - lineCount(input.botStart))
  const oppNeeded = Math.max(0, 13 - lineCount(input.opponentStart))
  const required = botNeeded + oppNeeded
  if (required > unknownPool.length) return { score: -120, foul: true }

  const shuffled = shuffleDeterministic(unknownPool, hashString32(input.seed))
  const botFuture = shuffled.slice(0, botNeeded)
  const oppFuture = shuffled.slice(botNeeded, botNeeded + oppNeeded)

  const botFinal = completeByPriority(input.botStart, botFuture)
  const oppFinal = completeByPriority(input.opponentStart, oppFuture)
  if (!linesComplete(botFinal) || !linesComplete(oppFinal)) return { score: -120, foul: true }

  const detailed = scoreHeadsUpDetailed(botFinal, oppFinal)
  return { score: detailed.player.total, foul: detailed.fouls.player }
}

function makePlayScenario(index: number): PlayScenario {
  const knownDeck = shuffleDeterministic(buildDeck(), hashString32(`phase1:play:${index}`))
  return {
    botLines: {
      top: [knownDeck[0] as Card],
      middle: [knownDeck[1] as Card, knownDeck[2] as Card],
      bottom: [knownDeck[3] as Card, knownDeck[4] as Card, knownDeck[5] as Card]
    },
    botPending: [knownDeck[6] as Card],
    visibleOpponentLines: {
      top: [knownDeck[7] as Card],
      middle: [knownDeck[8] as Card, knownDeck[9] as Card],
      bottom: [knownDeck[10] as Card, knownDeck[11] as Card, knownDeck[12] as Card]
    },
    knownDeck,
    drawIndex: index,
    signatureSeed: `phase1:play:${index}`
  }
}

function makeInitialScenario(index: number): InitialScenario {
  const knownDeck = shuffleDeterministic(buildDeck(), hashString32(`phase1:initial:${index}`))
  return {
    botLines: emptyLines(),
    botPending: [knownDeck[0] as Card, knownDeck[1] as Card, knownDeck[2] as Card, knownDeck[3] as Card, knownDeck[4] as Card],
    visibleOpponentLines: {
      top: [knownDeck[5] as Card],
      middle: [knownDeck[6] as Card, knownDeck[7] as Card],
      bottom: [knownDeck[8] as Card, knownDeck[9] as Card]
    },
    knownDeck,
    drawIndex: index,
    signatureSeed: `phase1:initial:${index}`
  }
}

function createMetrics(): Record<StrategyProfile, BenchmarkMetrics> {
  return {
    conservative_ev: { samples: 0, avgScore: 0, foulRate: 0, avgLatencyMs: 0 },
    balanced_ev: { samples: 0, avgScore: 0, foulRate: 0, avgLatencyMs: 0 },
    fantasy_pressure: { samples: 0, avgScore: 0, foulRate: 0, avgLatencyMs: 0 }
  }
}

function finalizeMetrics(raw: Record<StrategyProfile, { samples: number; score: number; fouls: number; latencyMs: number }>) {
  const result = createMetrics()
  for (const profile of PROFILES) {
    const profileRaw = raw[profile]
    const sampleCount = Math.max(1, profileRaw.samples)
    result[profile] = {
      samples: profileRaw.samples,
      avgScore: profileRaw.score / sampleCount,
      foulRate: profileRaw.fouls / sampleCount,
      avgLatencyMs: profileRaw.latencyMs / sampleCount
    }
  }
  return result
}

function runBenchmarkSuite(): BenchmarkResult {
  const playRaw: Record<StrategyProfile, { samples: number; score: number; fouls: number; latencyMs: number }> = {
    conservative_ev: { samples: 0, score: 0, fouls: 0, latencyMs: 0 },
    balanced_ev: { samples: 0, score: 0, fouls: 0, latencyMs: 0 },
    fantasy_pressure: { samples: 0, score: 0, fouls: 0, latencyMs: 0 }
  }
  const initialRaw: Record<StrategyProfile, { samples: number; score: number; fouls: number; latencyMs: number }> = {
    conservative_ev: { samples: 0, score: 0, fouls: 0, latencyMs: 0 },
    balanced_ev: { samples: 0, score: 0, fouls: 0, latencyMs: 0 },
    fantasy_pressure: { samples: 0, score: 0, fouls: 0, latencyMs: 0 }
  }

  const playScenarios = Array.from({ length: 24 }, (_, index) => makePlayScenario(index))
  const initialScenarios = Array.from({ length: 18 }, (_, index) => makeInitialScenario(index))
  const rolloutsPerScenario = 10

  for (const scenario of playScenarios) {
    for (const profile of PROFILES) {
      const started = performance.now()
      const decision = choosePlayPlacement({
        botLines: scenario.botLines,
        botPending: scenario.botPending,
        visibleOpponentLines: scenario.visibleOpponentLines,
        knownDeck: scenario.knownDeck,
        drawIndex: scenario.drawIndex,
        signatureSeed: scenario.signatureSeed,
        profile
      })
      playRaw[profile].latencyMs += performance.now() - started

      const pendingCard = scenario.botPending[0]
      if (!pendingCard) continue
      const botStart = withPlaced(scenario.botLines, decision.target, pendingCard)
      for (let rolloutIndex = 0; rolloutIndex < rolloutsPerScenario; rolloutIndex += 1) {
        const result = simulateOutcome({
          botStart,
          opponentStart: scenario.visibleOpponentLines,
          knownDeck: scenario.knownDeck,
          botPending: scenario.botPending,
          seed: `${scenario.signatureSeed}:play:${profile}:${rolloutIndex}`
        })
        playRaw[profile].samples += 1
        playRaw[profile].score += result.score
        if (result.foul) playRaw[profile].fouls += 1
      }
    }
  }

  for (const scenario of initialScenarios) {
    for (const profile of PROFILES) {
      const started = performance.now()
      const decision = chooseInitialPlacement({
        botLines: scenario.botLines,
        botPending: scenario.botPending,
        visibleOpponentLines: scenario.visibleOpponentLines,
        knownDeck: scenario.knownDeck,
        drawIndex: scenario.drawIndex,
        signatureSeed: scenario.signatureSeed,
        profile
      })
      initialRaw[profile].latencyMs += performance.now() - started

      const botStart = { top: decision.top, middle: decision.middle, bottom: decision.bottom }
      for (let rolloutIndex = 0; rolloutIndex < rolloutsPerScenario; rolloutIndex += 1) {
        const result = simulateOutcome({
          botStart,
          opponentStart: scenario.visibleOpponentLines,
          knownDeck: scenario.knownDeck,
          botPending: scenario.botPending,
          seed: `${scenario.signatureSeed}:initial:${profile}:${rolloutIndex}`
        })
        initialRaw[profile].samples += 1
        initialRaw[profile].score += result.score
        if (result.foul) initialRaw[profile].fouls += 1
      }
    }
  }

  return {
    play: finalizeMetrics(playRaw),
    initial: finalizeMetrics(initialRaw)
  }
}

describe('phase1 strategy benchmark', () => {
  it(
    'produces deterministic benchmark metrics',
    () => {
      const first = runBenchmarkSuite()
      const second = runBenchmarkSuite()

      for (const profile of PROFILES) {
        expect(second.play[profile].samples).toBe(first.play[profile].samples)
        expect(second.initial[profile].samples).toBe(first.initial[profile].samples)
        expect(second.play[profile].avgScore).toBeCloseTo(first.play[profile].avgScore, 10)
        expect(second.initial[profile].avgScore).toBeCloseTo(first.initial[profile].avgScore, 10)
        expect(second.play[profile].foulRate).toBeCloseTo(first.play[profile].foulRate, 10)
        expect(second.initial[profile].foulRate).toBeCloseTo(first.initial[profile].foulRate, 10)
        expect(first.play[profile].samples).toBeGreaterThan(0)
        expect(first.initial[profile].samples).toBeGreaterThan(0)
        expect(first.play[profile].avgLatencyMs).toBeLessThan(200)
        expect(first.initial[profile].avgLatencyMs).toBeLessThan(1200)
      }

      console.info('PHASE1_BENCHMARK', JSON.stringify(first))
    },
    30000
  )
})
