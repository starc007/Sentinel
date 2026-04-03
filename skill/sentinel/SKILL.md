---
name: sentinel
description: Set up and integrate OWS Sentinel — reputation-based spend limits for AI agent wallets. Use this skill whenever the user mentions protecting agent wallets, adding spend limits, reputation scoring for wallets, human-in-the-loop transaction approval, Telegram approval for transactions, OWS policy setup, or anything related to controlling how much an AI agent can spend. Also trigger when the user is building an OWS agent and wants to add safety/governance, or when they mention "signWithApproval", "ows-sentinel-sdk", or "Sentinel".
---

# Sentinel — Reputation-Gated Agent Wallets

Sentinel adds FICO-like reputation scores to OWS agent wallets. New wallets start with tight spend limits ($5/day). Clean transaction history earns higher tiers. Transactions that exceed the limit get blocked and sent to Telegram for human approval.

## When to Use This

- User wants to protect an OWS agent wallet with spend limits
- User wants human-in-the-loop approval for agent transactions
- User is integrating OWS signing and needs safety controls
- User asks about reputation or trust scoring for wallets
- User mentions Sentinel, `ows-sentinel-sdk`, or `signWithApproval`

## How It Works

```
Agent signs tx → OWS policy checks reputation → Under limit? Sign.
                                               → Over limit? Block → Telegram notification
                                               → Human approves → Agent retries → Signed.
```

### Reputation Tiers

| Score | Tier | Daily Limit |
|-------|------|-------------|
| 0–20 | New | $5/day |
| 21–50 | Established | $50/day |
| 51–100 | Trusted | $500/day |
| 100+ | Verified | $5,000/day |

Score is computed from on-chain history (Allium), address risk (GoPlus), and self-tracked policy events.

## Setup — One Command

The user needs OWS CLI installed first. If they don't have it:

```bash
curl -fsSL https://docs.openwallet.sh/install.sh | bash
```

Then install and init Sentinel:

```bash
npm install ows-sentinel-sdk
npx ows-sentinel-sdk init
```

The `init` command does everything automatically:
1. Creates an OWS wallet (or uses existing)
2. Installs the Sentinel policy executable + dependencies (ethers, @open-wallet-standard/core)
3. Signs an auth message with the wallet (wallet signature auth, no shared secrets)
4. Registers the policy with OWS
5. Creates an API key with the policy attached
6. Prints the API key (shown once, user must save it)
7. Prompts user to link Telegram via deep link (`https://t.me/ows_sentinelBot?start=0xAddress`)

## Integration

After setup, wrap any OWS `signTransaction` call with `signWithApproval`:

```typescript
import { signWithApproval } from "ows-sentinel-sdk"
import { signTransaction } from "@open-wallet-standard/core"

// Without Sentinel (no protection):
const sig = signTransaction("my-wallet", "eip155:8453", txHex, "ows_key_...")

// With Sentinel (reputation-gated):
const sig = await signWithApproval(
  () => signTransaction("my-wallet", "eip155:8453", txHex, "ows_key_..."),
  { inboxUrl: "https://sentinel-server.saurabh10102.workers.dev" }
)
```

`signWithApproval` handles the full deny → poll → retry flow:
1. Calls `signTransaction()` — if within limits, signs immediately
2. If denied (over spend limit or high-value), the policy queues it and sends a Telegram notification
3. SDK polls `/status/:id` every 3 seconds waiting for human approval
4. Human taps Approve on Telegram
5. SDK retries `signTransaction()` — policy sees the approval, signs

### Supported Tokens

The policy handles both ETH and ERC-20 tokens:
- **ETH** — live price from CoinGecko
- **USDC / USDT / DAI** — recognized as stablecoins ($1 per token)
- **Other ERC-20** — `transfer()` calldata decoded, treated as $0 if can't be priced

### Supported Chains

Currently configured for Base (mainnet: `eip155:8453`, testnet: `eip155:84532`). The policy's `allowed_chains` rule can be modified in `~/.ows/policies/sentinel-policy.json` to add more EVM chains.

## Public API

Anyone can query a wallet's reputation without setup:

```bash
curl https://sentinel-server.saurabh10102.workers.dev/scan/0xWalletAddress
# Returns 402 — pay $0.01 via x402 for the full report
```

## Architecture (for context)

- **Sentinel Server** — Cloudflare Worker (Hono + KV) at `sentinel-server.saurabh10102.workers.dev`
- **Telegram Bot** — Cloudflare Worker, receives webhooks, sends approval notifications
- **Policy Executable** — TypeScript file at `~/.ows/policies/reputation-policy.ts`, runs inside OWS policy engine
- **SDK** — npm package `ows-sentinel-sdk`, provides `signWithApproval()` + CLI init
- Workers communicate via Cloudflare Service Bindings
- Auth via wallet signatures (EIP-191), no shared secrets

## Troubleshooting

### "OWS CLI not found"
Install OWS first: `curl -fsSL https://docs.openwallet.sh/install.sh | bash`

### "tsx not found"
The CLI installs it automatically. If it fails: `npm install -g tsx`

### Policy not enforcing
Policies only run when signing with an **API key** (`ows_key_...`), not with the wallet passphrase. Make sure you're passing the API key as the 4th argument to `signTransaction`.

### Telegram notifications not arriving
1. Link your wallet: open `https://t.me/ows_sentinelBot?start=YOUR_WALLET_ADDRESS`
2. Or send `/start 0xYourAddress` to @ows_sentinelBot on Telegram
3. Check the bot's health: `curl https://sentinel-telegram-bot.saurabh10102.workers.dev/health`

## Links

- npm: https://www.npmjs.com/package/ows-sentinel-sdk
- GitHub: https://github.com/starc007/Sentinel
- Server: https://sentinel-server.saurabh10102.workers.dev
- Bot: https://sentinel-telegram-bot.saurabh10102.workers.dev
