# WebRTC Connection Management Plan (MVP)

## Scope and constraints
- Keep the current topology: mesh WebRTC data channels plus signaling relay fallback.
- Keep crypto disabled for MVP shuffle orchestration.
- Prioritize delivery correctness and recovery over protocol complexity.

## Connection lifecycle
1. Discovery
- Signaling emits `peerList` and `peerJoined`.
- Client creates deterministic initiator/responder roles using `clientId` ordering.

2. Negotiation
- Initiator creates an offer.
- Responder applies offer, creates answer, and returns it.
- Both sides apply ICE candidates.

3. Ready transport
- Use WebRTC data channel as primary path when channel state is `open`.
- Keep signaling relay as fallback path for all gameplay/sync traffic.

4. Degradation and recovery
- Treat `disconnected`, `closed`, and `failed` peer states as degraded.
- On peer discovery and peer connectivity transitions, request state sync.
- Retry offer creation on transient failures with bounded backoff.

## Reliability rules
- Candidate ordering:
  - Queue incoming ICE candidates until remote description is set.
  - Flush queued candidates immediately after applying offer/answer.
- Sync behavior:
  - Request sync at `peerList`, `peerJoined`, and `peerConnected`.
  - Buffer incoming network messages until local state exists, then replay.
- Targeted fallback:
  - `sendTo` must remain targeted when WebRTC is unavailable.
  - Use signaling message `relayTo` for single-peer fallback (not broadcast relay).
- Validation and safety:
  - Ignore malformed signaling payloads.
  - Catch and log offer/signal handling failures without crashing flow.

## Observability
- Keep current `console.debug` / `console.warn` events.
- Required log points:
  - peer discovered/listed/connected/disconnected
  - offer retry attempts and exhaustion
  - deferred actions and dropped deferred actions

## Test strategy mapped to plan
- Transport tests (`tests/webrtc.test.ts`)
  - candidate queue/flush behavior
  - connection state degradation handling (`failed` included)
  - offer/answer/candidate signal flow
  - channel send path (broadcast and direct)
- Room orchestration tests (`tests/roomClient.test.ts`)
  - deterministic initiator behavior
  - targeted relay fallback for `sendTo` (`relayTo`)
  - malformed signal payload ignored
  - offer retry behavior
- Integration assumptions (manual)
  - host and guest join timing skew during initial card placement
  - reconnect during `initial` phase and sync recovery

## Follow-up items (post-MVP)
- TURN support and explicit ICE restart path.
- Explicit app-level message envelopes with sequence numbers and ACKs.
- Backpressure policy for signaling queue under sustained reconnect churn.
