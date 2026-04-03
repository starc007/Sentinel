# Sentinel

> FICO scores for AI agent wallets, enforced by the OWS policy engine.

Sentinel is a reputation system for [OWS](https://openwallet.sh) agent wallets. Agents earn spending capacity through proven on-chain history. New wallets start with tight limits. Clean transaction history unlocks higher tiers. Bad behavior tanks the score.

---

## The Problem

Every OWS agent wallet starts with the same flat trust level regardless of history. A wallet with 1,000 clean transactions gets the same spending power as one created 5 minutes ago. Trust should be earned through proven behavior.

## The Solution

Sentinel computes a reputation score for each agent wallet based on its on-chain history and policy compliance. That score maps to a spend tier with enforced daily limits. High-value transactions require human approval via Telegram. Everything is enforced cryptographically by the OWS policy engine — not advisory, not optional.

A public API lets anyone query any wallet's reputation for $0.01 via x402. No setup, no cloning, just an HTTP call.

---

## How It Works

### End-to-End Flow

```
Agent calls sign(walletId, chain, txHex)
        |
        v
  OWS Policy Engine runs reputation-policy.ts
        |
        v
  Policy fetches score from Sentinel server
        |
        +---> Score too low for tx amount? --> DENY (spend limit)
        |
        +---> Tx > $1,000 and tier < Verified? --> Queue for human approval
        |                                              |
        |                                              v
        |                                        Telegram notification
        |                                        with Approve/Reject buttons
        |                                              |
        |                                    Human taps Approve
        |                                              |
        |                                        HMAC token issued
        |                                              |
        |                                    Agent SDK retries sign()
        |                                    with approval token
        |
        +---> Within limits? --> ALLOW --> Transaction signed
```

### The Deny-Queue-Retry Pattern

OWS policies have a 5-second timeout. Sentinel needs to do async work (risk scoring, human approval) that can take much longer. The pattern:

1. **Deny instantly** — policy returns DENY with a queue ID
2. **Do work async** — Sentinel scans the address, sends Telegram notification
3. **Human decides** — taps Approve or Reject on Telegram
4. **Retry with proof** — agent SDK retries with an HMAC approval token
5. **Verify locally** — policy verifies the HMAC token (no network, fits 5s)

### Reputation Scoring

Score computed from the agent's own on-chain history:

```
+1  per clean transaction executed (capped at +50)
+5  per active day of consistent activity (capped at +30)
-20 per policy denial (last 30 days)
-50 per interaction with flagged counterparty
```

Score maps to spend tiers:

| Score | Tier | Daily Limit |
|-------|------|-------------|
| 0–20 | New | $5/day |
| 21–50 | Established | $50/day |
| 51–100 | Trusted | $500/day |
| 100+ | Verified | $5,000/day |

### Data Sources

| Data | Source | Why |
|------|--------|-----|
| Tx count, first seen, active days | [Allium](https://allium.so) Developer API | On-chain history is authoritative |
| Today's spend | Sentinel KV (self-tracked) | Real-time, no external sync needed |
| Policy denial count | Sentinel KV (self-tracked) | OWS audit log isn't queryable via API |
| Flagged counterparties | [GoPlus](https://gopluslabs.io) Security API | Checks 11 risk dimensions per address |

---

## Architecture

```
                        +-----------------+
                        |     Agent       |
                        | (OWS SDK)       |
                        +--------+--------+
                                 |
                                 | sign()
                                 v
                        +------------------+
                        | OWS Policy Engine|
                        |                  |
                        | reputation-      |
                        |   policy.ts      |
                        +--------+---------+
                                 |
                          GET /reputation
                          POST /queue
                          POST /audit
                                 |
                                 v
+----------------------------------------------------------------+
|              Sentinel Server (Cloudflare Worker)               |
|                                                                |
|  /reputation/:wallet  — score + tier + daily spend             |
|  /audit               — policy reports allow/deny events       |
|  /queue               — holds high-value txs for approval      |
|  /status/:id          — agent polls for approval result        |
|  /approve/:id         — issues HMAC token on human approval    |
|  /reject/:id          — marks tx as rejected                   |
|  /scan/:address       — public x402-gated reputation API       |
|                                                                |
|  KV: reputation:{wallet}, audit:{wallet},                      |
|      spend:{wallet}:{date}, pending:{id}                       |
+----------+-----------------------------+----------------------+
           |                             |
     Service Binding              Allium + GoPlus
           |                             |
           v                             v
+--------------------+         +-------------------+
| Telegram Bot       |         | Reputation Engine |
| (Cloudflare Worker)|         |                   |
|                    |         | Allium: tx history |
| /webhook  — TG     |         | GoPlus: risk flags|
|   button callbacks |         | KV: denials/spend |
| /notify   — sends  |         | Scoring: 0–100+  |
|   approval requests|         +-------------------+
| /alert    — sends  |
|   spend limit msgs |
+--------------------+
```

### Worker-to-Worker Communication

Both workers run on Cloudflare. They communicate via [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) — direct worker-to-worker calls that bypass the public internet. This avoids the Cloudflare restriction where workers on the same account can't call each other via public URLs.

- **Server → Bot**: service binding `TELEGRAM_BOT` for sending notifications
- **Bot → Server**: service binding `SENTINEL_SERVER` for approve/reject callbacks

---

## Quick Start

### For External Users (No Setup)

**Query any wallet's reputation:**

```bash
curl https://sentinel-server.saurabh10102.workers.dev/scan/0xWalletAddress
# Returns 402 — pay $0.01 via x402 to get the full report
```

**Integrate with your OWS agent:**

```bash
npm install ows-sentinel-sdk
npx ows-sentinel init    # copies policy to ~/.ows/policies/
```

```typescript
import { signWithApproval } from "ows-sentinel-sdk"

// Wraps sign() with automatic retry on approval
const result = await signWithApproval(
  () => ows.signAndSend(request),
  { inboxUrl: "https://sentinel-server.saurabh10102.workers.dev" }
)
```

The SDK handles the deny-queue-retry pattern automatically:
1. Calls `sign()` — gets denied with a queue ID
2. Polls `/status/:id` every 3 seconds
3. When human approves via Telegram, retries with the HMAC token
4. Transaction goes through

### For Developers (Self-Hosting)

```bash
git clone <repo>
cd ows-sentinel
pnpm install

# Configure local environment
cp packages/server/.dev.vars.example packages/server/.dev.vars
cp packages/telegram-bot/.dev.vars.example packages/telegram-bot/.dev.vars
# Fill in your API keys (see Environment Variables section below)

# Start both workers locally
pnpm dev:server   # http://localhost:8787
pnpm dev:bot      # http://localhost:8788

# Typecheck all packages
pnpm typecheck
```

---

## API Reference

All internal routes require `X-Sentinel-Key` header. The `/scan` route is public (x402-gated). `/health` is public.

### `GET /health`
Returns `{"status": "ok", "service": "sentinel"}`.

### `GET /reputation/:wallet`
Returns the wallet's reputation score, tier, daily spend, and breakdown.

```json
{
  "wallet": "0xabc...",
  "score": 74,
  "tier": "trusted",
  "spend_limit": 500,
  "today_spent": 12.4,
  "breakdown": {
    "tx_count": 87,
    "active_days": 14,
    "policy_denials_30d": 1,
    "flagged_counterparties": 0
  },
  "computed_at": "2026-04-03T10:00:00Z"
}
```

Results are cached in KV for 60 seconds.

### `POST /audit`
Policy reports allow/deny events. Updates daily spend tracking on allow.

```json
{
  "wallet_id": "0xabc...",
  "action": "allow",
  "reason": "within_limit",
  "tx_value": "2.5",
  "chain_id": "eip155:8453"
}
```

### `POST /queue`
Queues a high-value transaction for human approval. Triggers Telegram notification.

```json
{
  "wallet_id": "0xabc...",
  "value": "1500",
  "chain_id": "eip155:8453",
  "raw_hex": "0x...",
  "reason": "high_value",
  "tier": "established",
  "score": 34
}
```

Returns `{"id": "uuid", "status": "pending"}`.

### `GET /status/:id`
Agent SDK polls this. Returns `{"status": "pending"}`, `{"status": "approved", "token": "..."}`, or `{"status": "rejected"}`.

### `POST /approve/:id`
Called by Telegram bot on human approval. Issues an HMAC token valid for 10 minutes.

### `POST /reject/:id`
Called by Telegram bot on human rejection.

### `GET /scan/:address` (x402-gated)
Public API. Returns 402 Payment Required without payment. With x402 payment ($0.01 USDC on Base Sepolia), returns the full reputation report.

---

## Telegram Notifications

### High-Value Approval Request
Fires when a transaction exceeds $1,000 and the wallet tier is below Verified.

```
High-Value Transaction — Approval Needed

Agent      agent-treasury
Tier       Established
Amount     $1500 on Base
Score      34/100

This exceeds auto-approval threshold for this tier.

[Approve]  [Reject]
```

Tapping Approve updates the message to show "APPROVED" and issues the HMAC token. Tapping Reject marks the transaction as rejected.

### Spend Limit Alert
Fires when a transaction is denied due to daily spend limit.

```
Spend Limit Reached

Agent      agent-treasury
Tier       Established ($50/day)
Spent      $48.20 today
Attempted  $5.00 more — DENIED

Score: 34/100
```

---

## Policy Executable

`packages/policies/src/reputation-policy.ts` runs inside the OWS policy engine on every `sign()` call. It:

1. Fetches the wallet's score from the Sentinel server (2s timeout)
2. Checks if `today_spend + tx_value > tier_limit` — denies if over
3. Checks if `tx_value > $1,000` and tier < Verified — queues for approval
4. Reports the result back to `/audit` (fire-and-forget)
5. Returns `{allow: true}` or `{allow: false, reason: "..."}` to OWS

Requires environment variables: `SENTINEL_URL`, `SENTINEL_KEY`.

---

## Project Structure

```
ows-sentinel/
├── package.json                 # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json           # shared TypeScript config
├── packages/
│   ├── server/                  # Cloudflare Worker — main API
│   │   ├── src/
│   │   │   ├── index.ts         # Hono app, route wiring, auth + x402 middleware
│   │   │   ├── types.ts         # Bindings, ReputationScore, AuditEvent, PendingTx
│   │   │   ├── engine/
│   │   │   │   ├── scoring.ts   # computeScore(), getTier(), getTierLimit()
│   │   │   │   ├── allium.ts    # fetchWalletHistory() — Allium API client
│   │   │   │   └── goplus.ts    # checkAddresses() — GoPlus API client
│   │   │   ├── lib/
│   │   │   │   └── hmac.ts      # createApprovalToken(), verifyApprovalToken()
│   │   │   └── routes/
│   │   │       ├── reputation.ts
│   │   │       ├── audit.ts
│   │   │       ├── queue.ts
│   │   │       └── scan.ts
│   │   ├── wrangler.toml        # KV namespace + service binding config
│   │   └── .dev.vars.example
│   ├── telegram-bot/            # Cloudflare Worker — Telegram webhook
│   │   ├── src/
│   │   │   ├── index.ts         # Hono app with /webhook, /notify, /alert routes
│   │   │   ├── bot.ts           # grammy bot setup, callback handlers
│   │   │   └── messages.ts      # message templates
│   │   ├── wrangler.toml        # service binding to sentinel-server
│   │   └── .dev.vars.example
│   ├── policies/                # OWS policy executable
│   │   └── src/
│   │       └── reputation-policy.ts
│   └── sdk/                     # npm package for agent developers
│       └── src/
│           ├── index.ts         # signWithApproval()
│           └── cli.ts           # npx ows-sentinel init
```

---

## Environment Variables

### Server (`packages/server/.dev.vars`)

| Variable | Description |
|----------|-------------|
| `SENTINEL_SECRET` | HMAC signing secret for approval tokens |
| `ALLIUM_API_KEY` | Allium Developer API key ([get one free](https://app.allium.so/join)) |
| `SENTINEL_KEY` | Internal API key shared between server and bot |
| `X402_RECEIVE_ADDRESS` | Wallet address to receive x402 micropayments |

### Telegram Bot (`packages/telegram-bot/.dev.vars`)

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/botfather) |
| `SENTINEL_KEY` | Must match the server's SENTINEL_KEY |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID for notifications |

### Policy (`packages/policies/.env`)

| Variable | Description |
|----------|-------------|
| `SENTINEL_URL` | Sentinel server URL |
| `SENTINEL_KEY` | Must match the server's SENTINEL_KEY |

---

## Deployment

### Deploy Workers

```bash
pnpm run deploy:server    # deploys sentinel-server to Cloudflare
pnpm run deploy:bot       # deploys sentinel-telegram-bot to Cloudflare
```

### Set Production Secrets

```bash
# Server secrets
cd packages/server
npx wrangler secret put SENTINEL_SECRET
npx wrangler secret put ALLIUM_API_KEY
npx wrangler secret put SENTINEL_KEY
npx wrangler secret put X402_RECEIVE_ADDRESS

# Bot secrets
cd ../telegram-bot
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put SENTINEL_KEY        # same value as server
npx wrangler secret put TELEGRAM_CHAT_ID
```

### Register Telegram Webhook

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://<your-bot>.workers.dev/webhook"
```

### Create KV Namespace

```bash
cd packages/server
npx wrangler kv namespace create KV
# Update the ID in wrangler.toml
```

---

## Stack

| Layer | Technology |
|-------|-----------|
| Server | Cloudflare Workers + Hono + KV |
| Bot | Cloudflare Workers + grammy |
| On-chain data | Allium Developer API (Base chain) |
| Address risk | GoPlus Security API (11 risk dimensions) |
| Micropayments | x402 protocol (USDC on Base) |
| Policy | TypeScript via tsx (runs in OWS) |
| SDK | TypeScript npm package |
| Monorepo | pnpm workspaces |

---

## Live Endpoints

- **Server**: https://sentinel-server.saurabh10102.workers.dev
- **Bot**: https://sentinel-telegram-bot.saurabh10102.workers.dev
