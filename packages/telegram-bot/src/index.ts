import { Hono } from "hono";
import { webhookCallback } from "grammy";
import { createBot, sendApprovalRequest, type BotEnv } from "./bot";

type Bindings = BotEnv;

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => c.json({ status: "ok", service: "sentinel-bot" }));

app.post("/webhook", async (c) => {
  const bot = createBot(c.env);
  const handler = webhookCallback(bot, "hono");
  return handler(c);
});

app.post("/notify", async (c) => {
  const data = await c.req.json();
  try {
    await sendApprovalRequest(c.env, data);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? String(e) }, 500);
  }
});

export default app;
