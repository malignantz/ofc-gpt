import { Card } from './cards'
import { compareRanks, evaluateFive, evaluateThree } from './handEval'

export type Lines = {
  top: Card[]
  middle: Card[]
  bottom: Card[]
}

export function isFoul(lines: Lines): boolean {
  if (lines.top.length !== 3 || lines.middle.length !== 5 || lines.bottom.length !== 5) {
    return true
  }

  const topRank = evaluateThree(lines.top)
  const middleRank = evaluateFive(lines.middle)
  const bottomRank = evaluateFive(lines.bottom)

  const topVsMiddle = compareRanks(topRank, middleRank)
  const middleVsBottom = compareRanks(middleRank, bottomRank)

  return topVsMiddle > 0 || middleVsBottom > 0
}
