#!/usr/bin/env tsx

const TIER_LIMITS: Record<string, number> = {
  new: 5,
  established: 50,
  trusted: 500,
  verified: 5000,
};

const HIGH_VALUE_THRESHOLD = 1000;

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const ctx = JSON.parse(Buffer.concat(chunks).toString()) as {
    wallet_id: string;
    chain_id: string;
    transaction: {
      to: string;
      value: string;
      raw_hex: string;
      data?: string;
    };
    api_key_id: string;
    timestamp: string;
  };

  const sentinelUrl = process.env.SENTINEL_URL!;
  const sentinelKey = process.env.SENTINEL_KEY!;
  const to = ctx.transaction.to?.toLowerCase() ?? "";

  // 1. Fetch reputation score (pass `to` so server checks for approvals)
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

  const txValue = parseFloat(ctx.transaction.value ?? "0");
  const tierLimit = TIER_LIMITS[rep.tier] ?? TIER_LIMITS.new;
  const todaySpend = rep.today_spent ?? 0;

  // 2. If this tx was previously approved via Telegram, allow it
  if (rep.approved_to) {
    reportAudit(sentinelUrl, sentinelKey, ctx, "allow", "human_approved");
    output({ allow: true });
    return;
  }

  // 3. Enforce daily limit
  if (todaySpend + txValue > tierLimit) {
    reportAudit(sentinelUrl, sentinelKey, ctx, "deny", `spend_limit_exceeded:tier=${rep.tier}:limit=${tierLimit}:spent=${todaySpend}`);
    output({
      allow: false,
      reason: `spend_limit_exceeded:tier=${rep.tier}:limit=${tierLimit}:spent=${todaySpend}`,
    });
    return;
  }

  // 4. High-value tx → queue for human approval
  if (txValue > HIGH_VALUE_THRESHOLD && rep.tier !== "verified") {
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
          value: ctx.transaction.value,
          chain_id: ctx.chain_id,
          raw_hex: ctx.transaction.raw_hex,
          reason: "high_value",
          tier: rep.tier,
          score: rep.score,
        }),
        signal: AbortSignal.timeout(2000),
      });
      const { id } = (await res.json()) as { id: string };
      reportAudit(sentinelUrl, sentinelKey, ctx, "deny", `high_value:queued:${id}`);
      output({ allow: false, reason: `high_value:queued:${id}` });
    } catch (e) {
      output({ allow: false, reason: `queue_error:${e}` });
    }
    return;
  }

  // 5. Allow
  reportAudit(sentinelUrl, sentinelKey, ctx, "allow");
  output({ allow: true });
}

function output(result: { allow: boolean; reason?: string }) {
  process.stdout.write(JSON.stringify(result));
}

function reportAudit(
  sentinelUrl: string,
  sentinelKey: string,
  ctx: { wallet_id: string; chain_id: string; transaction: { value: string } },
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
      wallet_id: ctx.wallet_id,
      action,
      reason,
      tx_value: ctx.transaction.value,
      chain_id: ctx.chain_id,
    }),
  }).catch(() => {});
}

main();
