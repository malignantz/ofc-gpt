# Future Plans: OFC Strategy Engine

## Research Summary (Saved)

### Strategic OFC Takeaways
- Initial 5-card placement is the highest leverage decision in standard and Pineapple OFC.
- Strong play emphasizes flexibility and foul avoidance before aggressive royalty chasing.
- Fantasyland pursuit is high EV when risk-adjusted; over-forcing it increases foul rate and long-run losses.
- In Fantasyland contexts, re-entry probability and setup quality matter, not just immediate points.

### Engine/AI Takeaways
- Current strongest family for imperfect-information card games is CFR/MCCFR and descendants.
- Practical production engines typically use a hybrid approach:
  - Fast rollout/search policy online.
  - Better offline blueprint policy/value approximation.
  - Opponent-model and subgame refinement over time.
- For this app, Phase 1 should improve current Monte Carlo + beam architecture before introducing large offline training systems.

---

## Phase 1 Implementation Plan (High Quality)

## Goal
Improve in-game decision quality immediately, without heavy infrastructure, by upgrading the existing strategy engine in `/Users/garrettholmes/Documents/OFC-GPT/src/strategy/placementEngine.ts`.

## Scope
- Replace beam-only initial placement with exhaustive legal enumeration (for pending 5-card initial step).
- Add adaptive rollout budgeting so close choices get more simulation and obvious choices finish fast.
- Add explicit Fantasyland and re-entry proxies to utility scoring.
- Add deterministic tests and benchmark coverage.

## Non-Goals (Phase 1)
- No CFR training pipeline.
- No neural value/policy model.
- No major state architecture rewrite.

## Success Criteria
- Measurable strength gain versus current engine in self-play A/B sims.
- Reduced bad initial placements in regression tests.
- Stable deterministic outputs for identical seeds.
- Similar or lower p95 decision latency through adaptive budgeting.

---

## Workstream A: Exhaustive Initial Placement

## Why
Initial state space is small enough to enumerate exactly for 5 pending cards with line capacities, making search quality much more reliable than heuristic beam truncation.

## Design
- Enumerate all legal assignments of pending cards across `top/middle/bottom` respecting capacities.
- Evaluate each full candidate with rollout utility.
- Keep deterministic tie-breaking with existing seed hashing.

## Proposed Code Changes
- In `/Users/garrettholmes/Documents/OFC-GPT/src/strategy/placementEngine.ts`:
  - Add `enumerateInitialCandidates(baseLines, pendingCards): LinesState[]`.
  - Replace beam loop in `chooseInitialPlacement` with candidate enumeration + scoring.
  - Keep `buildFallbackInitial` as safe fallback path.

## Notes
- Worst-case naive branching is bounded and practical for 5 cards.
- Enumeration must preserve deterministic order for reproducibility.

---

## Workstream B: Adaptive Rollout Budgeting

## Why
Fixed rollout counts (`N_PLAY_ROLLOUTS`, `N_INITIAL_ROLLOUTS`) waste compute on obvious decisions and under-sample close ones.

## Design
- Introduce staged sampling:
  - Stage 1: low sample count for all candidates.
  - Stage 2: refine top K only.
  - Stage 3 (optional): extra samples when confidence gap is below threshold.
- Use uncertainty-aware selection:
  - rank by `mean - lambda * stdError - foulPenalty`.
  - stop early when best-vs-second confidence gap exceeds threshold.

## Proposed Code Changes
- In `/Users/garrettholmes/Documents/OFC-GPT/src/strategy/placementEngine.ts`:
  - Add constants:
    - `ROLLOUT_STAGE1`
    - `ROLLOUT_STAGE2`
    - `ROLLOUT_TOP_K`
    - `ROLLOUT_GAP_THRESHOLD`
  - Add helper:
    - `evaluateCandidatesAdaptive(candidates, context): CandidateEval[]`
  - Reuse `computeUtility` internals but return incremental stats for staged updates.

## Latency Guardrails
- Cap total rollouts per decision.
- Keep deterministic seed sequencing regardless of early stop paths.

---

## Workstream C: Fantasyland/Re-entry Utility Terms

## Why
Current utility mostly optimizes direct score + foul risk. OFC strength improves when downstream value (Fantasyland entry/re-entry potential) is represented explicitly.

## Design
- Add fast proxy estimators:
  - `fantasylandEntrySignal(lines)` based on top-line made strength and remaining capacity.
  - `fantasylandReentrySignal(lines)` for strong made/near-made structures.
- Include these in utility:
  - `utility = mean - a*stdDev - b*foulRate + c*entrySignal + d*reentrySignal`
- Make coefficients configurable by strategy profile.

## Proposed Code Changes
- In `/Users/garrettholmes/Documents/OFC-GPT/src/strategy/placementEngine.ts`:
  - Extend `UtilitySummary` with:
    - `entrySignal`
    - `reentrySignal`
  - Add helper functions for signals.
  - Update `computeUtility` formula with profile-driven weights.
- In `/Users/garrettholmes/Documents/OFC-GPT/src/strategy/types.ts`:
  - Extend `StrategyProfile` for tunable profiles (for example: `balanced_ev`, `fantasy_pressure`).

## Calibration Plan
- Start with conservative coefficients.
- Tune via self-play A/B over fixed seeded game batches.

---

## Workstream D: Determinism, Tests, and Benchmarks

## Test Additions
- Update `/Users/garrettholmes/Documents/OFC-GPT/tests/strategyEngine.test.ts`:
  - initial-placement exhaustive legality + deterministic tie breaks.
  - adaptive rollout produces deterministic output under same seed.
  - fantasy-aware utility prefers entry-enabling placements in crafted scenarios.
- Add benchmark-style test/harness:
  - `/Users/garrettholmes/Documents/OFC-GPT/tests/strategyPhase1Benchmark.test.ts` (or `scripts/` harness if preferred).
  - Compare baseline vs phase1 over fixed seed suites:
    - avg total points
    - foul rate
    - fantasy signal hit rate
    - mean decision time

## Acceptance Thresholds
- `foul rate`: non-increasing vs baseline.
- `avg score`: improves over baseline across seeded batch.
- `determinism`: identical results for identical input+seed.
- `latency`: within agreed budget per decision.

---

## Execution Plan (PR Sequence)

1. [x] PR1: Exhaustive initial enumeration (completed on 2026-02-10)
- [x] Replace beam stage in `chooseInitialPlacement`.
- [x] Preserve deterministic ordering and fallback behavior.
- [x] Add/adjust unit tests for legality and determinism.

2. [x] PR2: Adaptive rollout manager (completed on 2026-02-10)
- [x] Add staged sampling and early stopping thresholds.
- [x] Integrate for both play and initial decisions.
- [x] Add determinism and latency tests.

3. [x] PR3: Fantasyland-aware utility (completed on 2026-02-10)
- [x] Add entry/re-entry signal functions and profile weights.
- [x] Run A/B tuning on fixed seed suite.
- [x] Document tuned defaults in code comments.

4. [x] PR4: Benchmark and regression pack (completed on 2026-02-10)
- [x] Add repeatable benchmark harness.
- [x] Record baseline and post-phase1 metrics in `plans/` or `docs/`.

---

## Risks and Mitigations

- Risk: Enumeration increases compute in edge cases.
  - Mitigation: dedupe candidates + rollout caps + adaptive early stop.
- Risk: Fantasy proxies overfit to handcrafted heuristics.
  - Mitigation: start with low weights and tune only via seeded A/B results.
- Risk: Determinism regression from adaptive branching.
  - Mitigation: fixed seed derivation per candidate and deterministic candidate ordering.

---

## Definition of Done for Phase 1
- Initial placement uses exhaustive legal candidate enumeration.
- Rollouts use adaptive staged budget with deterministic behavior.
- Utility includes explicit Fantasyland/re-entry proxy terms.
- New tests pass and benchmark comparison is documented.
- Engine demonstrates stronger self-play metrics without unacceptable latency regression.
