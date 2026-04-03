import { Hono } from "hono";
import type { Bindings, PendingTx } from "../types";
import { isValidAddress } from "../lib/validate";

const queue = new Hono<{ Bindings: Bindings }>();
const publicRoutes = new Hono<{ Bindings: Bindings }>();

// Authed: policy calls this to queue a tx for approval
queue.post("/queue", async (c) => {
  const body = await c.req.json<{
    wallet_id: string;
    to: string;
    value: string;
    chain_id: string;
    raw_hex: string;
    reason: string;
    tier: string;
    score: number;
  }>();

  if (body.to && !isValidAddress(body.to)) return c.json({ error: "invalid_to_address" }, 400);

  const id = crypto.randomUUID();

  const pending: PendingTx = {
    id,
    wallet_id: body.wallet_id,
    to: body.to,
    value: body.value,
    chain_id: body.chain_id,
    raw_hex: body.raw_hex,
    reason: body.reason,
    tier: body.tier,
    score: body.score,
    status: "pending",
    created_at: new Date().toISOString(),
  };

  await c.env.KV.put(`pending:${id}`, JSON.stringify(pending), { expirationTtl: 3600 });

  if (c.env.TELEGRAM_BOT) {
    c.executionCtx.waitUntil(
      c.env.TELEGRAM_BOT.fetch("https://sentinel-telegram-bot/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pending),
      }).catch((e) => console.error("Telegram notify failed:", e))
    );
  }

  return c.json({ id, status: "pending" });
});

// Public: agent SDK polls this (UUID is unguessable)
publicRoutes.get("/status/:id", async (c) => {
  const id = c.req.param("id");
  const pending = await c.env.KV.get<PendingTx>(`pending:${id}`, "json");
  if (!pending) return c.json({ error: "not_found" }, 404);

  // If KV shows pending, double-check the approval key (KV eventual consistency workaround)
  if (pending.status === "pending" && pending.wallet_id && pending.to) {
    const approvalKey = `approved:${pending.wallet_id.toLowerCase()}:${pending.to.toLowerCase()}`;
    const approval = await c.env.KV.get(approvalKey);
    if (approval) return c.json({ status: "approved" });
  }

  return c.json({ status: pending.status });
});

// Public: Telegram bot calls these via service binding
publicRoutes.post("/approve/:id", async (c) => {
  const id = c.req.param("id");
  const pending = await c.env.KV.get<PendingTx>(`pending:${id}`, "json");
  if (!pending) return c.json({ error: "not_found" }, 404);
  if (pending.status !== "pending") return c.json({ error: "already_resolved", status: pending.status });

  pending.status = "approved";
  await c.env.KV.put(`pending:${id}`, JSON.stringify(pending), { expirationTtl: 3600 });

  const approvalKey = `approved:${pending.wallet_id.toLowerCase()}:${pending.to.toLowerCase()}`;
  await c.env.KV.put(approvalKey, JSON.stringify({
    value: pending.value,
    chain_id: pending.chain_id,
    approved_at: new Date().toISOString(),
  }), { expirationTtl: 600 });

  return c.json({ status: "approved" });
});

publicRoutes.post("/reject/:id", async (c) => {
  const id = c.req.param("id");
  const pending = await c.env.KV.get<PendingTx>(`pending:${id}`, "json");
  if (!pending) return c.json({ error: "not_found" }, 404);
  if (pending.status !== "pending") return c.json({ error: "already_resolved", status: pending.status });

  pending.status = "rejected";
  await c.env.KV.put(`pending:${id}`, JSON.stringify(pending), { expirationTtl: 3600 });

  return c.json({ status: "rejected" });
});

export { queue, publicRoutes };
