import { sha256Hex, hexToBytes } from './hash'
import { seededRngFromBytes } from './seededRng'

export type SeedPair = {
  seed: string
  commit: string
}

export function createSeedPair(): { seed: string } {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  const seed = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return { seed }
}

export async function createSeedPairWithCommit(): Promise<SeedPair> {
  const { seed } = createSeedPair()
  const commit = await commitSeed(seed)
  return { seed, commit }
}

export async function commitSeed(seed: string): Promise<string> {
  return sha256Hex(seed)
}

export async function verifyReveal(seed: string, commit: string): Promise<boolean> {
  const computed = await sha256Hex(seed)
  return computed === commit
}

export async function combineSeeds(seedsInSeatOrder: string[]): Promise<string> {
  return sha256Hex(seedsInSeatOrder.join(''))
}

export async function rngFromCombinedSeed(combinedSeedHex: string) {
  const bytes = hexToBytes(combinedSeedHex)
  return seededRngFromBytes(bytes)
}
