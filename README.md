# OFC-GPT

Open-Face Chinese Poker (Classic ruleset) with Firebase Realtime Database sync.

## Prerequisites
- Node.js 20+
- npm (or pnpm/yarn)

## Local dev
```bash
npm install
npm run dev
```

## Firebase setup

Set these environment variables before running the app:

```bash
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_DATABASE_URL=https://<project-id>-default-rtdb.firebaseio.com
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_APP_ID=...
```

This branch uses room-code based public access (no auth) for simplicity. Example RTDB rules:

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

Do not use these rules for production without auth constraints.

## Tests
```bash
npm test
```

## Notes
- Room directory entries expire 24 hours after last activity.
- Existing signaling/WebRTC worker code is still in the repo for rollback.
- Core logic is in `src/engine` with deterministic shuffles and OFC scoring.
