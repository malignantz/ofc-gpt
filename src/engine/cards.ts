export type Suit = 'S' | 'H' | 'D' | 'C'
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A'

export type Card = {
  rank: Rank
  suit: Suit
}

export const ranks: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']
export const suits: Suit[] = ['S', 'H', 'D', 'C']

export function cardToString(card: Card): string {
  return `${card.rank}${card.suit}`
}

export function stringToCard(card: string): Card {
  const rank = card[0] as Rank
  const suit = card[1] as Suit
  return { rank, suit }
}

export function rankValue(rank: Rank): number {
  return ranks.indexOf(rank) + 2
}
