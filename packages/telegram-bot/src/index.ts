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

app.post("/webhook", async (c) => {
  const update = await c.req.json() as {
    callback_query?: {
      id: string;
      data?: string;
      message?: { message_id: number; chat: { id: number }; text?: string };
    };
    message?: {
      text?: string;
      chat: { id: number };
    };
  };

  const bot = new Bot(c.env.TELEGRAM_BOT_TOKEN);

  if (update.message?.text === "/start") {
    await bot.api.sendMessage(
      update.message.chat.id,
      "Sentinel active. You'll receive notifications when agent transactions need approval."
    );
    return c.json({ ok: true });
  }

  if (update.callback_query?.data) {
    const data = update.callback_query.data;
    const callbackId = update.callback_query.id;
    const chatId = update.callback_query.message?.chat.id;
    const messageId = update.callback_query.message?.message_id;
    const originalText = update.callback_query.message?.text ?? "";

    // Rebuild the HTML from plain text (Telegram sends plain text in callback)
    // We'll just append the status at the end
    const approveMatch = data.match(/^approve:(.+)$/);
    const rejectMatch = data.match(/^reject:(.+)$/);

    if (approveMatch) {
      const id = approveMatch[1];
      try {
        const res = await c.env.SENTINEL_SERVER.fetch(`https://sentinel-server/approve/${id}`, {
          method: "POST",
        });
        const result = (await res.json()) as { status: string; error?: string };

        if (result.status === "approved") {
          try { await bot.api.answerCallbackQuery(callbackId, { text: "Approved!" }); } catch {}
          if (chatId && messageId) {
            const updated = originalText.replace(/Status:.*$/, "Status: ✅ Approved");
            try { await bot.api.editMessageText(chatId, messageId, updated); } catch {}
          }
        } else {
          try { await bot.api.answerCallbackQuery(callbackId, { text: result.error ?? "Already resolved" }); } catch {}
        }
      } catch (e: any) {
        try { await bot.api.answerCallbackQuery(callbackId, { text: "Error approving" }); } catch {}
      }
    }

    if (rejectMatch) {
      const id = rejectMatch[1];
      try {
        const res = await c.env.SENTINEL_SERVER.fetch(`https://sentinel-server/reject/${id}`, {
          method: "POST",
        });
        const result = (await res.json()) as { status: string; error?: string };

        if (result.status === "rejected") {
          try { await bot.api.answerCallbackQuery(callbackId, { text: "Rejected" }); } catch {}
          if (chatId && messageId) {
            const updated = originalText.replace(/Status:.*$/, "Status: ❌ Rejected");
            try { await bot.api.editMessageText(chatId, messageId, updated); } catch {}
          }
        } else {
          try { await bot.api.answerCallbackQuery(callbackId, { text: result.error ?? "Already resolved" }); } catch {}
        }
      } catch (e: any) {
        try { await bot.api.answerCallbackQuery(callbackId, { text: "Error rejecting" }); } catch {}
      }
    }
  }

  return c.json({ ok: true });
});

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
