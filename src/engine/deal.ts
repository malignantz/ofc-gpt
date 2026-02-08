import { Card } from './cards'
import { buildDeck, shuffle } from './deck'
import { hexToBytes } from '../crypto/hash'
import { seededRngFromBytes } from '../crypto/seededRng'

export type DealResult = {
  hands: Card[][]
  drawOrder: Card[]
}

export function dealClassicOFC(deck: Card[], seedHex: string, playerCount: number): DealResult {
  if (playerCount < 2 || playerCount > 4) {
    throw new Error('playerCount must be between 2 and 4')
  }

  const cardsPerPlayer = 13
  const initialPerPlayer = 5
  const drawsPerPlayer = cardsPerPlayer - initialPerPlayer
  const requiredCards = playerCount * cardsPerPlayer
  if (deck.length < requiredCards) {
    throw new Error('deck does not contain enough cards for a round')
  }

  const rng = seededRngFromBytes(hexToBytes(seedHex))
  const shuffled = shuffle(deck, rng)
  const hands: Card[][] = Array.from({ length: playerCount }, () => [])

  let index = 0
  for (let round = 0; round < initialPerPlayer; round += 1) {
    for (let player = 0; player < playerCount; player += 1) {
      const hand = hands[player]
      const card = shuffled[index]
      if (!hand || !card) {
        throw new Error('Unexpected deck state while dealing')
      }
      hand.push(card)
      index += 1
    }
  }

  const drawCount = playerCount * drawsPerPlayer
  const drawOrder = shuffled.slice(index, index + drawCount)
  if (drawOrder.length !== drawCount) {
    throw new Error('Unexpected deck state while building draw order')
  }
  return {
    hands,
    drawOrder
  }
}

export function dealWithFreshDeck(seedHex: string, playerCount: number): DealResult {
  return dealClassicOFC(buildDeck(), seedHex, playerCount)
}
