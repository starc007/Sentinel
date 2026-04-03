#!/usr/bin/env tsx

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Transaction, AbiCoder } from "ethers";

// Load .env from ~/.ows/policies/
function loadEnv() {
  const envPath = join(homedir(), ".ows", "policies", ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
}
loadEnv();

const TIER_LIMITS: Record<string, number> = {
  new: 5,
  established: 50,
  trusted: 500,
  verified: 5000,
};

const HIGH_VALUE_THRESHOLD = 1000;

// ERC-20 transfer(address,uint256) selector
const TRANSFER_SELECTOR = "a9059cbb";

// Known stablecoins on Base (address → decimals)
// These are always $1 per token
const STABLECOINS: Record<string, number> = {
  // Base Mainnet
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6, // USDC
  "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2": 6, // USDT
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": 18, // DAI
  // Base Sepolia (testnet)
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e": 6, // USDC (sepolia)
};

// Fetch live ETH price from CoinGecko (free, no auth)
async function fetchEthPrice(): Promise<number> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { signal: AbortSignal.timeout(2000) }
    );
    const data = (await res.json()) as { ethereum: { usd: number } };
    return data.ethereum.usd;
  } catch {
    return 3000; // fallback
  }
}

// Parse raw tx to extract: real recipient, USD value, and whether it's a token transfer
function parseTx(rawHex: string): {
  to: string;        // real recipient (contract address for ERC-20, or direct to)
  realTo: string;     // actual recipient of funds (decoded from transfer() for ERC-20)
  value: bigint;      // native ETH value in wei
  isErc20: boolean;
  tokenContract: string;
  tokenAmount: bigint;
  tokenDecimals: number | null;
} {
  try {
    const tx = Transaction.from("0x" + rawHex);
    const to = (tx.to ?? "").toLowerCase();
    const data = tx.data ?? "0x";

    // Check if this is an ERC-20 transfer(address,uint256)
    if (data.length >= 138 && data.slice(2, 10) === TRANSFER_SELECTOR) {
      const decoded = AbiCoder.defaultAbiCoder().decode(
        ["address", "uint256"],
        "0x" + data.slice(10)
      );
      const recipient = (decoded[0] as string).toLowerCase();
      const amount = decoded[1] as bigint;
      const decimals = STABLECOINS[to] ?? null;

      return {
        to,
        realTo: recipient,
        value: tx.value,
        isErc20: true,
        tokenContract: to,
        tokenAmount: amount,
        tokenDecimals: decimals,
      };
    }

    return {
      to,
      realTo: to,
      value: tx.value,
      isErc20: false,
      tokenContract: "",
      tokenAmount: 0n,
      tokenDecimals: null,
    };
  } catch {
    return {
      to: "", realTo: "", value: 0n,
      isErc20: false, tokenContract: "", tokenAmount: 0n, tokenDecimals: null,
    };
  }
}

// Calculate USD value of a transaction
async function txToUsd(parsed: ReturnType<typeof parseTx>): Promise<number> {
  let usd = 0;

  // Native ETH value
  if (parsed.value > 0n) {
    const ethPrice = await fetchEthPrice();
    usd += Number(parsed.value) / 1e18 * ethPrice;
  }

  // ERC-20 token value
  if (parsed.isErc20 && parsed.tokenAmount > 0n) {
    if (parsed.tokenDecimals !== null) {
      // Known stablecoin — $1 per token
      usd += Number(parsed.tokenAmount) / 10 ** parsed.tokenDecimals;
    }
    // Unknown token — we can't price it, treat as $0
    // This means unknown tokens always pass the spend limit
    // In production, use a price oracle for all tokens
  }

  return usd;
}

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const ctx = JSON.parse(Buffer.concat(chunks).toString()) as {
    wallet_id: string;
    chain_id: string;
    transaction: {
      to: string | null;
      value: string | null;
      raw_hex: string;
      data: string | null;
    };
    api_key_id: string;
    timestamp: string;
  };

  const sentinelUrl = process.env.SENTINEL_URL!;
  const sentinelKey = process.env.SENTINEL_KEY!;

  // Parse the raw transaction
  const parsed = parseTx(ctx.transaction.raw_hex);
  const to = parsed.realTo; // use the actual fund recipient
  const txValueUsd = await txToUsd(parsed);

  // 1. Fetch reputation score
  let rep: {
    score: number;
    tier: string;
    today_spent: number;
    spend_limit: number;
    approved_to: boolean;
  };

  try {
    const url = `${sentinelUrl}/reputation/${ctx.wallet_id}${to ? `?to=${to}` : ""}`;
    const res = await fetch(url, {
      headers: { "X-Sentinel-Key": sentinelKey },
      signal: AbortSignal.timeout(2000),
    });
    rep = (await res.json()) as typeof rep;
  } catch (e) {
    output({ allow: false, reason: `sentinel_unavailable:${e}` });
    return;
  }

  const tierLimit = TIER_LIMITS[rep.tier] ?? TIER_LIMITS.new;
  const todaySpend = rep.today_spent ?? 0;

  const txType = parsed.isErc20 ? `ERC20(${parsed.tokenContract.slice(0, 10)}...)` : "ETH";
  process.stderr.write(`SENTINEL: ${txType} to=${to.slice(0, 10)}... usd=$${txValueUsd.toFixed(2)} tier=${rep.tier} limit=$${tierLimit} spent=$${todaySpend}\n`);

  // 2. If this tx was previously approved via Telegram, allow it
  if (rep.approved_to) {
    reportAudit(sentinelUrl, sentinelKey, ctx.wallet_id, ctx.chain_id, txValueUsd, "allow", "human_approved");
    output({ allow: true });
    return;
  }

  // 3. Enforce daily limit
  if (todaySpend + txValueUsd > tierLimit) {
    const reason = `spend_limit:$${txValueUsd.toFixed(2)}+$${todaySpend.toFixed(2)}>$${tierLimit}(${rep.tier})`;
    reportAudit(sentinelUrl, sentinelKey, ctx.wallet_id, ctx.chain_id, txValueUsd, "deny", reason);
    output({ allow: false, reason });
    return;
  }

  // 4. High-value tx → queue for human approval
  if (txValueUsd > HIGH_VALUE_THRESHOLD && rep.tier !== "verified") {
    try {
      const res = await fetch(`${sentinelUrl}/queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sentinel-Key": sentinelKey,
        },
        body: JSON.stringify({
          wallet_id: ctx.wallet_id,
          to,
          value: txValueUsd.toFixed(2),
          chain_id: ctx.chain_id,
          raw_hex: ctx.transaction.raw_hex,
          reason: "high_value",
          tier: rep.tier,
          score: rep.score,
        }),
        signal: AbortSignal.timeout(2000),
      });
      const { id } = (await res.json()) as { id: string };
      reportAudit(sentinelUrl, sentinelKey, ctx.wallet_id, ctx.chain_id, txValueUsd, "deny", `high_value:queued:${id}`);
      output({ allow: false, reason: `high_value:queued:${id}` });
    } catch (e) {
      output({ allow: false, reason: `queue_error:${e}` });
    }
    return;
  }

  // 5. Allow
  reportAudit(sentinelUrl, sentinelKey, ctx.wallet_id, ctx.chain_id, txValueUsd, "allow");
  output({ allow: true });
}

function output(result: { allow: boolean; reason?: string }) {
  process.stdout.write(JSON.stringify(result));
}

function reportAudit(
  sentinelUrl: string,
  sentinelKey: string,
  walletId: string,
  chainId: string,
  txValueUsd: number,
  action: "allow" | "deny",
  reason?: string
) {
  fetch(`${sentinelUrl}/audit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sentinel-Key": sentinelKey,
    },
    body: JSON.stringify({
      wallet_id: walletId,
      action,
      reason,
      tx_value: txValueUsd.toFixed(2),
      chain_id: chainId,
    }),
  }).catch(() => {});
}

main();
