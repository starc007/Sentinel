import { Hono } from "hono";
import type { Bindings, AuditEvent, ReputationScore } from "../types";
import { computeScore, getTier, getTierLimit } from "../engine/scoring";
import { fetchWalletHistory } from "../engine/allium";
import { checkAddresses } from "../engine/goplus";

const reputation = new Hono<{ Bindings: Bindings }>();

reputation.get("/reputation/:wallet", async (c) => {
  const wallet = c.req.param("wallet").toLowerCase();

  const cached = await c.env.KV.get<ReputationScore>(`reputation:${wallet}`, "json");
  if (cached) return c.json(cached);

  const history = await fetchWalletHistory(wallet, c.env.ALLIUM_API_KEY);
  const goplus = await checkAddresses(history.counterparties.slice(0, 20));

  const auditEvents = (await c.env.KV.get<AuditEvent[]>(`audit:${wallet}`, "json")) ?? [];
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const denials30d = auditEvents.filter(
    (e) => e.action === "deny" && new Date(e.timestamp).getTime() > thirtyDaysAgo
  ).length;

  const today = new Date().toISOString().slice(0, 10);
  const todaySpent = parseFloat((await c.env.KV.get(`spend:${wallet}:${today}`)) ?? "0");

  const score = computeScore({
    txCount: history.txCount,
    activeDays: history.activeDays,
    denials30d,
    flaggedCounterparties: goplus.flaggedCount,
  });

  const tier = getTier(score);

  const result: ReputationScore = {
    wallet,
    score,
    tier,
    spend_limit: getTierLimit(tier),
    today_spent: todaySpent,
    breakdown: {
      tx_count: history.txCount,
      active_days: history.activeDays,
      policy_denials_30d: denials30d,
      flagged_counterparties: goplus.flaggedCount,
    },
    computed_at: new Date().toISOString(),
  };

  await c.env.KV.put(`reputation:${wallet}`, JSON.stringify(result), { expirationTtl: 60 });

  return c.json(result);
});

export { reputation };
