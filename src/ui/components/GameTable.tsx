import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { Card as PlayingCard } from '../../engine/cards'
import { cardToString, rankValue, stringToCard } from '../../engine/cards'
import { evaluateFive, evaluateThree } from '../../engine/handEval'
import { analyzeFoul, type FoulAnalysis } from '../../engine/validation'
import { GameState, LinesState } from '../../state/gameState'
import { royaltiesBreakdown, scoreHeadsUpDetailed, type HeadsUpDetailedResult } from '../../engine/scoring'
import { RIVALRY_STORE_KEY } from '../utils/scoreboard'
import { Card } from './Card'

type DraftLines = {
  top: string[]
  middle: string[]
  bottom: string[]
}

type SelectedCardState =
  | { source: 'pending'; card: string }
  | { source: 'line'; line: keyof LinesState; card: string }

type RivalryScore = {
  opponentId: string
  name: string
  total: number
  wins: number
  losses: number
  ties: number
  streak: number
  bestScore: number
  roundsPlayed: number
  updatedAt: number
}

type RivalryStoreEntry = {
  processedRounds: string[]
  rivals: Record<string, RivalryScore>
}

type RivalryStore = Record<string, RivalryStoreEntry>

const TAP_PLACEMENT_HINT_DISMISSED_KEY = 'ofc:tap-placement-hint-dismissed-v1'
const INITIAL_DRAFT_STORE_PREFIX = 'ofc:initial-draft-v1'
const DRAFT_LINE_KEYS: Array<keyof LinesState> = ['top', 'middle', 'bottom']
const LINE_LIMITS: Record<keyof LinesState, number> = { top: 3, middle: 5, bottom: 5 }
const SUIT_ORDER: Record<PlayingCard['suit'], number> = { S: 0, H: 1, D: 2, C: 3 }

type PersistedInitialDraft = {
  version: 1
  roundKey: string | null
  baseSignature: string
  draftLines: DraftLines
  draftPending: string[]
  savedAt: number
}

export function forcedLineFromLengths(
  lengths: Record<keyof LinesState, number>
): keyof LinesState | null {
  const candidates = DRAFT_LINE_KEYS.filter((line) => lengths[line] < LINE_LIMITS[line])
  if (candidates.length !== 1) return null
  return candidates[0] ?? null
}

export function draftSnapshotSignature(lines: DraftLines, pending: string[]): string {
  return `${lines.top.join(',')}|${lines.middle.join(',')}|${lines.bottom.join(',')}|${pending.join(',')}`
}

function buildInitialDraftStorageKey(localPlayerId: string, roomName?: string): string {
  const scope = roomName && roomName.trim().length > 0 ? `room:${roomName}` : 'cpu-local'
  return `${INITIAL_DRAFT_STORE_PREFIX}:${scope}:${localPlayerId}`
}

function normalizeDraftLines(value: unknown): DraftLines | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<Record<keyof LinesState, unknown>>
  const top = normalizeCardList(raw.top)
  const middle = normalizeCardList(raw.middle)
  const bottom = normalizeCardList(raw.bottom)
  if (!top || !middle || !bottom) return null
  if (top.length > LINE_LIMITS.top || middle.length > LINE_LIMITS.middle || bottom.length > LINE_LIMITS.bottom) {
    return null
  }
  return { top, middle, bottom }
}

function normalizeCardList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  if (!value.every((item) => typeof item === 'string' && item.length > 0)) return null
  return [...value]
}

function cardFrequency(cards: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const card of cards) {
    counts[card] = (counts[card] ?? 0) + 1
  }
  return counts
}

function sameCardMultiset(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const leftCounts = cardFrequency(left)
  const rightCounts = cardFrequency(right)
  const keys = new Set([...Object.keys(leftCounts), ...Object.keys(rightCounts)])
  for (const key of keys) {
    if ((leftCounts[key] ?? 0) !== (rightCounts[key] ?? 0)) return false
  }
  return true
}

function toDraftCardPool(lines: DraftLines, pending: string[]): string[] {
  return [...lines.top, ...lines.middle, ...lines.bottom, ...pending]
}

export function resolvePersistedInitialDraft(input: {
  persisted: unknown
  roundKey: string | null
  baseSignature: string
  authoritativeLines: DraftLines
  authoritativePending: string[]
}): { draftLines: DraftLines; draftPending: string[] } | null {
  const { persisted, roundKey, baseSignature, authoritativeLines, authoritativePending } = input
  if (!persisted || typeof persisted !== 'object') return null

  const raw = persisted as Partial<PersistedInitialDraft>
  if (raw.version !== 1) return null
  if ((raw.roundKey ?? null) !== roundKey) return null
  if (raw.baseSignature !== baseSignature) return null

  const draftLines = normalizeDraftLines(raw.draftLines)
  const draftPending = normalizeCardList(raw.draftPending)
  if (!draftLines || !draftPending) return null

  const authoritativePool = toDraftCardPool(authoritativeLines, authoritativePending)
  const draftPool = toDraftCardPool(draftLines, draftPending)
  if (!sameCardMultiset(draftPool, authoritativePool)) return null

  return { draftLines, draftPending }
}

export function sortLineCardsForDisplay(line: keyof LinesState, cards: string[]): string[] {
  const targetLength = line === 'top' ? 3 : 5
  if (cards.length !== targetLength) return cards
  try {
    const parsed = cards.map(stringToCard)
    const sorted = line === 'top' ? sortThreeCardLine(parsed) : sortFiveCardLine(parsed)
    return sorted.map(cardToString)
  } catch {
    return cards
  }
}

export function handRankLabelForDisplay(line: keyof LinesState, cards: string[]): string | null {
  const targetLength = line === 'top' ? 3 : 5
  if (cards.length !== targetLength) return null
  try {
    return handRankNameForLine(line, cards.map(stringToCard))
  } catch {
    return null
  }
}

function readPersistedInitialDraft(storageKey: string): unknown {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function writePersistedInitialDraft(storageKey: string, value: PersistedInitialDraft) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value))
  } catch {
    // Ignore storage write failures.
  }
}

function clearPersistedInitialDraft(storageKey: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(storageKey)
  } catch {
    // Ignore storage remove failures.
  }
}

function sortCardsByRankDesc(cards: PlayingCard[]): PlayingCard[] {
  return [...cards].sort((a, b) => {
    const rankDiff = rankValue(b.rank) - rankValue(a.rank)
    if (rankDiff !== 0) return rankDiff
    return SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit]
  })
}

function groupCardsByRank(cards: PlayingCard[]): Map<number, PlayingCard[]> {
  const groups = new Map<number, PlayingCard[]>()
  for (const card of cards) {
    const rank = rankValue(card.rank)
    const group = groups.get(rank) ?? []
    group.push(card)
    groups.set(rank, group)
  }
  for (const [rank, group] of groups.entries()) {
    groups.set(
      rank,
      [...group].sort((a, b) => SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit])
    )
  }
  return groups
}

function cardsForRank(groups: Map<number, PlayingCard[]>, rank: number): PlayingCard[] {
  return [...(groups.get(rank) ?? [])]
}

function sortStraightCardsAscending(cards: PlayingCard[], highCard: number): PlayingCard[] {
  const groups = groupCardsByRank(cards)
  const order = highCard === 5 ? [14, 2, 3, 4, 5] : [highCard - 4, highCard - 3, highCard - 2, highCard - 1, highCard]
  const ordered: PlayingCard[] = []
  for (const rank of order) {
    const card = cardsForRank(groups, rank)[0]
    if (!card) return sortCardsByRankDesc(cards)
    ordered.push(card)
  }
  return ordered
}

function sortFiveCardLine(cards: PlayingCard[]): PlayingCard[] {
  const hand = evaluateFive(cards)
  const groups = groupCardsByRank(cards)
  const restDescending = (exclude: number[]) =>
    [...groups.keys()]
      .filter((rank) => !exclude.includes(rank))
      .sort((a, b) => b - a)
      .flatMap((rank) => cardsForRank(groups, rank))

  switch (hand.category) {
    case 8:
    case 4:
      return sortStraightCardsAscending(cards, hand.kickers[0] ?? 0)
    case 7: {
      const quad = hand.kickers[0] ?? 0
      return [...cardsForRank(groups, quad), ...restDescending([quad])]
    }
    case 6: {
      const triple = hand.kickers[0] ?? 0
      const pair = hand.kickers[1] ?? 0
      return [...cardsForRank(groups, triple), ...cardsForRank(groups, pair)]
    }
    case 3: {
      const triple = hand.kickers[0] ?? 0
      return [...cardsForRank(groups, triple), ...restDescending([triple])]
    }
    case 2: {
      const pairHigh = hand.kickers[0] ?? 0
      const pairLow = hand.kickers[1] ?? 0
      return [...cardsForRank(groups, pairHigh), ...cardsForRank(groups, pairLow), ...restDescending([pairHigh, pairLow])]
    }
    case 1: {
      const pair = hand.kickers[0] ?? 0
      return [...cardsForRank(groups, pair), ...restDescending([pair])]
    }
    case 5:
    case 0:
    default:
      return sortCardsByRankDesc(cards)
  }
}

function sortThreeCardLine(cards: PlayingCard[]): PlayingCard[] {
  const hand = evaluateThree(cards)
  const groups = groupCardsByRank(cards)
  if (hand.category === 2) {
    return sortCardsByRankDesc(cards)
  }
  if (hand.category === 1) {
    const pair = hand.kickers[0] ?? 0
    return [
      ...cardsForRank(groups, pair),
      ...[...groups.keys()].filter((rank) => rank !== pair).sort((a, b) => b - a).flatMap((rank) => cardsForRank(groups, rank))
    ]
  }
  return sortCardsByRankDesc(cards)
}

export type GameTableProps = {
  state: GameState
  localPlayerId: string
  roomName?: string
  connectivityByPlayerId?: Record<string, boolean>
  waitingMessage?: string | null
  onPlace: (card: string, target: keyof LinesState) => void
  onSubmitInitial: (draft: LinesState) => void
  onResetRound: () => void
  canStartNextRound?: boolean
  nextRoundLabel?: string
  nextRoundHint?: string | null
  manualConfirmInitialPlacements?: boolean
  fourColor?: boolean
}

export function GameTable({
  state,
  localPlayerId,
  roomName,
  connectivityByPlayerId,
  waitingMessage,
  onPlace,
  onSubmitInitial,
  onResetRound,
  canStartNextRound = true,
  nextRoundLabel = 'Next Round',
  nextRoundHint = null,
  manualConfirmInitialPlacements = true,
  fourColor
}: GameTableProps) {
  const localPlayer = state.players.find((player) => player.id === localPlayerId)
  const localLines = state.lines[localPlayerId]
  const pending = state.pending[localPlayerId] ?? []
  const [draftLines, setDraftLines] = useState<DraftLines>({ top: [], middle: [], bottom: [] })
  const [draftPending, setDraftPending] = useState<string[]>([])
  const [submittedInitial, setSubmittedInitial] = useState(false)
  const [tapPlacementMode, setTapPlacementMode] = useState(false)
  const [selectedCard, setSelectedCard] = useState<SelectedCardState | null>(null)
  const [showTapPlacementHint, setShowTapPlacementHint] = useState(false)
  const [selectedOpponentId, setSelectedOpponentId] = useState('')
  const [rivalryScores, setRivalryScores] = useState<Record<string, RivalryScore>>({})
  const autoPlayPlacementKeyRef = useRef('')
  const autoInitialSubmitKeyRef = useRef('')
  const initialHydrationSignatureRef = useRef('')
  const [recentlyPlacedCards, setRecentlyPlacedCards] = useState<Set<string>>(new Set())
  const [recentlyPlacedOpponentCards, setRecentlyPlacedOpponentCards] = useState<Set<string>>(new Set())
  const prevOpponentLinesRef = useRef<Record<string, Record<string, string[]>>>({})
  const prevPhaseRef = useRef(state.phase)
  const [liveAnnouncement, setLiveAnnouncement] = useState('')
  const [showConfetti, setShowConfetti] = useState(false)
  const [phaseTransition, setPhaseTransition] = useState(false)
  const initialDraftStorageKey = useMemo(
    () => buildInitialDraftStorageKey(localPlayerId, roomName),
    [localPlayerId, roomName]
  )
  const currentRoundKey = useMemo(() => getCurrentRoundKey(state), [state])

  useEffect(() => {
    if (state.phase !== 'initial') {
      initialHydrationSignatureRef.current = ''
      clearPersistedInitialDraft(initialDraftStorageKey)
      setDraftPending([])
      setDraftLines({ top: [], middle: [], bottom: [] })
      return
    }
    const nextDraftLines: DraftLines = {
      top: (localLines?.top ?? []).map(cardToString),
      middle: (localLines?.middle ?? []).map(cardToString),
      bottom: (localLines?.bottom ?? []).map(cardToString)
    }
    const nextDraftPending = pending.map(cardToString)
    const nextSignature = draftSnapshotSignature(nextDraftLines, nextDraftPending)
    const placed =
      (localLines?.top?.length ?? 0) +
      (localLines?.middle?.length ?? 0) +
      (localLines?.bottom?.length ?? 0)
    setSubmittedInitial(pending.length === 0 && placed === 5)

    const persisted = readPersistedInitialDraft(initialDraftStorageKey)
    const restored = resolvePersistedInitialDraft({
      persisted,
      roundKey: currentRoundKey,
      baseSignature: nextSignature,
      authoritativeLines: nextDraftLines,
      authoritativePending: nextDraftPending
    })
    if (!restored && persisted) {
      clearPersistedInitialDraft(initialDraftStorageKey)
    }
    const hydratedDraftLines = restored?.draftLines ?? nextDraftLines
    const hydratedDraftPending = restored?.draftPending ?? nextDraftPending
    const hydratedSignature = draftSnapshotSignature(hydratedDraftLines, hydratedDraftPending)
    if (initialHydrationSignatureRef.current === hydratedSignature) return
    initialHydrationSignatureRef.current = hydratedSignature
    setDraftLines(hydratedDraftLines)
    setDraftPending(hydratedDraftPending)
  }, [currentRoundKey, initialDraftStorageKey, localLines, pending, state.phase])

  useEffect(() => {
    if (state.phase !== 'initial' || submittedInitial) {
      clearPersistedInitialDraft(initialDraftStorageKey)
      return
    }
    if (!initialHydrationSignatureRef.current) return
    const authoritativeLines: DraftLines = {
      top: (localLines?.top ?? []).map(cardToString),
      middle: (localLines?.middle ?? []).map(cardToString),
      bottom: (localLines?.bottom ?? []).map(cardToString)
    }
    const authoritativePending = pending.map(cardToString)
    writePersistedInitialDraft(initialDraftStorageKey, {
      version: 1,
      roundKey: currentRoundKey,
      baseSignature: draftSnapshotSignature(authoritativeLines, authoritativePending),
      draftLines,
      draftPending,
      savedAt: Date.now()
    })
  }, [
    currentRoundKey,
    draftLines,
    draftPending,
    initialDraftStorageKey,
    localLines,
    pending,
    state.phase,
    submittedInitial
  ])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(hover: none) and (pointer: coarse)')
    const updateMode = () => setTapPlacementMode(media.matches)
    updateMode()

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', updateMode)
      return () => media.removeEventListener('change', updateMode)
    }

    media.addListener(updateMode)
    return () => media.removeListener(updateMode)
  }, [])

  useEffect(() => {
    if (!tapPlacementMode) {
      setSelectedCard(null)
      setShowTapPlacementHint(false)
      return
    }

    if (typeof window === 'undefined') {
      setShowTapPlacementHint(true)
      return
    }

    try {
      setShowTapPlacementHint(window.localStorage.getItem(TAP_PLACEMENT_HINT_DISMISSED_KEY) !== '1')
    } catch {
      setShowTapPlacementHint(true)
    }
  }, [tapPlacementMode])

  const pendingCards = useMemo(() => pending.map(cardToString), [pending])
  const visiblePendingCards = state.phase === 'initial' ? draftPending : pendingCards


  const canDraw = state.phase === 'play' && state.turnStage === 'draw' && localPlayer?.seat === state.turnSeat
  const canPlace = state.phase === 'play' && state.turnStage === 'place' && localPlayer?.seat === state.turnSeat
  const canAdjustInitial = state.phase === 'initial' && !submittedInitial
  const canSubmitInitial = state.phase === 'initial' && draftPending.length === 0 && !submittedInitial
  const canSelectPendingCard =
    (state.phase === 'initial' && canAdjustInitial) || (state.phase === 'play' && canPlace)
  const canSelectLineCard = state.phase === 'initial' && canAdjustInitial

  const moveDraftCardToLine = (card: string, target: keyof LinesState): boolean => {
    const targetCardCount = draftLines[target].filter((lineCard) => lineCard !== card).length
    if (targetCardCount >= LINE_LIMITS[target]) return false

    const nextLines: DraftLines = {
      top: [...draftLines.top],
      middle: [...draftLines.middle],
      bottom: [...draftLines.bottom]
    }
    for (const key of DRAFT_LINE_KEYS) {
      nextLines[key] = nextLines[key].filter((lineCard) => lineCard !== card)
    }
    nextLines[target] = [...nextLines[target], card]

    setDraftLines(nextLines)
    setDraftPending(draftPending.filter((pendingCard) => pendingCard !== card))
    return true
  }

  const moveDraftCardToPending = (card: string): boolean => {
    const nextLines: DraftLines = {
      top: [...draftLines.top],
      middle: [...draftLines.middle],
      bottom: [...draftLines.bottom]
    }
    for (const key of DRAFT_LINE_KEYS) {
      nextLines[key] = nextLines[key].filter((lineCard) => lineCard !== card)
    }

    setDraftLines(nextLines)
    setDraftPending(draftPending.includes(card) ? draftPending : [...draftPending, card])
    return true
  }

  const canTapPlaceOnLine = (target: keyof LinesState) => {
    if (!tapPlacementMode || !selectedCard) return false
    if (state.phase === 'play') {
      return canPlace && selectedCard.source === 'pending'
    }
    if (state.phase !== 'initial' || !canAdjustInitial) return false
    const targetCardCount = draftLines[target].filter((lineCard) => lineCard !== selectedCard.card).length
    return targetCardCount < LINE_LIMITS[target]
  }

  const canTapReturnToPending =
    tapPlacementMode &&
    state.phase === 'initial' &&
    canAdjustInitial &&
    selectedCard?.source === 'line'
  const shouldShowTapPlacementHint =
    showTapPlacementHint &&
    tapPlacementMode &&
    ((state.phase === 'initial' && canAdjustInitial) || (state.phase === 'play' && canPlace)) &&
    visiblePendingCards.length > 0

  const dismissTapPlacementHint = () => {
    setShowTapPlacementHint(false)
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(TAP_PLACEMENT_HINT_DISMISSED_KEY, '1')
    } catch {
      // Ignore storage write failures.
    }
  }

  const selectPendingCard = (card: string) => {
    if (!tapPlacementMode || !canSelectPendingCard) return
    setSelectedCard((current) =>
      current?.source === 'pending' && current.card === card ? null : { source: 'pending', card }
    )
  }

  const selectLineCard = (card: string, line: keyof LinesState) => {
    if (!tapPlacementMode || !canSelectLineCard) return
    setSelectedCard((current) =>
      current?.source === 'line' && current.line === line && current.card === card
        ? null
        : { source: 'line', line, card }
    )
  }

  const returnCardToPending = (card: string) => {
    if (moveDraftCardToPending(card)) {
      setSelectedCard(null)
    }
  }

  const placeSelectedCardOnLine = (target: keyof LinesState) => {
    if (!tapPlacementMode || !selectedCard) return

    if (state.phase === 'play') {
      if (canPlace && selectedCard.source === 'pending') {
        markCardPlaced(selectedCard.card)
        onPlace(selectedCard.card, target)
        dismissTapPlacementHint()
        setSelectedCard(null)
      }
      return
    }

    if (state.phase !== 'initial' || !canAdjustInitial) return
    markCardPlaced(selectedCard.card)
    if (!moveDraftCardToLine(selectedCard.card, target)) return
    dismissTapPlacementHint()
    setSelectedCard(null)
  }

  const opponents = useMemo(() => state.players.filter((player) => player.id !== localPlayerId), [state, localPlayerId])
  const isConnected = (playerId: string): boolean =>
    connectivityByPlayerId?.[playerId] ?? (playerId === localPlayerId)
  const currentOpponentId = selectedOpponentId || opponents[0]?.id || ''
  const matchupByOpponent = useMemo(() => {
    const map: Record<string, HeadsUpDetailedResult> = {}
    if (state.phase !== 'score') return map
    if (!localLines) return map
    for (const opponent of opponents) {
      const opponentLines = state.lines[opponent.id]
      if (!opponentLines) continue
      map[opponent.id] = scoreHeadsUpDetailed(localLines, opponentLines)
    }
    return map
  }, [localLines, opponents, state])

  useEffect(() => {
    if (opponents.length === 0) {
      setSelectedOpponentId('')
      return
    }
    if (!opponents.some((player) => player.id === selectedOpponentId)) {
      setSelectedOpponentId(opponents[0]?.id ?? '')
    }
  }, [opponents, selectedOpponentId])

  useEffect(() => {
    setRivalryScores(readRivalryScores(localPlayerId))
  }, [localPlayerId])

  useEffect(() => {
    if (state.phase !== 'score') return
    if (!localLines) return

    const roundKey = getCurrentRoundKey(state)
    if (!roundKey) return

    const results: Array<{ opponentId: string; name: string; total: number }> = []
    for (const opponent of opponents) {
      const opponentLines = state.lines[opponent.id]
      if (!opponentLines) continue
      const result = scoreHeadsUpDetailed(localLines, opponentLines)
      results.push({
        opponentId: opponent.id,
        name: opponent.name,
        total: result.player.total
      })
    }

    if (results.length === 0) return
    const updated = persistRivalryRound(localPlayerId, roundKey, results)
    setRivalryScores(updated)
  }, [localLines, localPlayerId, opponents, state])

  const selectedMatchup = currentOpponentId ? matchupByOpponent[currentOpponentId] : undefined
  const localRoyalties =
    state.phase === 'score' && localLines
      ? royaltiesBreakdown(localLines)
      : { top: 0, middle: 0, bottom: 0, total: 0 }
  const localRoyaltyTextByLine = useMemo(
    () =>
      buildRoyaltyTextByLine(localLines, {
        top: localRoyalties.top,
        middle: localRoyalties.middle,
        bottom: localRoyalties.bottom
      }),
    [localLines, localRoyalties.bottom, localRoyalties.middle, localRoyalties.top]
  )
  const opponentRoyaltyTextById = useMemo(() => {
    const map: Record<string, Record<keyof LinesState, string | null>> = {}
    for (const opponent of opponents) {
      const opponentLines = state.lines[opponent.id]
      const points = matchupByOpponent[opponent.id]?.opponent.royaltiesByLine
      map[opponent.id] = buildRoyaltyTextByLine(opponentLines, {
        top: points?.top ?? 0,
        middle: points?.middle ?? 0,
        bottom: points?.bottom ?? 0
      })
    }
    return map
  }, [matchupByOpponent, opponents, state.lines])
  const localFoulAnalysis = useMemo(() => {
    if (!selectedMatchup?.fouls.player || !localLines) return null
    return analyzeFoul(localLines)
  }, [localLines, selectedMatchup?.fouls.player])
  const opponentFoulAnalysisById = useMemo(() => {
    const map: Record<string, FoulAnalysis | undefined> = {}
    for (const opponent of opponents) {
      if (!matchupByOpponent[opponent.id]?.fouls.opponent) continue
      const opponentLines = state.lines[opponent.id]
      if (!opponentLines) continue
      map[opponent.id] = analyzeFoul(opponentLines)
    }
    return map
  }, [matchupByOpponent, opponents, state.lines])

  useEffect(() => {
    if (!canPlace || !localLines || pendingCards.length !== 1) {
      autoPlayPlacementKeyRef.current = ''
      return
    }
    const forcedLine = forcedLineFromLengths({
      top: localLines.top.length,
      middle: localLines.middle.length,
      bottom: localLines.bottom.length
    })
    if (!forcedLine) {
      autoPlayPlacementKeyRef.current = ''
      return
    }
    const card = pendingCards[0]
    if (!card) return
    const key = `${state.turnSeat}:${state.drawIndex}:${card}:${forcedLine}`
    if (autoPlayPlacementKeyRef.current === key) return
    autoPlayPlacementKeyRef.current = key
    setSelectedCard(null)
    onPlace(card, forcedLine)
  }, [canPlace, localLines, onPlace, pendingCards, state.drawIndex, state.turnSeat])

  useEffect(() => {
    if (state.phase !== 'initial' || submittedInitial || draftPending.length === 0) {
      autoInitialSubmitKeyRef.current = ''
      return
    }
    const forcedLine = forcedLineFromLengths({
      top: draftLines.top.length,
      middle: draftLines.middle.length,
      bottom: draftLines.bottom.length
    })
    if (!forcedLine) {
      autoInitialSubmitKeyRef.current = ''
      return
    }
    const remainingSlots = LINE_LIMITS[forcedLine] - draftLines[forcedLine].length
    if (remainingSlots !== draftPending.length) return

    const key = `${forcedLine}:${draftLines.top.length}-${draftLines.middle.length}-${draftLines.bottom.length}:${draftPending.join(',')}`
    if (autoInitialSubmitKeyRef.current === key) return
    autoInitialSubmitKeyRef.current = key

    const finalDraft: DraftLines = {
      top: [...draftLines.top],
      middle: [...draftLines.middle],
      bottom: [...draftLines.bottom]
    }
    finalDraft[forcedLine] = [...finalDraft[forcedLine], ...draftPending]

    setDraftLines(finalDraft)
    setDraftPending([])
    setSubmittedInitial(true)
    setSelectedCard(null)
    onSubmitInitial({
      top: finalDraft.top.map(stringToCardSafe),
      middle: finalDraft.middle.map(stringToCardSafe),
      bottom: finalDraft.bottom.map(stringToCardSafe)
    })
  }, [draftLines, draftPending, onSubmitInitial, state.phase, submittedInitial])

  const handleDrop = (event: DragEvent<HTMLDivElement>, target: keyof LinesState) => {
    event.preventDefault()
    const payload = event.dataTransfer.getData('application/json')
    const parsed = parseDragPayload(payload)
    const card = parsed?.card ?? event.dataTransfer.getData('text/plain')
    if (!card) return

    markCardPlaced(card)
    if (state.phase !== 'initial') {
      onPlace(card, target)
      return
    }
    if (!canAdjustInitial) return
    if (moveDraftCardToLine(card, target)) {
      setSelectedCard(null)
    }
  }

  const allowDrop = (event: DragEvent<HTMLDivElement>) => event.preventDefault()
  const allowDropIfActive = (event: DragEvent<HTMLDivElement>) => {
    if (canAdjustInitial || canPlace) event.preventDefault()
  }

  const submitInitial = () => {
    if (!canSubmitInitial) return
    setSubmittedInitial(true)
    setSelectedCard(null)
    onSubmitInitial({
      top: draftLines.top.map(stringToCardSafe),
      middle: draftLines.middle.map(stringToCardSafe),
      bottom: draftLines.bottom.map(stringToCardSafe)
    })
  }

  useEffect(() => {
    if (!manualConfirmInitialPlacements && canSubmitInitial) {
      submitInitial()
    }
  }, [canSubmitInitial, manualConfirmInitialPlacements])

  useEffect(() => {
    if (state.phase !== 'initial') {
      setSubmittedInitial(false)
    }
  }, [state.phase])

  useEffect(() => {
    if (!selectedCard) return

    if (state.phase === 'initial') {
      if (selectedCard.source === 'pending') {
        if (!draftPending.includes(selectedCard.card)) {
          setSelectedCard(null)
        }
        return
      }

      if (!draftLines[selectedCard.line].includes(selectedCard.card)) {
        setSelectedCard(null)
      }
      return
    }

    if (state.phase === 'play') {
      if (selectedCard.source !== 'pending' || !pendingCards.includes(selectedCard.card)) {
        setSelectedCard(null)
      }
      return
    }

    setSelectedCard(null)
  }, [draftLines, draftPending, pendingCards, selectedCard, state.phase])

  // Track phase transitions for animation + aria-live announcements
  useEffect(() => {
    if (prevPhaseRef.current !== state.phase) {
      const prevPhase = prevPhaseRef.current
      prevPhaseRef.current = state.phase
      setPhaseTransition(true)
      const timer = setTimeout(() => setPhaseTransition(false), 500)

      // Generate aria-live announcement for screen readers
      if (state.phase === 'initial' && prevPhase !== 'initial') {
        setLiveAnnouncement('New round started. Arrange your starting hand.')
      } else if (state.phase === 'play') {
        setLiveAnnouncement('Play phase. Place cards one at a time.')
      } else if (state.phase === 'score') {
        setLiveAnnouncement('Round complete. Scores are being shown.')
      }

      return () => clearTimeout(timer)
    }
  }, [state.phase])

  // Confetti on sweep win
  useEffect(() => {
    if (state.phase !== 'score') { setShowConfetti(false); return }
    const hasSweepWin = Object.values(matchupByOpponent).some((m) => m.sweep && m.player.total > 0)
    if (hasSweepWin) {
      setShowConfetti(true)
      const timer = setTimeout(() => setShowConfetti(false), 3000)
      return () => clearTimeout(timer)
    }
  }, [state.phase, matchupByOpponent])

  // Track recently placed cards for entrance animation
  const markCardPlaced = useCallback((card: string) => {
    setRecentlyPlacedCards((prev) => new Set(prev).add(card))
    setTimeout(() => {
      setRecentlyPlacedCards((prev) => {
        const next = new Set(prev)
        next.delete(card)
        return next
      })
    }, 350)
  }, [])

  // Track opponent card placements for enter animation
  useEffect(() => {
    const newCards = new Set<string>()
    for (const player of opponents) {
      const prevLines = prevOpponentLinesRef.current[player.id]
      const currLines = state.lines[player.id]
      if (!currLines) continue
      for (const line of ['top', 'middle', 'bottom'] as const) {
        const prevCards = new Set(prevLines?.[line] ?? [])
        for (const card of (currLines[line] ?? [])) {
          const cs = typeof card === 'string' ? card : cardToString(card)
          if (!prevCards.has(cs)) newCards.add(cs)
        }
      }
    }
    if (newCards.size > 0) {
      setRecentlyPlacedOpponentCards((prev) => {
        const next = new Set(prev)
        for (const c of newCards) next.add(c)
        return next
      })
      setTimeout(() => {
        setRecentlyPlacedOpponentCards((prev) => {
          const next = new Set(prev)
          for (const c of newCards) next.delete(c)
          return next
        })
      }, 400)
    }
    // Snapshot current opponent lines
    const snapshot: Record<string, Record<string, string[]>> = {}
    for (const player of opponents) {
      const lines = state.lines[player.id]
      if (!lines) continue
      snapshot[player.id] = {
        top: (lines.top ?? []).map((c) => typeof c === 'string' ? c : cardToString(c)),
        middle: (lines.middle ?? []).map((c) => typeof c === 'string' ? c : cardToString(c)),
        bottom: (lines.bottom ?? []).map((c) => typeof c === 'string' ? c : cardToString(c))
      }
    }
    prevOpponentLinesRef.current = snapshot
  }, [opponents, state.lines])

  // Keyboard card placement: Left/Right to select, 1/2/3 to place on top/middle/bottom
  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      // Don't interfere with inputs or modals
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return

      const pending = visiblePendingCards
      if (pending.length === 0) return

      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        setSelectedCard((current) => {
          const currentIndex = current?.source === 'pending' ? pending.indexOf(current.card) : -1
          let nextIndex: number
          if (event.key === 'ArrowRight') {
            nextIndex = currentIndex < pending.length - 1 ? currentIndex + 1 : 0
          } else {
            nextIndex = currentIndex > 0 ? currentIndex - 1 : pending.length - 1
          }
          const card = pending[nextIndex]
          return card ? { source: 'pending' as const, card } : null
        })
        return
      }

      const lineMap: Record<string, keyof LinesState> = { '1': 'top', '2': 'middle', '3': 'bottom' }
      const targetLine = lineMap[event.key]
      if (!targetLine) return

      if (selectedCard?.source === 'pending') {
        event.preventDefault()
        if (state.phase === 'play' && canPlace) {
          markCardPlaced(selectedCard.card)
          onPlace(selectedCard.card, targetLine)
          setSelectedCard(null)
        } else if (state.phase === 'initial' && canAdjustInitial) {
          if (moveDraftCardToLine(selectedCard.card, targetLine)) {
            markCardPlaced(selectedCard.card)
            setSelectedCard(null)
          }
        }
      }
    }

    document.addEventListener('keydown', handleKeyboard)
    return () => document.removeEventListener('keydown', handleKeyboard)
  }, [visiblePendingCards, selectedCard, state.phase, canPlace, canAdjustInitial, markCardPlaced, onPlace, moveDraftCardToLine])

  // Contextual status message
  const statusMessage = useMemo(() => {
    const turnPlayer = state.players.find((p) => p.seat === state.turnSeat)
    const turnName = turnPlayer?.id === localPlayerId ? 'You' : (turnPlayer?.name ?? 'Opponent')

    if (waitingMessage && (state.phase === 'lobby' || (state.phase === 'play' && !canPlace && !canDraw))) {
      return waitingMessage
    }

    switch (state.phase) {
      case 'lobby':
        return 'Waiting for players...'
      case 'commit':
      case 'reveal':
        return 'Shuffling deck...'
      case 'initial':
        return submittedInitial
          ? 'Waiting for others...'
          : tapPlacementMode
            ? 'Tap a card, then tap a row'
            : 'Arrange your starting hand'
      case 'play':
        if (canPlace) return tapPlacementMode ? 'Tap your card, then a row' : 'Place your card'
        if (canDraw) return 'Drawing...'
        return `Waiting for ${turnName}...`
      case 'score':
        return 'Round Complete'
      default:
        return ''
    }
  }, [state.phase, state.turnSeat, state.players, localPlayerId, submittedInitial, canPlace, canDraw, tapPlacementMode, waitingMessage])

  // Which seat is currently active (for turn indicator)
  const activeSeat = (state.phase === 'play' || state.phase === 'initial') ? state.turnSeat : -1

  return (
    <section className={`panel table-shell${phaseTransition ? ' phase-transition' : ''}${state.phase === 'score' ? ' score-phase' : ''}`}>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{liveAnnouncement}</div>
      <div className="table-header">
        <div className="table-status">
          <div>
            <div className="status-message">{statusMessage}</div>
            <div className="status-detail">
              {localPlayer?.name ?? 'You'}
              {localPlayer?.seat === state.dealerSeat && <span className="dealer-chip">D</span>}
            </div>
            {roomName ? <div className="status-room">Room: {roomName}</div> : null}
          </div>
        </div>
        <div className="table-actions">
          {state.phase === 'initial' && (
            <>
              {manualConfirmInitialPlacements && (
                <button className={`button btn-sm${canSubmitInitial ? ' submit-ready-pulse' : ''}`} onClick={submitInitial} disabled={!canSubmitInitial}>
                  Confirm Hand
                </button>
              )}
            </>
          )}
          {state.phase === 'score' && (
            <>
              <button className="button btn-sm" onClick={onResetRound} disabled={!canStartNextRound}>
                {nextRoundLabel}
              </button>
              {!canStartNextRound && nextRoundHint ? <span className="status-detail">{nextRoundHint}</span> : null}
            </>
          )}
        </div>
      </div>

      {/* Local player - prominent, full width */}
      <div className={`local-seat ${localPlayer?.seat === activeSeat ? 'seat-active' : ''}`}>
        <div className="seat-head">
          <div className="seat-title-wrap">
            <div className="seat-title">Your Hand</div>
          </div>
          <div className="seat-status">
            {state.phase === 'score' && selectedMatchup?.fouls.player && <FoulBadge analysis={localFoulAnalysis} />}
            {state.phase === 'score' && selectedMatchup && (
              <div
                className={`hand-result score-badge-enter ${
                  selectedMatchup.player.total > 0
                    ? 'hand-result-win'
                    : selectedMatchup.player.total < 0
                      ? 'hand-result-loss'
                      : 'hand-result-tie'
                }`}
                title={`Vs ${opponents.find((player) => player.id === currentOpponentId)?.name ?? 'Opponent'}`}
              >
                {formatSigned(selectedMatchup.player.total)}
              </div>
            )}
          </div>
        </div>
        {state.phase === 'score' && opponents.length > 1 && (
          <label className="score-compare">
            <span className="score-compare-label">Compare vs</span>
            <select
              className="score-compare-select"
              value={currentOpponentId}
              onChange={(event) => setSelectedOpponentId(event.target.value)}
            >
              {opponents.map((player) => (
                <option key={player.id} value={player.id}>
                  {player.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="line-stack">
          <DropLine
            label="Top"
            count={3}
            lineKey="top"
            cards={toCardStrings(state.phase === 'initial' ? draftLines.top : localLines?.top ?? [])}
            onDrop={(event) => handleDrop(event, 'top')}
            onDragOver={(canAdjustInitial || canPlace) ? allowDrop : allowDropIfActive}
            onLineTap={tapPlacementMode ? () => placeSelectedCardOnLine('top') : undefined}
            onCardTap={tapPlacementMode ? selectLineCard : (canAdjustInitial ? (card) => returnCardToPending(card) : undefined)}
            draggable={!tapPlacementMode && canAdjustInitial}
            selectedCard={selectedCard}
            tapTargetState={selectedCard && tapPlacementMode ? (canTapPlaceOnLine('top') ? 'active' : 'blocked') : undefined}
            fourColor={fourColor}
            scoreTone={overlayTone(selectedMatchup?.lines.top, hasBonus(selectedMatchup?.player))}
            royaltyText={localRoyaltyTextByLine.top}
            showScore={state.phase === 'score'}
            recentlyPlaced={recentlyPlacedCards}
          />
          <DropLine
            label="Middle"
            count={5}
            lineKey="middle"
            cards={toCardStrings(state.phase === 'initial' ? draftLines.middle : localLines?.middle ?? [])}
            onDrop={(event) => handleDrop(event, 'middle')}
            onDragOver={(canAdjustInitial || canPlace) ? allowDrop : allowDropIfActive}
            onLineTap={tapPlacementMode ? () => placeSelectedCardOnLine('middle') : undefined}
            onCardTap={tapPlacementMode ? selectLineCard : (canAdjustInitial ? (card) => returnCardToPending(card) : undefined)}
            draggable={!tapPlacementMode && canAdjustInitial}
            selectedCard={selectedCard}
            tapTargetState={selectedCard && tapPlacementMode ? (canTapPlaceOnLine('middle') ? 'active' : 'blocked') : undefined}
            fourColor={fourColor}
            scoreTone={overlayTone(selectedMatchup?.lines.middle, hasBonus(selectedMatchup?.player))}
            royaltyText={localRoyaltyTextByLine.middle}
            showScore={state.phase === 'score'}
            recentlyPlaced={recentlyPlacedCards}
          />
          <DropLine
            label="Bottom"
            count={5}
            lineKey="bottom"
            cards={toCardStrings(state.phase === 'initial' ? draftLines.bottom : localLines?.bottom ?? [])}
            onDrop={(event) => handleDrop(event, 'bottom')}
            onDragOver={(canAdjustInitial || canPlace) ? allowDrop : allowDropIfActive}
            onLineTap={tapPlacementMode ? () => placeSelectedCardOnLine('bottom') : undefined}
            onCardTap={tapPlacementMode ? selectLineCard : (canAdjustInitial ? (card) => returnCardToPending(card) : undefined)}
            draggable={!tapPlacementMode && canAdjustInitial}
            selectedCard={selectedCard}
            tapTargetState={selectedCard && tapPlacementMode ? (canTapPlaceOnLine('bottom') ? 'active' : 'blocked') : undefined}
            fourColor={fourColor}
            scoreTone={overlayTone(selectedMatchup?.lines.bottom, hasBonus(selectedMatchup?.player))}
            royaltyText={localRoyaltyTextByLine.bottom}
            showScore={state.phase === 'score'}
            recentlyPlaced={recentlyPlacedCards}
          />
        </div>
      </div>

      {/* Pending cards tray - directly below local lines */}
      <div
        className={`pending-tray${canTapReturnToPending ? ' pending-tray-tap-active' : ''}${state.phase === 'play' && pendingCards.length <= 1 ? ' pending-tray-compact' : ''}`}
        onClick={() => {
          if (!canTapReturnToPending || selectedCard?.source !== 'line') return
          if (moveDraftCardToPending(selectedCard.card)) {
            setSelectedCard(null)
          }
        }}
        onDrop={(event) => {
          if (state.phase !== 'initial' || !canAdjustInitial) return
          event.preventDefault()
          const payload = event.dataTransfer.getData('application/json')
          const parsed = parseDragPayload(payload)
          const card = parsed?.card ?? event.dataTransfer.getData('text/plain')
          if (!card) return
          if (moveDraftCardToPending(card)) {
            setSelectedCard(null)
          }
        }}
        onDragOver={allowDropIfActive}
      >
        <div className="pending-title-row">
          <div className="pending-title">Your Cards</div>
          {tapPlacementMode && (
            <div className="pending-tip">
              {selectedCard
                ? `Selected ${selectedCard.card}`
                : shouldShowTapPlacementHint
                  ? 'Tip: Tap a card, then tap a row'
                  : 'Tap a card to select'}
            </div>
          )}
        </div>
        <div className="cards">
          {visiblePendingCards.map((item) => (
            <div className="card-enter" key={item}>
              <Card
                value={item}
                draggable={!tapPlacementMode && (canAdjustInitial || canPlace)}
                onClick={tapPlacementMode ? selectPendingCard : undefined}
                dragPayload={{ source: 'pending', card: item }}
                selected={selectedCard?.source === 'pending' && selectedCard.card === item}
                fourColor={fourColor}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Opponents - compact, below */}
      <div className="opponents-row">
        {opponents.map((player) => {
          const isActive = player.seat === activeSeat
          return (
            <div key={player.id} className={`seat seat-opponent ${isActive ? 'seat-active' : ''}`}>
              <div className="seat-head">
                <div className="seat-title-wrap">
                  <div className="seat-title">{player.name}</div>
                  {player.seat === state.dealerSeat && (
                    <span className="dealer-chip" title="Dealer button">D</span>
                  )}
                </div>
                <div className="seat-status">
                  {state.phase === 'score' && matchupByOpponent[player.id]?.fouls.opponent && (
                    <FoulBadge analysis={opponentFoulAnalysisById[player.id]} />
                  )}
                  {state.phase === 'score' && matchupByOpponent[player.id] && (
                    <div
                      className={`hand-result ${
                        (matchupByOpponent[player.id]?.opponent.total ?? 0) > 0
                          ? 'hand-result-win'
                          : (matchupByOpponent[player.id]?.opponent.total ?? 0) < 0
                            ? 'hand-result-loss'
                            : 'hand-result-tie'
                      }`}
                      title={`Vs ${localPlayer?.name ?? 'You'}`}
                    >
                      {formatSigned(matchupByOpponent[player.id]?.opponent.total ?? 0)}
                    </div>
                  )}
                </div>
              </div>
              <div className="seat-sub">
                {isActive && state.phase === 'play' && <span className="turn-dot" />}
                {(() => {
                  const connected = isConnected(player.id)
                  const pendingCount = state.pending[player.id]?.length ?? 0
                  if (!connected) return `Reconnecting\u2026`
                  if (state.phase === 'score') return null
                  if (isActive && state.phase === 'play') return 'Thinking\u2026'
                  if (state.phase === 'initial') return pendingCount > 0 ? 'Arranging hand\u2026' : 'Ready'
                  if (pendingCount > 0) return `${pendingCount} card${pendingCount !== 1 ? 's' : ''} in hand`
                  return null
                })()}
              </div>
              {state.phase !== 'score' && (state.pending[player.id]?.length ?? 0) > 0 && (
                <div className="opponent-hand-backs">
                  {Array.from({ length: state.pending[player.id]?.length ?? 0 }, (_, i) => (
                    <div key={i} className="card-back" />
                  ))}
                </div>
              )}
              <div className="line-stack">
                <Line
                  label="Top"
                  lineKey="top"
                  cards={state.lines[player.id]?.top ?? []}
                  fourColor={fourColor}
                  size="small"
                  scoreTone={overlayTone(
                    invertOutcome(matchupByOpponent[player.id]?.lines.top),
                    hasBonus(matchupByOpponent[player.id]?.opponent)
                  )}
                  royaltyText={opponentRoyaltyTextById[player.id]?.top ?? null}
                  showScore={state.phase === 'score'}
                  recentlyPlaced={recentlyPlacedOpponentCards}
                />
                <Line
                  label="Middle"
                  lineKey="middle"
                  cards={state.lines[player.id]?.middle ?? []}
                  fourColor={fourColor}
                  size="small"
                  scoreTone={overlayTone(
                    invertOutcome(matchupByOpponent[player.id]?.lines.middle),
                    hasBonus(matchupByOpponent[player.id]?.opponent)
                  )}
                  royaltyText={opponentRoyaltyTextById[player.id]?.middle ?? null}
                  showScore={state.phase === 'score'}
                  recentlyPlaced={recentlyPlacedOpponentCards}
                />
                <Line
                  label="Bottom"
                  lineKey="bottom"
                  cards={state.lines[player.id]?.bottom ?? []}
                  fourColor={fourColor}
                  size="small"
                  scoreTone={overlayTone(
                    invertOutcome(matchupByOpponent[player.id]?.lines.bottom),
                    hasBonus(matchupByOpponent[player.id]?.opponent)
                  )}
                  royaltyText={opponentRoyaltyTextById[player.id]?.bottom ?? null}
                  showScore={state.phase === 'score'}
                  recentlyPlaced={recentlyPlacedOpponentCards}
                />
              </div>
            </div>
          )
        })}
      </div>

      {state.phase === 'score' && (
        <div className="score-panel">
          <h3>Rivalry Scores</h3>
          <RivalryPanel
            rivalryScores={rivalryScores}
            currentOpponent={opponents.find((player) => player.id === currentOpponentId) ?? null}
            presentOpponentIds={new Set(opponents.map((player) => player.id))}
          />
        </div>
      )}

      {showConfetti && (
        <div className="confetti-container" aria-hidden="true">
          {Array.from({ length: 40 }, (_, i) => (
            <div
              key={i}
              className="confetti-piece"
              style={{
                left: `${Math.random() * 100}%`,
                animationDelay: `${Math.random() * 0.8}s`,
                animationDuration: `${1.5 + Math.random() * 1.5}s`,
                backgroundColor: ['#f5a623', '#e74c3c', '#3498db', '#2ecc71', '#9b59b6', '#e67e22'][i % 6],
                width: `${6 + Math.random() * 6}px`,
                height: `${6 + Math.random() * 6}px`,
                borderRadius: i % 3 === 0 ? '50%' : i % 3 === 1 ? '2px' : '0',
                transform: `rotate(${Math.random() * 360}deg)`,
              }}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function Line({
  label,
  lineKey,
  cards,
  fourColor,
  size = 'normal',
  scoreTone,
  royaltyText,
  showScore,
  count,
  recentlyPlaced
}: {
  label: string
  lineKey: keyof LinesState
  cards: PlayingCard[]
  fourColor?: boolean
  size?: 'normal' | 'small'
  scoreTone?: 'win' | 'win-strong' | 'loss' | 'tie'
  royaltyText?: string | null
  showScore?: boolean
  count?: number
  recentlyPlaced?: Set<string>
}) {
  const slotCount = lineKey === 'top' ? 3 : 5
  const sizeClass = size === 'small' ? 'line-size-small' : 'line-size-normal'
  const staggerClass = showScore && scoreTone
    ? `score-line-reveal${lineKey === 'middle' ? ' score-line-reveal-delay-1' : lineKey === 'bottom' ? ' score-line-reveal-delay-2' : ''}`
    : ''
  const lineClass = `${scoreTone ? `line line-score-${scoreTone}` : 'line'} line-cap-${slotCount} ${sizeClass} ${staggerClass}`.trim()
  const orderedCards = sortLineCardsForDisplay(lineKey, cards.map(cardToString))
  const handRank = showScore ? handRankLabelForDisplay(lineKey, orderedCards) : null
  const lineMeta =
    handRank && royaltyText ? `${handRank} ${royaltyText}` : handRank ?? (showScore ? royaltyText : null)
  const emptySlots = Math.max(0, slotCount - orderedCards.length)
  return (
    <div className={lineClass}>
      <div className="line-header">
        <div className="line-label">{label}{count !== undefined && <span className="line-count"> ({count})</span>}</div>
        {lineMeta ? <div className="line-royalty">{lineMeta}</div> : null}
      </div>
      <div className="cards">
        {orderedCards.map((card) => {
          const cardStr = typeof card === 'string' ? card : `${card}`
          return (
            <div key={cardStr} className={recentlyPlaced?.has(cardStr) ? 'card-opponent-enter' : ''}>
              <Card value={cardStr} fourColor={fourColor} size={size} />
            </div>
          )
        })}
        {Array.from({ length: emptySlots }, (_, i) => (
          <div key={`empty-${i}`} className={`card-slot-empty${size === 'small' ? ' card-slot-empty-sm' : ''}`} />
        ))}
      </div>
    </div>
  )
}

function DropLine({
  label,
  lineKey,
  cards,
  onDrop,
  onDragOver,
  onLineTap,
  onCardTap,
  draggable,
  selectedCard,
  tapTargetState,
  fourColor,
  scoreTone,
  royaltyText,
  showScore,
  recentlyPlaced,
  count
}: {
  label: string
  lineKey: keyof LinesState
  cards: string[]
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onLineTap?: () => void
  onCardTap?: (card: string, line: keyof LinesState) => void
  draggable: boolean
  selectedCard: SelectedCardState | null
  tapTargetState?: 'active' | 'blocked'
  fourColor?: boolean
  scoreTone?: 'win' | 'win-strong' | 'loss' | 'tie'
  royaltyText?: string | null
  showScore?: boolean
  recentlyPlaced?: Set<string>
  count?: number
}) {
  const slotCount = lineKey === 'top' ? 3 : 5
  const lineClass = `line drop line-cap-${slotCount} line-size-normal${scoreTone ? ` line-score-${scoreTone}` : ''}${tapTargetState ? ` line-tap-${tapTargetState}` : ''}`
  const orderedCards = sortLineCardsForDisplay(lineKey, cards)
  const handRank = showScore ? handRankLabelForDisplay(lineKey, orderedCards) : null
  const lineMeta =
    handRank && royaltyText ? `${handRank} ${royaltyText}` : handRank ?? (showScore ? royaltyText : null)
  const emptySlots = Math.max(0, slotCount - orderedCards.length)
  return (
    <div className={lineClass} onDrop={onDrop} onDragOver={onDragOver} onClick={onLineTap}>
      <div className="line-header">
        <div className="line-label">{label}{count !== undefined && <span className="line-count"> ({count})</span>}</div>
        {lineMeta ? <div className="line-royalty">{lineMeta}</div> : null}
      </div>
      <div className="cards">
        {orderedCards.map((card) => (
          <div key={card} className={recentlyPlaced?.has(card) ? 'card-place-enter' : ''}>
            <Card
              value={card}
              draggable={draggable}
              onClick={(value) => onCardTap?.(value, lineKey)}
              dragPayload={{ source: 'line', line: lineKey, card }}
              selected={selectedCard?.source === 'line' && selectedCard.line === lineKey && selectedCard.card === card}
              fourColor={fourColor}
            />
          </div>
        ))}
        {Array.from({ length: emptySlots }, (_, i) => (
          <div key={`empty-${i}`} className="card-slot-empty" />
        ))}
      </div>
    </div>
  )
}

function FoulBadge({ analysis }: { analysis?: FoulAnalysis | null }) {
  return (
    <div className="foul-badge" title={foulBadgeTitle(analysis)}>
      <span className="foul-icon" aria-hidden="true">
        ⇅
      </span>
      <span>{foulBadgeLabel(analysis)}</span>
    </div>
  )
}

function parseDragPayload(payload: string) {
  if (!payload) return null
  try {
    return JSON.parse(payload) as { source?: string; line?: keyof LinesState; card?: string }
  } catch {
    return null
  }
}

function stringToCardSafe(value: string): PlayingCard {
  return stringToCard(value)
}

function toCardStrings(cards: string[] | PlayingCard[]) {
  if (cards.length === 0) return []
  if (typeof cards[0] === 'string') return cards as string[]
  return (cards as PlayingCard[]).map((card) => cardToString(card))
}

function RivalryPanel({
  rivalryScores,
  currentOpponent,
  presentOpponentIds
}: {
  rivalryScores: Record<string, RivalryScore>
  currentOpponent: { id: string; name: string } | null
  presentOpponentIds: Set<string>
}) {
  const current = currentOpponent ? rivalryScores[currentOpponent.id] : undefined
  const others = Object.values(rivalryScores)
    .filter((score) => !presentOpponentIds.has(score.opponentId))
    .sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <div className="rivalry-panel">
      {currentOpponent && (
        <div className="rivalry-current">
          <div className="rivalry-title">Current Opponent</div>
          <div className="rivalry-row">
            <div>{current?.name ?? currentOpponent.name}</div>
            <div className={scoreClass(current?.total ?? 0)}>{formatSigned(current?.total ?? 0)}</div>
          </div>
          <div className="rivalry-sub">
            W {current?.wins ?? 0} • L {current?.losses ?? 0} • T {current?.ties ?? 0}
            {current && current.roundsPlayed > 0 && <> • {current.roundsPlayed} rounds</>}
          </div>
          {current && (current.streak > 1 || current.streak < -1) && (
            <div className="rivalry-streak">
              {current.streak > 0
                ? <span className="streak-win">{'\uD83D\uDD25'} {current.streak} win streak</span>
                : <span className="streak-loss">{current.streak * -1} loss streak</span>}
            </div>
          )}
          {current && current.bestScore !== undefined && current.roundsPlayed > 0 && (
            <div className="rivalry-sub">Best: {formatSigned(current.bestScore)}</div>
          )}
        </div>
      )}

      {others.length > 0 && (
        <div className="rivalry-list">
          <div className="rivalry-title">Past Opponents</div>
          {others.map((score) => (
            <div key={score.opponentId} className="rivalry-row">
              <div>{score.name}</div>
              <div className={scoreClass(score.total)}>{formatSigned(score.total)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function overlayTone(
  outcome: -1 | 0 | 1 | undefined,
  bonus: boolean
): 'win' | 'win-strong' | 'loss' | 'tie' | undefined {
  if (outcome === undefined) return undefined
  if (bonus && outcome > 0) return 'win-strong'
  if (outcome > 0) return 'win'
  if (outcome < 0) return 'loss'
  return 'tie'
}

function hasBonus(score: { royaltiesByLine: { total: number }; base: number } | undefined): boolean {
  if (!score) return false
  return score.royaltiesByLine.total > 0 || score.base === 6
}

function invertOutcome(outcome: -1 | 0 | 1 | undefined): -1 | 0 | 1 | undefined {
  if (outcome === undefined) return undefined
  return (outcome * -1) as -1 | 0 | 1
}

function formatSigned(value: number): string {
  if (value > 0) return `+${value}`
  return `${value}`
}

function buildRoyaltyTextByLine(
  lines: LinesState | undefined,
  pointsByLine: { top: number; middle: number; bottom: number }
): Record<keyof LinesState, string | null> {
  if (!lines) {
    return { top: null, middle: null, bottom: null }
  }
  return {
    top: formatRoyaltyText(pointsByLine.top),
    middle: formatRoyaltyText(pointsByLine.middle),
    bottom: formatRoyaltyText(pointsByLine.bottom)
  }
}

function formatRoyaltyText(points: number): string | null {
  if (points <= 0) return null
  return `(+${points})`
}

function handRankNameForLine(line: keyof LinesState, cards: PlayingCard[]): string | null {
  try {
    if (line === 'top') {
      if (cards.length !== 3) return null
      const hand = evaluateThree(cards)
      if (hand.category === 2) return 'Three of a Kind'
      if (hand.category === 1) return 'One Pair'
      return null
    }

    if (cards.length !== 5) return null
    const hand = evaluateFive(cards)
    switch (hand.category) {
      case 8:
        return 'Straight Flush'
      case 7:
        return 'Four of a Kind'
      case 6:
        return 'Full House'
      case 5:
        return 'Flush'
      case 4:
        return 'Straight'
      case 3:
        return 'Three of a Kind'
      case 2:
        return 'Two Pair'
      case 1:
        return 'One Pair'
      default:
        return null
    }
  } catch {
    return null
  }
}

function foulBadgeLabel(analysis?: FoulAnalysis | null): string {
  if (!analysis) return 'Foul'
  if (analysis.incomplete) return 'Foul: Incomplete'
  const offenders = analysis.offenderLines.map((line) => line.charAt(0).toUpperCase() + line.slice(1))
  if (offenders.length === 0) return 'Foul'
  if (offenders.length === 1) return `Foul: ${offenders[0]}`
  return `Foul: ${offenders.join(' & ')}`
}

function foulBadgeTitle(analysis?: FoulAnalysis | null): string {
  if (!analysis) return 'Out of order (foul)'
  const reasons: string[] = []
  if (analysis.incomplete) reasons.push('Hand is incomplete')
  if (analysis.topBeatsMiddle) reasons.push('Top outranks middle (middle offending)')
  if (analysis.middleBeatsBottom) reasons.push('Middle outranks bottom (bottom offending)')
  return reasons.length > 0 ? reasons.join('; ') : 'Out of order (foul)'
}

function scoreClass(value: number): string {
  if (value > 0) return 'score-positive'
  if (value < 0) return 'score-negative'
  return ''
}

function getCurrentRoundKey(state: GameState): string | null {
  for (let i = state.actionLog.length - 1; i >= 0; i -= 1) {
    const action = state.actionLog[i]
    if (action?.type === 'startRound') return action.id
  }
  return state.combinedSeed ?? null
}

function readRivalryScores(localPlayerId: string): Record<string, RivalryScore> {
  const entry = readRivalryStore()[localPlayerId]
  return entry?.rivals ?? {}
}

function persistRivalryRound(
  localPlayerId: string,
  roundKey: string,
  results: Array<{ opponentId: string; name: string; total: number }>
): Record<string, RivalryScore> {
  const store = readRivalryStore()
  const current = store[localPlayerId] ?? { processedRounds: [], rivals: {} }
  if (current.processedRounds.includes(roundKey)) {
    return current.rivals
  }

  const rivals = { ...current.rivals }
  const updatedAt = Date.now()
  for (const result of results) {
    const existing = rivals[result.opponentId]
    const wins = (existing?.wins ?? 0) + (result.total > 0 ? 1 : 0)
    const losses = (existing?.losses ?? 0) + (result.total < 0 ? 1 : 0)
    const ties = (existing?.ties ?? 0) + (result.total === 0 ? 1 : 0)
    const prevStreak = existing?.streak ?? 0
    let streak: number
    if (result.total > 0) {
      streak = prevStreak >= 0 ? prevStreak + 1 : 1
    } else if (result.total < 0) {
      streak = prevStreak <= 0 ? prevStreak - 1 : -1
    } else {
      streak = 0
    }
    const roundsPlayed = (existing?.roundsPlayed ?? (existing ? existing.wins + existing.losses + existing.ties : 0)) + 1
    const bestScore = Math.max(existing?.bestScore ?? -Infinity, result.total)
    rivals[result.opponentId] = {
      opponentId: result.opponentId,
      name: result.name,
      total: (existing?.total ?? 0) + result.total,
      wins,
      losses,
      ties,
      streak,
      bestScore: bestScore === -Infinity ? result.total : bestScore,
      roundsPlayed,
      updatedAt
    }
  }

  const next: RivalryStoreEntry = {
    processedRounds: [...current.processedRounds, roundKey].slice(-200),
    rivals
  }
  const nextStore: RivalryStore = { ...store, [localPlayerId]: next }
  writeRivalryStore(nextStore)
  return next.rivals
}

function readRivalryStore(): RivalryStore {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(RIVALRY_STORE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as RivalryStore
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeRivalryStore(store: RivalryStore) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(RIVALRY_STORE_KEY, JSON.stringify(store))
  } catch {
    // Ignore storage write failures.
  }
}
