import { Card, ranks, suits } from './cards'

export function buildDeck(): Card[] {
  const deck: Card[] = []
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ rank, suit })
    }
  }
  return deck
}

export type Rng = () => number

export function shuffle(deck: Card[], rng: Rng): Card[] {
  const copy = [...deck]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const cardAtI = copy[i]
    const cardAtJ = copy[j]
    if (!cardAtI || !cardAtJ) continue
    copy[i] = cardAtJ
    copy[j] = cardAtI
  }
  return copy
}
