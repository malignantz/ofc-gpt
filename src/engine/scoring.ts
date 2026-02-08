import { Card, rankValue } from './cards'
import { compareRanks, evaluateFive, evaluateThree } from './handEval'
import { Lines, isFoul } from './validation'

export type ScoreResult = {
  base: number
  royalties: number
  total: number
}

export type RoyaltyBreakdown = {
  top: number
  middle: number
  bottom: number
  total: number
}

export type LineComparison = -1 | 0 | 1

export type DetailedScoreResult = ScoreResult & {
  foul: boolean
  royaltiesByLine: RoyaltyBreakdown
}

export type HeadsUpDetailedResult = {
  lines: {
    top: LineComparison
    middle: LineComparison
    bottom: LineComparison
  }
  sweep: boolean
  fouls: {
    player: boolean
    opponent: boolean
  }
  player: DetailedScoreResult
  opponent: DetailedScoreResult
}

export function scoreHeadsUpDetailed(player: Lines, opponent: Lines): HeadsUpDetailedResult {
  const playerFoul = isFoul(player)
  const opponentFoul = isFoul(opponent)

  if (playerFoul && opponentFoul) {
    const emptyRoyalties = { top: 0, middle: 0, bottom: 0, total: 0 }
    return {
      lines: { top: 0, middle: 0, bottom: 0 },
      sweep: false,
      fouls: { player: true, opponent: true },
      player: {
        foul: true,
        base: 0,
        royalties: 0,
        total: 0,
        royaltiesByLine: emptyRoyalties
      },
      opponent: {
        foul: true,
        base: 0,
        royalties: 0,
        total: 0,
        royaltiesByLine: emptyRoyalties
      }
    }
  }

  if (playerFoul || opponentFoul) {
    const winnerIsPlayer = !playerFoul
    const winnerLines = winnerIsPlayer ? player : opponent
    const winnerRoyalties = royaltiesBreakdown(winnerLines)
    const loserRoyalties = { top: 0, middle: 0, bottom: 0, total: 0 }
    const base = 6
    const playerBase = winnerIsPlayer ? base : -base
    const playerRoyalties = winnerIsPlayer ? winnerRoyalties.total : -winnerRoyalties.total
    const playerTotal = playerBase + playerRoyalties
    return {
      lines: winnerIsPlayer ? { top: 1, middle: 1, bottom: 1 } : { top: -1, middle: -1, bottom: -1 },
      sweep: true,
      fouls: { player: playerFoul, opponent: opponentFoul },
      player: {
        foul: playerFoul,
        base: playerBase,
        royalties: playerRoyalties,
        total: playerTotal,
        royaltiesByLine: winnerIsPlayer ? winnerRoyalties : loserRoyalties
      },
      opponent: {
        foul: opponentFoul,
        base: -playerBase,
        royalties: -playerRoyalties,
        total: -playerTotal,
        royaltiesByLine: winnerIsPlayer ? loserRoyalties : winnerRoyalties
      }
    }
  }

  const playerRanks = {
    top: evaluateThree(player.top),
    middle: evaluateFive(player.middle),
    bottom: evaluateFive(player.bottom)
  }
  const opponentRanks = {
    top: evaluateThree(opponent.top),
    middle: evaluateFive(opponent.middle),
    bottom: evaluateFive(opponent.bottom)
  }

  const lines = {
    top: toLineComparison(compareRanks(playerRanks.top, opponentRanks.top)),
    middle: toLineComparison(compareRanks(playerRanks.middle, opponentRanks.middle)),
    bottom: toLineComparison(compareRanks(playerRanks.bottom, opponentRanks.bottom))
  }

  let base = lines.top + lines.middle + lines.bottom
  const sweep = Math.abs(base) === 3
  if (sweep) {
    base = base > 0 ? 6 : -6
  }

  const playerRoyaltiesByLine = royaltiesBreakdown(player)
  const opponentRoyaltiesByLine = royaltiesBreakdown(opponent)
  const playerRoyalties = playerRoyaltiesByLine.total - opponentRoyaltiesByLine.total

  return {
    lines,
    sweep,
    fouls: { player: false, opponent: false },
    player: {
      foul: false,
      base,
      royalties: playerRoyalties,
      total: base + playerRoyalties,
      royaltiesByLine: playerRoyaltiesByLine
    },
    opponent: {
      foul: false,
      base: -base,
      royalties: -playerRoyalties,
      total: -base - playerRoyalties,
      royaltiesByLine: opponentRoyaltiesByLine
    }
  }
}

export function scoreHeadsUp(player: Lines, opponent: Lines): { player: ScoreResult; opponent: ScoreResult } {
  const result = scoreHeadsUpDetailed(player, opponent)
  return {
    player: {
      base: result.player.base,
      royalties: result.player.royalties,
      total: result.player.total
    },
    opponent: {
      base: result.opponent.base,
      royalties: result.opponent.royalties,
      total: result.opponent.total
    }
  }
}

export function royaltiesBreakdown(lines: Lines): RoyaltyBreakdown {
  const top = royaltiesTop(lines.top)
  const middle = royaltiesMiddle(lines.middle)
  const bottom = royaltiesBottom(lines.bottom)
  return {
    top,
    middle,
    bottom,
    total: top + middle + bottom
  }
}

export function royaltiesTotal(lines: Lines): number {
  return royaltiesBreakdown(lines).total
}

export function royaltiesTop(cards: Card[]): number {
  if (cards.length !== 3) return 0
  const ranks = cards.map((card) => rankValue(card.rank)).sort((a, b) => b - a)
  const counts = countRanks(ranks)
  const countValues = Object.values(counts).sort((a, b) => b - a)

  if (countValues[0] === 3) {
    const tripRank = Number(Object.keys(counts).find((rank) => counts[Number(rank)] === 3))
    return tripRank + 8
  }

  if (countValues[0] === 2) {
    const pairRank = Number(Object.keys(counts).find((rank) => counts[Number(rank)] === 2))
    return Math.max(0, pairRank - 5)
  }

  return 0
}

export function royaltiesMiddle(cards: Card[]): number {
  const { category } = evaluateFive(cards)
  switch (category) {
    case 3:
      return 2
    case 4:
      return 4
    case 5:
      return 8
    case 6:
      return 12
    case 7:
      return 20
    case 8:
      return 30
    default:
      return 0
  }
}

export function royaltiesBottom(cards: Card[]): number {
  const { category } = evaluateFive(cards)
  switch (category) {
    case 4:
      return 2
    case 5:
      return 4
    case 6:
      return 6
    case 7:
      return 10
    case 8:
      return 15
    default:
      return 0
  }
}

function countRanks(ranks: number[]): Record<number, number> {
  return ranks.reduce<Record<number, number>>((acc, rank) => {
    acc[rank] = (acc[rank] ?? 0) + 1
    return acc
  }, {})
}

function toLineComparison(value: number): LineComparison {
  return Math.sign(value) as LineComparison
}
