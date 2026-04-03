#!/usr/bin/env tsx

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Transaction } from "ethers";

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
const ETH_PRICE_USD = 3000;

function weiToUsd(wei: bigint): number {
  return Number(wei) / 1e18 * ETH_PRICE_USD;
}

// Parse raw tx hex to extract to and value
// OWS passes raw_hex but leaves to/value as null
function parseTx(rawHex: string): { to: string; value: bigint } {
  try {
    const tx = Transaction.from("0x" + rawHex);
    return {
      to: (tx.to ?? "").toLowerCase(),
      value: tx.value,
    };
  } catch {
    return { to: "", value: 0n };
  }
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

  // Parse the raw transaction to get to/value (OWS doesn't extract these)
  const parsed = parseTx(ctx.transaction.raw_hex);
  const to = ctx.transaction.to?.toLowerCase() || parsed.to;
  const value = parsed.value;
  const txValueUsd = weiToUsd(value);

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

  process.stderr.write(`SENTINEL: to=${to} value=${value} usd=$${txValueUsd.toFixed(2)} tier=${rep.tier} limit=$${tierLimit} spent=$${todaySpend}\n`);

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
