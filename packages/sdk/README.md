# ows-sentinel-sdk

> FICO scores for AI agent wallets, enforced by the OWS policy engine.

Sentinel is a reputation system for [OWS](https://openwallet.sh) agent wallets. Agents earn spending capacity through proven on-chain history. New wallets start with tight limits ($5/day). Clean transaction history unlocks higher tiers ($50 → $500 → $5,000/day). Transactions that exceed the limit get sent to Telegram for human approval.

## Setup

```bash
npm install ows-sentinel-sdk
npx ows-sentinel init
```

The CLI automatically creates a wallet, installs the policy, registers it with OWS, and gives you an API key. Zero manual config.

## Usage

```typescript
import { signWithApproval } from "ows-sentinel-sdk"
import { signTransaction } from "@open-wallet-standard/core"

const tx = await signWithApproval(
  () => signTransaction("my-wallet", "eip155:84532", txHex, "ows_key_..."),
  { inboxUrl: "https://sentinel-server.saurabh10102.workers.dev" }
)
```

The SDK handles the full flow:

1. Calls `signTransaction()` → policy evaluates the tx
2. If denied (over spend limit or high-value) → queues for Telegram approval
3. Polls until human approves or rejects
4. Retries `signTransaction()` → policy sees approval → signs

## Reputation Tiers

| Score | Tier | Daily Limit |
|-------|------|-------------|
| 0–20 | New | $5/day |
| 21–50 | Established | $50/day |
| 51–100 | Trusted | $500/day |
| 100+ | Verified | $5,000/day |

## Token Support

- **ETH** — live price from CoinGecko
- **USDC / USDT / DAI** — recognized as stablecoins
- **ERC-20 transfers** — calldata decoded automatically

## Links

- [GitHub](https://github.com/starc007/Sentinel) — full source, architecture, deployment docs
- [Server](https://sentinel-server.saurabh10102.workers.dev/health) — live API
