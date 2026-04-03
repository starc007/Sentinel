import { Hono } from "hono";
import type { Bindings, AuditEvent } from "../types";
import { isValidAddress } from "../lib/validate";

const audit = new Hono<{ Bindings: Bindings }>();

audit.post("/audit", async (c) => {
  const body = await c.req.json<{
    wallet_id: string;
    action: "allow" | "deny";
    reason?: string;
    tx_value: string;
    chain_id: string;
  }>();

  if (!isValidAddress(body.wallet_id)) return c.json({ error: "invalid_address" }, 400);

  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    wallet_id: body.wallet_id,
    action: body.action,
    reason: body.reason,
    tx_value: body.tx_value,
    chain_id: body.chain_id,
  };

  const key = `audit:${body.wallet_id}`;
  const existing = await c.env.KV.get<AuditEvent[]>(key, "json");
  const events = existing ?? [];
  events.push(event);
  await c.env.KV.put(key, JSON.stringify(events));

  if (body.action === "allow") {
    const dateKey = `spend:${body.wallet_id}:${new Date().toISOString().slice(0, 10)}`;
    const currentSpend = parseFloat((await c.env.KV.get(dateKey)) ?? "0");
    const txValue = parseFloat(body.tx_value);
    await c.env.KV.put(dateKey, String(currentSpend + txValue), { expirationTtl: 86400 * 2 });
  }

  return c.json({ ok: true });
});

export { audit };
