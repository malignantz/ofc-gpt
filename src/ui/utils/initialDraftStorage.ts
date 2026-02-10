import type { LinesState } from '../../state/gameState'

export type DraftSnapshot = {
  lines: Record<keyof LinesState, string[]>
  pending: string[]
}

type PersistedDraftSnapshot = {
  version: 1
  cardPoolSignature: string
  snapshot: DraftSnapshot
  savedAt: number
}

const DRAFT_STORAGE_PREFIX = 'ofc:initial-draft:v1'
const LINE_KEYS: Array<keyof LinesState> = ['top', 'middle', 'bottom']
const LINE_LIMITS: Record<keyof LinesState, number> = { top: 3, middle: 5, bottom: 5 }

export function buildInitialDraftStorageKey(input: { roomName?: string; playerId: string }): string {
  const normalizedRoom = input.roomName?.trim().toLowerCase()
  const scope = normalizedRoom ? `room:${normalizedRoom}` : 'cpu_local'
  return `${DRAFT_STORAGE_PREFIX}:${scope}:${input.playerId}`
}

export function buildDraftCardPoolSignature(snapshot: DraftSnapshot): string {
  const cards = [
    ...snapshot.lines.top,
    ...snapshot.lines.middle,
    ...snapshot.lines.bottom,
    ...snapshot.pending
  ]
  cards.sort()
  return cards.join(',')
}

export function readInitialDraftSnapshot(
  storage: Storage,
  key: string,
  expectedCardPoolSignature: string
): DraftSnapshot | null {
  const raw = storage.getItem(key)
  if (!raw) return null

  let parsed: PersistedDraftSnapshot | null = null
  try {
    parsed = JSON.parse(raw) as PersistedDraftSnapshot
  } catch {
    return null
  }

  if (!parsed || parsed.version !== 1) return null
  if (parsed.cardPoolSignature !== expectedCardPoolSignature) return null
  if (!isValidSnapshot(parsed.snapshot)) return null
  if (buildDraftCardPoolSignature(parsed.snapshot) !== expectedCardPoolSignature) return null

  return {
    lines: {
      top: [...parsed.snapshot.lines.top],
      middle: [...parsed.snapshot.lines.middle],
      bottom: [...parsed.snapshot.lines.bottom]
    },
    pending: [...parsed.snapshot.pending]
  }
}

export function writeInitialDraftSnapshot(storage: Storage, key: string, snapshot: DraftSnapshot): void {
  const payload: PersistedDraftSnapshot = {
    version: 1,
    cardPoolSignature: buildDraftCardPoolSignature(snapshot),
    snapshot: {
      lines: {
        top: [...snapshot.lines.top],
        middle: [...snapshot.lines.middle],
        bottom: [...snapshot.lines.bottom]
      },
      pending: [...snapshot.pending]
    },
    savedAt: Date.now()
  }
  storage.setItem(key, JSON.stringify(payload))
}

export function clearInitialDraftSnapshot(storage: Storage, key: string): void {
  storage.removeItem(key)
}

function isValidSnapshot(snapshot: DraftSnapshot | null | undefined): snapshot is DraftSnapshot {
  if (!snapshot) return false
  if (!snapshot.lines || typeof snapshot.lines !== 'object') return false
  if (!isStringArray(snapshot.pending)) return false
  for (const line of LINE_KEYS) {
    const cards = snapshot.lines[line]
    if (!isStringArray(cards)) return false
    if (cards.length > LINE_LIMITS[line]) return false
  }

  const allCards = [
    ...snapshot.lines.top,
    ...snapshot.lines.middle,
    ...snapshot.lines.bottom,
    ...snapshot.pending
  ]
  const distinct = new Set(allCards)
  if (distinct.size !== allCards.length) return false
  return true
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}
