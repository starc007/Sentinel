import { Hono } from "hono";
import type { Bindings, PendingTx } from "../types";
import { createApprovalToken } from "../lib/hmac";

const queue = new Hono<{ Bindings: Bindings }>();

queue.post("/queue", async (c) => {
  const body = await c.req.json<{
    wallet_id: string;
    value: string;
    chain_id: string;
    raw_hex: string;
    reason: string;
    tier: string;
    score: number;
  }>();

  const id = crypto.randomUUID();

  const pending: PendingTx = {
    id,
    wallet_id: body.wallet_id,
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

queue.get("/status/:id", async (c) => {
  const id = c.req.param("id");
  const pending = await c.env.KV.get<PendingTx>(`pending:${id}`, "json");
  if (!pending) return c.json({ error: "not_found" }, 404);
  return c.json({
    status: pending.status,
    token: pending.status === "approved" ? pending.token : undefined,
  });
});

queue.post("/approve/:id", async (c) => {
  const id = c.req.param("id");
  const pending = await c.env.KV.get<PendingTx>(`pending:${id}`, "json");
  if (!pending) return c.json({ error: "not_found" }, 404);
  if (pending.status !== "pending") return c.json({ error: "already_resolved", status: pending.status });

  const token = await createApprovalToken(id, c.env.SENTINEL_SECRET, 600);
  pending.status = "approved";
  pending.token = token;
  await c.env.KV.put(`pending:${id}`, JSON.stringify(pending), { expirationTtl: 3600 });

  return c.json({ status: "approved", token });
});

queue.post("/reject/:id", async (c) => {
  const id = c.req.param("id");
  const pending = await c.env.KV.get<PendingTx>(`pending:${id}`, "json");
  if (!pending) return c.json({ error: "not_found" }, 404);
  if (pending.status !== "pending") return c.json({ error: "already_resolved", status: pending.status });

  pending.status = "rejected";
  await c.env.KV.put(`pending:${id}`, JSON.stringify(pending), { expirationTtl: 3600 });

  return c.json({ status: "rejected" });
});

export { queue };
