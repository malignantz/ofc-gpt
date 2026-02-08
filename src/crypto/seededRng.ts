export type Rng = () => number

export function seededRngFromBytes(bytes: Uint8Array): Rng {
  let seed = 0
  for (let i = 0; i < Math.min(bytes.length, 4); i += 1) {
    seed = (seed << 8) | (bytes[i] ?? 0)
  }
  if (seed === 0) seed = 0x1a2b3c4d

  return () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    const normalized = (seed >>> 0) / 0xffffffff
    return normalized
  }
}
