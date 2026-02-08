# OFC P2P

Serverless, P2P Open-Face Chinese Poker (Classic ruleset).

## Prerequisites
- Node.js 20+
- npm (or pnpm/yarn)

## Local dev
```bash
npm install
npm run dev
```

## Signaling server (local)
```bash
npm run worker:dev
```

The client defaults to `ws://localhost:8787`. You can override it via:
```bash
VITE_SIGNALING_URL=ws://localhost:8787 npm run dev
```

## Deploy signaling to Cloudflare
```bash
npm install
npm run worker:dev
```

Then deploy:
```bash
npx wrangler login
npx wrangler deploy
```

After deploy, set the client to use your Worker URL:
```bash
VITE_SIGNALING_URL=wss://<your-worker-subdomain>.workers.dev npm run dev
```

## Tests
```bash
npm test
```

## Notes
- Signaling worker lives in `worker/worker.ts` and is designed for Cloudflare Workers.
- Core logic is in `src/engine` with deterministic shuffles and OFC scoring.
