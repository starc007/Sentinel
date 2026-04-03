import { Hono } from "hono";
import { Bot, InlineKeyboard } from "grammy";
import { formatApprovalRequest, type ApprovalRequestData } from "./messages";

type Bindings = {
  TELEGRAM_BOT_TOKEN: string;
  SENTINEL_SERVER: Fetcher;
  TELEGRAM_CHAT_ID: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => c.json({ status: "ok", service: "sentinel-bot" }));

// Handle Telegram webhook updates directly (no grammy middleware)
app.post("/webhook", async (c) => {
  const update = await c.req.json() as {
    callback_query?: {
      id: string;
      data?: string;
      message?: { message_id: number; chat: { id: number } };
    };
    message?: {
      text?: string;
      chat: { id: number };
    };
  };

  const bot = new Bot(c.env.TELEGRAM_BOT_TOKEN);

  // Handle /start command
  if (update.message?.text === "/start") {
    await bot.api.sendMessage(
      update.message.chat.id,
      "Sentinel active. You'll receive notifications when agent transactions need approval."
    );
    return c.json({ ok: true });
  }

  // Handle button callbacks
  if (update.callback_query?.data) {
    const data = update.callback_query.data;
    const callbackId = update.callback_query.id;
    const chatId = update.callback_query.message?.chat.id;
    const messageId = update.callback_query.message?.message_id;

    const approveMatch = data.match(/^approve:(.+)$/);
    const rejectMatch = data.match(/^reject:(.+)$/);

    if (approveMatch) {
      const id = approveMatch[1];
      try {
        const res = await c.env.SENTINEL_SERVER.fetch(`https://sentinel-server/approve/${id}`, {
          method: "POST",
        });
        const text = await res.text();
        const result = JSON.parse(text) as { status: string; error?: string };

        if (result.status === "approved") {
          try { await bot.api.answerCallbackQuery(callbackId, { text: "Approved!" }); } catch {}
          if (chatId && messageId) {
            try { await bot.api.editMessageText(chatId, messageId, "✅ Transaction APPROVED"); } catch {}
          }
        } else {
          try { await bot.api.answerCallbackQuery(callbackId, { text: result.error ?? "Already resolved" }); } catch {}
        }
      } catch (e: any) {
        console.error(`Approve ${id} failed:`, e?.message ?? e);
        try { await bot.api.answerCallbackQuery(callbackId, { text: "Error approving" }); } catch {}
        if (chatId && messageId) {
          try { await bot.api.editMessageText(chatId, messageId, "⚠️ Error approving — try again"); } catch {}
        }
      }
    }

    if (rejectMatch) {
      const id = rejectMatch[1];
      const res = await c.env.SENTINEL_SERVER.fetch(`https://sentinel-server/reject/${id}`, {
        method: "POST",
      });
      const result = (await res.json()) as { status: string; error?: string };

      if (result.status === "rejected") {
        try { await bot.api.answerCallbackQuery(callbackId, { text: "Rejected" }); } catch {}
        if (chatId && messageId) {
          try { await bot.api.editMessageText(chatId, messageId, "❌ Transaction REJECTED"); } catch {}
        }
      } else {
        try { await bot.api.answerCallbackQuery(callbackId, { text: result.error ?? "Already resolved" }); } catch {}
      }
    }
  }

  return c.json({ ok: true });
});

// Called by sentinel server to send approval request
app.post("/notify", async (c) => {
  const data = await c.req.json() as ApprovalRequestData & { id: string; wallet_id: string; chain_id: string };
  try {
    const bot = new Bot(c.env.TELEGRAM_BOT_TOKEN);
    const message = formatApprovalRequest({
      walletId: data.wallet_id,
      to: data.to,
      tier: data.tier,
      value: data.value,
      chainId: data.chain_id,
      score: data.score,
      reason: data.reason,
    });

    const keyboard = new InlineKeyboard()
      .text("✅ Approve", `approve:${data.id}`)
      .text("❌ Reject", `reject:${data.id}`);

    await bot.api.sendMessage(c.env.TELEGRAM_CHAT_ID, message, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? String(e) }, 500);
  }
});

export default app;
