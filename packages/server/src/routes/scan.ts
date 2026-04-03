import { Hono } from "hono";
import type { Bindings, AuditEvent } from "../types";
import { computeScore, getTier, getTierLimit } from "../engine/scoring";
import { fetchWalletHistory } from "../engine/allium";
import { checkAddresses } from "../engine/goplus";

const scan = new Hono<{ Bindings: Bindings }>();

scan.get("/scan/:address", async (c) => {
  const address = c.req.param("address").toLowerCase();

  const history = await fetchWalletHistory(address, c.env.ALLIUM_API_KEY);
  const goplus = await checkAddresses(history.counterparties.slice(0, 20));

  const auditEvents = (await c.env.KV.get<AuditEvent[]>(`audit:${address}`, "json")) ?? [];
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const denials30d = auditEvents.filter(
    (e) => e.action === "deny" && new Date(e.timestamp).getTime() > thirtyDaysAgo
  ).length;

  const todaySpent = parseFloat(
    (await c.env.KV.get(`spend:${address}:${new Date().toISOString().slice(0, 10)}`)) ?? "0"
  );

  const score = computeScore({
    txCount: history.txCount,
    activeDays: history.activeDays,
    denials30d,
    flaggedCounterparties: goplus.flaggedCount,
  });

  const tier = getTier(score);

  return c.json({
    wallet: address,
    score,
    tier,
    spend_limit: `$${getTierLimit(tier)}/day`,
    today_spent: `$${todaySpent.toFixed(2)}`,
    breakdown: {
      tx_count: history.txCount,
      active_days: history.activeDays,
      policy_denials_30d: denials30d,
      flagged_counterparties: goplus.flaggedCount,
    },
    computed_at: new Date().toISOString(),
  });
});

export { scan };
