# Sentinel

> FICO scores for AI agent wallets, enforced by the OWS policy engine.

Sentinel is a reputation system for [OWS](https://openwallet.sh) agent wallets. Agents earn spending capacity through proven on-chain history. New wallets start with tight limits. Clean transaction history unlocks higher tiers.

## How It Works

1. Agent calls `sign()` through OWS
2. Sentinel's policy checks the wallet's reputation score
3. Score determines daily spend limit ($5 → $50 → $500 → $5,000)
4. High-value transactions get queued for human approval via Telegram
5. Public API lets anyone query any wallet's reputation for $0.01 via x402

## Quick Start (External Users)

**Query a wallet's reputation (no setup needed):**

```bash
curl https://sentinel-server.workers.dev/scan/0xYourWallet
```

**Integrate with your OWS agent:**

```bash
npm install ows-sentinel-sdk
npx ows-sentinel init
```

```typescript
import { signWithApproval } from "ows-sentinel-sdk"

const result = await signWithApproval(
  () => ows.signAndSend(request),
  { inboxUrl: "https://sentinel-server.workers.dev" }
)
```

## Reputation Tiers

| Score | Tier | Daily Limit |
|-------|------|-------------|
| 0–20 | New | $5/day |
| 21–50 | Established | $50/day |
| 51–100 | Trusted | $500/day |
| 100+ | Verified | $5,000/day |

## Score Computation

```
+1  per clean transaction (capped at +50)
+5  per active day (capped at +30)
-20 per policy denial (last 30 days)
-50 per flagged counterparty
```

Data sources: Allium (on-chain history), GoPlus (address security), self-tracked KV (denials + spend).

## Development

```bash
pnpm install

# Start sentinel server (port 8787)
pnpm dev:server

# Start telegram bot (port 8788)
pnpm dev:bot

# Typecheck all packages
pnpm typecheck
```

Copy `.dev.vars.example` to `.dev.vars` in each package and fill in your keys.

## Architecture

```
packages/
├── server/          # Cloudflare Worker — main Sentinel API (Hono + KV)
├── telegram-bot/    # Cloudflare Worker — Telegram webhook bot (grammy)
├── policies/        # OWS policy executable (reputation-policy.ts)
└── sdk/             # npm package (ows-sentinel-sdk)
```

## API Routes

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/health` | GET | none | Health check |
| `/reputation/:wallet` | GET | X-Sentinel-Key | Score + tier + spend |
| `/audit` | POST | X-Sentinel-Key | Policy reports events |
| `/queue` | POST | X-Sentinel-Key | High-value tx hold |
| `/status/:id` | GET | X-Sentinel-Key | Poll approval status |
| `/approve/:id` | POST | Telegram callback | Approve transaction |
| `/reject/:id` | POST | Telegram callback | Reject transaction |
| `/scan/:address` | GET | x402 | Public reputation API |

## Deployment

```bash
pnpm deploy:server   # deploys sentinel server to CF
pnpm deploy:bot      # deploys telegram bot to CF
```

Set production secrets:
```bash
cd packages/server && npx wrangler secret put SENTINEL_SECRET
cd packages/telegram-bot && npx wrangler secret put TELEGRAM_BOT_TOKEN
```

## Stack

- TypeScript, Hono, Cloudflare Workers + KV
- Allium Developer API (on-chain data)
- GoPlus Security API (address risk)
- grammy (Telegram bot)
- x402 (micropayments)
