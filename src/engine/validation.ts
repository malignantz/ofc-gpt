import { Card } from './cards'
import { compareRanks, evaluateFive, evaluateThree } from './handEval'

export type Lines = {
  top: Card[]
  middle: Card[]
  bottom: Card[]
}

export type FoulAnalysis = {
  isFoul: boolean
  incomplete: boolean
  topBeatsMiddle: boolean
  middleBeatsBottom: boolean
  offenderLines: Array<'middle' | 'bottom'>
}

export function analyzeFoul(lines: Lines): FoulAnalysis {
  if (lines.top.length !== 3 || lines.middle.length !== 5 || lines.bottom.length !== 5) {
    return {
      isFoul: true,
      incomplete: true,
      topBeatsMiddle: false,
      middleBeatsBottom: false,
      offenderLines: []
    }
  }

  const topRank = evaluateThree(lines.top)
  const middleRank = evaluateFive(lines.middle)
  const bottomRank = evaluateFive(lines.bottom)

  const topVsMiddle = compareRanks(topRank, middleRank)
  const middleVsBottom = compareRanks(middleRank, bottomRank)

  const topBeatsMiddle = topVsMiddle > 0
  const middleBeatsBottom = middleVsBottom > 0
  const offenderLines: Array<'middle' | 'bottom'> = []
  if (topBeatsMiddle) offenderLines.push('middle')
  if (middleBeatsBottom) offenderLines.push('bottom')

  return {
    isFoul: topBeatsMiddle || middleBeatsBottom,
    incomplete: false,
    topBeatsMiddle,
    middleBeatsBottom,
    offenderLines
  }
}

export function isFoul(lines: Lines): boolean {
  return analyzeFoul(lines).isFoul
}
