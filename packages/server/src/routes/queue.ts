import { Hono } from "hono";
import type { Bindings, PendingTx } from "../types";
import { isValidAddress } from "../lib/validate";

const queue = new Hono<{ Bindings: Bindings }>();
const publicRoutes = new Hono<{ Bindings: Bindings }>();

// Step 1: CLI creates a link code (authed — requires wallet sig)
queue.post("/create-link", async (c) => {
  const body = await c.req.json<{ wallet: string }>();
  if (!body.wallet) return c.json({ error: "wallet required" }, 400);
  const code = crypto.randomUUID().slice(0, 8);
  await c.env.KV.put(`link:${code}`, body.wallet.toLowerCase(), { expirationTtl: 300 });
  return c.json({ code });
});

// Step 2: Bot calls this with the code + chat_id (via service binding)
publicRoutes.post("/complete-link", async (c) => {
  const body = await c.req.json<{ code: string; chat_id: string }>();
  if (!body.code || !body.chat_id) return c.json({ error: "code and chat_id required" }, 400);

  const wallet = await c.env.KV.get(`link:${body.code}`);
  if (!wallet) return c.json({ error: "invalid or expired link code" }, 400);

  await c.env.KV.put(`chat:${wallet}`, body.chat_id);
  await c.env.KV.delete(`link:${body.code}`);
  return c.json({ ok: true, wallet });
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
