# Sentinel

> FICO scores for AI agent wallets, enforced by the OWS policy engine.

Sentinel is a reputation system for [OWS](https://openwallet.sh) agent wallets. Agents earn spending capacity through proven on-chain history. New wallets start with tight limits. Clean transaction history unlocks higher tiers. Bad behavior tanks the score.

---

## The Problem

Every OWS agent wallet starts with the same flat trust level regardless of history. A wallet with 1,000 clean transactions gets the same spending power as one created 5 minutes ago. Trust should be earned through proven behavior.

## The Solution

Sentinel computes a reputation score for each agent wallet based on its on-chain history and policy compliance. That score maps to a spend tier with enforced daily limits. Transactions that exceed the limit are blocked and sent to Telegram for human approval. Everything is enforced cryptographically by the OWS policy engine — not advisory, not optional.

A public API lets anyone query any wallet's reputation for $0.01 via x402. No setup, no cloning, just an HTTP call.

---

## Quick Start

```bash
npm install ows-sentinel-sdk
npx ows-sentinel init
```

That's it. The CLI automatically:
- Creates an OWS wallet (or uses existing)
- Installs the Sentinel policy + dependencies
- Registers the policy with OWS
- Creates an API key with the policy attached
- Signs an auth message with your wallet (no shared secrets)

Then in your agent:

```typescript
import { signWithApproval } from "ows-sentinel-sdk"
import { signTransaction } from "@open-wallet-standard/core"

const tx = await signWithApproval(
  () => signTransaction("my-wallet", "eip155:84532", txHex, "ows_key_..."),
  { inboxUrl: "https://sentinel-server.saurabh10102.workers.dev" }
)
```

---

## How It Works

### End-to-End Flow

```
Agent calls sign(walletId, chain, txHex) with API key
        |
        v
  OWS Policy Engine runs reputation-policy.ts
        |
        v
  Policy resolves wallet UUID → EVM address
  Policy parses raw tx hex → extracts to, value
  Policy converts value to USD (live ETH price + stablecoin detection)
  Policy fetches score from Sentinel server
        |
        +---> Over daily spend limit? ──────────┐
        |                                        |
        +---> Tx > $1,000 and tier < Verified? ──┤
        |                                        v
        |                              Queue for human approval
        |                              Telegram notification with
        |                              Approve / Reject buttons
        |                                        |
        |                              Human taps Approve
        |                                        |
        |                              Approval stored server-side
        |                                        |
        |                              Agent SDK retries sign()
        |                              Policy sees approval → ALLOW
        |
        +---> Within limits? --> ALLOW --> Transaction signed
```

### Authentication

No shared secrets. The CLI signs `"sentinel:{address}"` with your wallet's private key during setup. The signature is stored locally and sent as `X-Wallet-Sig` header on every policy → server call. The server recovers the address from the signature and verifies it matches.

### Token Support

The policy handles both native ETH and ERC-20 tokens:

- **ETH** — live price from CoinGecko
- **USDC / USDT / DAI** — recognized as stablecoins ($1 per token)
- **Unknown tokens** — treated as $0 (passes through)
- **ERC-20 `transfer()`** — calldata decoded to extract real recipient + amount

### Reputation Scoring

```
+1  per clean transaction executed (capped at +50)
+5  per active day of consistent activity (capped at +30)
-20 per policy denial (last 30 days)
-50 per interaction with flagged counterparty
```

| Score | Tier | Daily Limit |
|-------|------|-------------|
| 0–20 | New | $5/day |
| 21–50 | Established | $50/day |
| 51–100 | Trusted | $500/day |
| 100+ | Verified | $5,000/day |

### Data Sources

| Data | Source |
|------|--------|
| Tx count, first seen, active days | [Allium](https://allium.so) Developer API |
| Today's spend + denial count | Sentinel KV (self-tracked) |
| Flagged counterparties | [GoPlus](https://gopluslabs.io) Security API |
| ETH price | CoinGecko (live, 2s timeout, $3000 fallback) |

---

## Architecture

```
                        +-----------------+
                        |     Agent       |
                        | (OWS SDK)       |
                        +--------+--------+
                                 |
                                 | sign() with API key
                                 v
                        +------------------+
                        | OWS Policy Engine|
                        |                  |
                        | reputation-      |
                        |   policy.ts      |
                        +--------+---------+
                                 |
                          Wallet sig auth
                          GET /reputation
                          POST /queue
                          POST /audit
                                 |
                                 v
+----------------------------------------------------------------+
|              Sentinel Server (Cloudflare Worker)               |
|                                                                |
|  /reputation/:wallet  — score + tier + approval check          |
|  /audit               — policy reports allow/deny events       |
|  /queue               — queues denied txs for approval         |
|  /status/:id          — agent SDK polls for approval           |
|  /approve/:id         — Telegram bot approves                  |
|  /reject/:id          — Telegram bot rejects                   |
|  /scan/:address       — public x402-gated reputation API       |
+----------+-----------------------------+-----------------------+
           |                             |
     Service Binding              Allium + GoPlus
           |                      + CoinGecko
           v
+--------------------+
| Telegram Bot       |
| (Cloudflare Worker)|
|                    |
| /webhook  — button |
|   callbacks        |
| /notify   — sends  |
|   approval requests|
+--------------------+
```

### Worker-to-Worker Communication

Both workers communicate via [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) — direct worker-to-worker calls that bypass the public internet.

---

## Telegram Notifications

Every denied transaction triggers a Telegram notification with full details and Approve/Reject buttons:

```
🚨 Transaction Blocked — Approval Needed

From     0x06daef11d5944c1ec3c22a618dbc61c25c433682
To       0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce
Amount   $10.29 on Base
Tier     New
Score    0/100

Reason: Spend limit exceeded for this tier

Status: ⏳ Pending

[✅ Approve]  [❌ Reject]
```

After tapping Approve, the status line updates to `Status: ✅ Approved` and the agent can retry the transaction.

---

## API Reference

### Public Routes (no auth)

| Route | Method | Purpose |
|-------|--------|---------|
| `/health` | GET | Health check |
| `/status/:id` | GET | Agent SDK polls approval status |
| `/approve/:id` | POST | Telegram bot approves (via service binding) |
| `/reject/:id` | POST | Telegram bot rejects (via service binding) |
| `/scan/:address` | GET | x402-gated public reputation API ($0.01) |

### Wallet-Authenticated Routes

Require `X-Wallet-Sig` and `X-Wallet-Address` headers.

| Route | Method | Purpose |
|-------|--------|---------|
| `/reputation/:wallet` | GET | Score + tier + spend + approval check |
| `/audit` | POST | Policy reports allow/deny events |
| `/queue` | POST | Queue denied tx for Telegram approval |

---

## Project Structure

```
ows-sentinel/
├── packages/
│   ├── server/                  # Cloudflare Worker — main API
│   │   ├── src/
│   │   │   ├── index.ts         # Hono app, routing, wallet sig auth, x402
│   │   │   ├── types.ts         # Bindings, ReputationScore, AuditEvent, PendingTx
│   │   │   ├── engine/
│   │   │   │   ├── scoring.ts   # computeScore(), getTier(), getTierLimit()
│   │   │   │   ├── allium.ts    # fetchWalletHistory() — Allium API client
│   │   │   │   └── goplus.ts    # checkAddresses() — GoPlus API client
│   │   │   ├── lib/
│   │   │   │   ├── hmac.ts      # HMAC token utilities
│   │   │   │   └── validate.ts  # ETH address validation
│   │   │   └── routes/
│   │   │       ├── reputation.ts
│   │   │       ├── audit.ts
│   │   │       ├── queue.ts
│   │   │       └── scan.ts
│   │   └── wrangler.toml
│   ├── telegram-bot/            # Cloudflare Worker — Telegram webhook
│   │   ├── src/
│   │   │   ├── index.ts         # Webhook handler, /notify endpoint
│   │   │   └── messages.ts      # Message templates
│   │   └── wrangler.toml
│   ├── policies/                # Policy source (bundled in SDK)
│   │   └── src/
│   │       └── reputation-policy.ts
│   └── sdk/                     # npm: ows-sentinel-sdk
│       ├── src/
│       │   ├── index.ts         # signWithApproval()
│       │   └── cli.ts           # npx ows-sentinel init
│       └── policy/
│           └── reputation-policy.ts  # bundled for npm
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

---

## Development

```bash
git clone https://github.com/starc007/ows-sentinel
cd ows-sentinel
pnpm install

# Start sentinel server (port 8787)
pnpm dev:server

# Start telegram bot (port 8788)
pnpm dev:bot

# Typecheck all packages
pnpm typecheck
```

Copy `.dev.vars.example` to `.dev.vars` in `packages/server/` and `packages/telegram-bot/`.

---

## Deployment

```bash
# Deploy workers
pnpm run deploy:server
pnpm run deploy:bot

# Set production secrets (server)
cd packages/server
npx wrangler secret put SENTINEL_SECRET
npx wrangler secret put ALLIUM_API_KEY
npx wrangler secret put X402_RECEIVE_ADDRESS

# Set production secrets (bot)
cd ../telegram-bot
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID

# Register Telegram webhook
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<bot>.workers.dev/webhook"
```

---

## Stack

| Layer | Technology |
|-------|-----------|
| Server | Cloudflare Workers + Hono + KV |
| Bot | Cloudflare Workers + grammy |
| On-chain data | Allium Developer API (Base chain) |
| Address risk | GoPlus Security API (11 risk dimensions) |
| ETH pricing | CoinGecko API (live) |
| Token parsing | ethers.js (ERC-20 transfer decoding) |
| Micropayments | x402 protocol (USDC on Base) |
| Policy | TypeScript via tsx (runs in OWS) |
| Auth | Wallet signature (EIP-191) |
| SDK | [ows-sentinel-sdk](https://www.npmjs.com/package/ows-sentinel-sdk) on npm |
| Monorepo | pnpm workspaces |

---

## Live Endpoints

- **Server**: https://sentinel-server.saurabh10102.workers.dev
- **Bot**: https://sentinel-telegram-bot.saurabh10102.workers.dev
- **SDK**: https://www.npmjs.com/package/ows-sentinel-sdk
