export const RIVALRY_STORE_KEY = 'ofc:rivalry-scores-v1'

export type ScoreboardEntry = {
  opponentId: string
  name: string
  total: number
  wins: number
  losses: number
  ties: number
  updatedAt: number
}

type RivalryScore = {
  opponentId: string
  name: string
  total: number
  wins: number
  losses: number
  ties: number
  updatedAt: number
}

type RivalryStoreEntry = {
  processedRounds?: unknown
  rivals?: unknown
}

type RivalryStore = Record<string, RivalryStoreEntry>

type StorageLike = {
  getItem: (key: string) => string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value
}

function parseRivalryScore(value: unknown): RivalryScore | null {
  if (!isRecord(value)) return null
  const opponentId = asString(value.opponentId)
  const name = asString(value.name)
  const total = asNumber(value.total)
  const wins = asNumber(value.wins)
  const losses = asNumber(value.losses)
  const ties = asNumber(value.ties)
  const updatedAt = asNumber(value.updatedAt)
  if (!opponentId || !name) return null
  if (total === null || wins === null || losses === null || ties === null || updatedAt === null) return null
  return {
    opponentId,
    name,
    total,
    wins,
    losses,
    ties,
    updatedAt
  }
}

export function extractScoreboardEntries(storeValue: unknown): ScoreboardEntry[] {
  if (!isRecord(storeValue)) return []
  const store = storeValue as RivalryStore
  const aggregated = new Map<string, ScoreboardEntry>()
  for (const entry of Object.values(store)) {
    if (!isRecord(entry)) continue
    const rivals = entry.rivals
    if (!isRecord(rivals)) continue
    for (const rivalRaw of Object.values(rivals)) {
      const rival = parseRivalryScore(rivalRaw)
      if (!rival) continue
      const existing = aggregated.get(rival.opponentId)
      if (!existing) {
        aggregated.set(rival.opponentId, { ...rival })
        continue
      }
      const useIncomingName = rival.updatedAt >= existing.updatedAt
      aggregated.set(rival.opponentId, {
        opponentId: rival.opponentId,
        name: useIncomingName ? rival.name : existing.name,
        total: existing.total + rival.total,
        wins: existing.wins + rival.wins,
        losses: existing.losses + rival.losses,
        ties: existing.ties + rival.ties,
        updatedAt: Math.max(existing.updatedAt, rival.updatedAt)
      })
    }
  }
  return [...aggregated.values()].sort((left, right) => {
    const absDelta = Math.abs(right.total) - Math.abs(left.total)
    if (absDelta !== 0) return absDelta
    if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt
    return left.name.localeCompare(right.name)
  })
}

export function readScoreboardEntriesFromLocalStorage(storage?: StorageLike): ScoreboardEntry[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(RIVALRY_STORE_KEY)
    if (!raw) return []
    return extractScoreboardEntries(JSON.parse(raw))
  } catch {
    return []
  }
}

