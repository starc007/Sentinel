import { Hono } from "hono";
import type { Bindings, PendingTx } from "../types";
import { isValidAddress } from "../lib/validate";

const queue = new Hono<{ Bindings: Bindings }>();
const publicRoutes = new Hono<{ Bindings: Bindings }>();

// Register wallet → Telegram chat ID mapping
publicRoutes.post("/register", async (c) => {
  const body = await c.req.json<{ wallet: string; chat_id: string }>();
  if (!body.wallet || !body.chat_id) return c.json({ error: "wallet and chat_id required" }, 400);
  await c.env.KV.put(`chat:${body.wallet.toLowerCase()}`, body.chat_id);
  return c.json({ ok: true, wallet: body.wallet.toLowerCase() });
});

// Check if wallet has a linked Telegram chat
publicRoutes.get("/registered/:wallet", async (c) => {
  const wallet = c.req.param("wallet").toLowerCase();
  const chatId = await c.env.KV.get(`chat:${wallet}`);
  return c.json({ registered: !!chatId });
});

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

  // Look up Telegram chat ID for this wallet and notify
  if (c.env.TELEGRAM_BOT) {
    c.executionCtx.waitUntil(
      (async () => {
        const chatId = await c.env.KV.get(`chat:${body.wallet_id.toLowerCase()}`);
        if (!chatId) return;
        await c.env.TELEGRAM_BOT.fetch("https://sentinel-telegram-bot/notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...pending, chat_id: chatId }),
        });
      })().catch((e) => console.error("Telegram notify failed:", e))
    );
  }

  return c.json({ id, status: "pending" });
});

// Public: agent SDK polls this (UUID is unguessable)
// Uses a dedicated status:{id} key for instant reads (no KV consistency lag)
publicRoutes.get("/status/:id", async (c) => {
  const id = c.req.param("id");

  // Fast path: check lightweight status key first
  const quickStatus = await c.env.KV.get(`status:${id}`);
  if (quickStatus) return c.json({ status: quickStatus });

  // Fallback: check the full pending object
  const pending = await c.env.KV.get<PendingTx>(`pending:${id}`, "json");
  if (!pending) return c.json({ error: "not_found" }, 404);
  return c.json({ status: pending.status });
});

// Public: Telegram bot calls these via service binding
publicRoutes.post("/approve/:id", async (c) => {
  const id = c.req.param("id");
  const pending = await c.env.KV.get<PendingTx>(`pending:${id}`, "json");
  if (!pending) return c.json({ error: "not_found" }, 404);
  if (pending.status !== "pending") return c.json({ error: "already_resolved", status: pending.status });

  pending.status = "approved";

  // Write all keys in parallel for speed
  await Promise.all([
    c.env.KV.put(`status:${id}`, "approved", { expirationTtl: 3600 }),
    c.env.KV.put(`pending:${id}`, JSON.stringify(pending), { expirationTtl: 3600 }),
    c.env.KV.put(
      `approved:${pending.wallet_id.toLowerCase()}:${pending.to.toLowerCase()}`,
      JSON.stringify({ value: pending.value, chain_id: pending.chain_id, approved_at: new Date().toISOString() }),
      { expirationTtl: 600 }
    ),
  ]);

  return c.json({ status: "approved" });
});

publicRoutes.post("/reject/:id", async (c) => {
  const id = c.req.param("id");
  const pending = await c.env.KV.get<PendingTx>(`pending:${id}`, "json");
  if (!pending) return c.json({ error: "not_found" }, 404);
  if (pending.status !== "pending") return c.json({ error: "already_resolved", status: pending.status });

  pending.status = "rejected";

  await Promise.all([
    c.env.KV.put(`status:${id}`, "rejected", { expirationTtl: 3600 }),
    c.env.KV.put(`pending:${id}`, JSON.stringify(pending), { expirationTtl: 3600 }),
  ]);

  return c.json({ status: "rejected" });
});

export { queue, publicRoutes };
