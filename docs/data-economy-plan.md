# Data Economy Plan (Firebase RTDB)

Branch: `codex/data-economy`

## Goal

Reduce Firebase bandwidth and write/read amplification required to run a 2-player game.

## Current Firebase Data Model

Root paths:

- `/rooms/{roomId}/meta`
- `/rooms/{roomId}/participants/{playerId}`
- `/rooms/{roomId}/actions/{gameId__actionId}`
- `/rooms/{roomId}/gameState`
- `/roomDirectory/{roomId}`

Key payload types:

- `RoomMeta`: room/session identity, dealer seat, TTL/status
- `ParticipantPresence`: identity + heartbeat/ack fields
- `ActionRecord`: `{ id, gameId, action, actorId, createdAt }`
- `GameState`: full local reducer state, including `actionLog`, `deck`, `drawOrder`, `lines`, `pending`

## Request Cost by Operation (Current)

- `subscribeRoomSnapshot` poll: 1 `GET /rooms/{id}` every 2s per client
- `touchPresence`: 5 requests
  - `GET /rooms/{id}`
  - `PATCH /rooms/{id}/participants/{playerId}`
  - `GET /rooms/{id}` (inside `refreshDirectory`)
  - `PUT /roomDirectory/{id}`
  - `PATCH /rooms/{id}/meta`
- `appendAction`: 6 requests
  - `GET /rooms/{id}`
  - `GET /rooms/{id}/actions/{actionKey}`
  - `PUT /rooms/{id}/actions/{actionKey}`
  - `GET /rooms/{id}` (inside `refreshDirectory`)
  - `PUT /roomDirectory/{id}`
  - `PATCH /rooms/{id}/meta`
- `upsertGameState` (with expected game id): 3 requests
  - `GET /rooms/{id}`
  - `PUT /rooms/{id}/gameState`
  - `PATCH /rooms/{id}/meta`

## Main Data Inefficiencies

1. Full-room polling returns large payloads (`meta + participants + actions + full gameState`) every 2s.
2. Presence heartbeat triggers repeated `fetchRoomSnapshot` and directory writes.
3. Every action write also refreshes room directory, even though directory metadata rarely changes.
4. `gameState.actionLog` duplicates action payload already stored in `/actions`.
5. Full `gameState` is written repeatedly during play, including large arrays (`deck`, `drawOrder`, nested lines/pending).

## Phased Plan

## Phase 0: Baseline Instrumentation (first)

- Add request telemetry inside Firebase client:
  - method, path, request bytes, response bytes, latency
- Add dev-only aggregate report:
  - requests/minute by endpoint
  - bytes/minute by endpoint
  - room lifecycle summary (join -> round end)
- Define success metrics:
  - `>=50%` fewer requests during active round
  - `>=60%` fewer downloaded bytes during active round
  - no gameplay divergence in existing tests

## Phase 1: Remove Write Amplification (low risk, high impact)

- Stop calling `refreshDirectory` from:
  - `appendAction`
  - `touchPresence`
- Update directory only on room lifecycle events:
  - create/join/leave/restart/reset
- For liveness TTL, patch minimal field only:
  - `PATCH /rooms/{id}/meta` `expiresAt` (coarser interval, e.g. 30-60s)
- Keep participant heartbeat updates but avoid pre-read when unnecessary.

## Phase 2: Reduce Snapshot Read Size

- Replace `fetchRoomSnapshot` full read with targeted reads:
  - `/rooms/{id}/meta`
  - `/rooms/{id}/participants`
  - `/rooms/{id}/actions` (query window or incremental key strategy)
- Keep `gameState` read as fallback only (not every poll).
- Increase poll interval or adopt adaptive polling:
  - active turn: 2-3s
  - idle/lobby: 5-10s

## Phase 3: Remove Duplicated State

- Choose one authoritative sync source:
  - preferred: action log + deterministic hydration
- Minimize persisted `gameState`:
  - option A: remove routine writes, keep occasional checkpoints
  - option B: write compact checkpoints (without `actionLog`, `deck`, `drawOrder`) only every N actions
- Update `resolveIncomingState` fallback to support checkpoint model.

## Phase 4: Payload Compaction

- Store cards as 2-char strings (`"AS"`) instead of `{ rank, suit }` in network payloads.
- Consider compact action encoding for high-frequency actions (`drawCard`, `placeCard`).
- Ensure migration/parsing compatibility for legacy payloads.

## Validation & Rollout

- Extend tests for:
  - stale game/session protection
  - hydration correctness without full persisted gameState
  - network call-count assertions for critical flows
- Add a kill switch (env flag) for compact mode.
- Roll out in two steps:
  - Step 1: Phase 1 + instrumentation
  - Step 2: Phase 2/3 compact sync

## Immediate Next Tasks (on this branch)

1. Implement telemetry in `firebaseClient`.
2. Refactor `refreshDirectory` usage out of heartbeat/action paths.
3. Add tests that assert request count reductions for heartbeat and action append flows.
