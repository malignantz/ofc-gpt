# Phase 1 Benchmark (2026-02-10)

## Command

`npm test -- tests/strategyEngine.test.ts tests/cpuPlanner.test.ts tests/forcedPlacement.test.ts tests/strategyPhase1Benchmark.test.ts`

## Harness

- Benchmark source: `/Users/garrettholmes/Documents/OFC-GPT/tests/strategyPhase1Benchmark.test.ts`
- Scenario mix:
  - 24 play scenarios x 10 rollout completions per scenario
  - 18 initial scenarios x 10 rollout completions per scenario
- Profiles compared:
  - `conservative_ev`
  - `balanced_ev`
  - `fantasy_pressure`

## Metrics Snapshot

### Play Decision Benchmark

| Profile | Samples | Avg Score | Foul Rate | Avg Decision Latency (ms) |
|---|---:|---:|---:|---:|
| conservative_ev | 240 | 1.2042 | 0.5917 | 0.8546 |
| balanced_ev | 240 | 0.6250 | 0.6375 | 0.8205 |
| fantasy_pressure | 240 | 0.6208 | 0.6417 | 0.8116 |

### Initial Placement Benchmark

| Profile | Samples | Avg Score | Foul Rate | Avg Decision Latency (ms) |
|---|---:|---:|---:|---:|
| conservative_ev | 180 | 0.8611 | 0.5667 | 8.4688 |
| balanced_ev | 180 | 0.6333 | 0.5833 | 9.9321 |
| fantasy_pressure | 180 | 0.8278 | 0.4944 | 9.0629 |

## Notes

- This snapshot is deterministic for score/foul metrics under the benchmark harness seeds.
- Latency metrics are bounded but naturally vary between runs.
- This file is the first persisted Phase 1 benchmark checkpoint and should be used as baseline for later tuning passes.
