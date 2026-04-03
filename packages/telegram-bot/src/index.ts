import { Hono } from "hono";
import { Bot, InlineKeyboard } from "grammy";
import { formatApprovalRequest, type ApprovalRequestData } from "./messages";

type Bindings = {
  TELEGRAM_BOT_TOKEN: string;
  SENTINEL_SERVER: Fetcher;
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

  // Handle /start {wallet_address} — registers chat ID for this wallet
  if (update.message?.text?.startsWith("/start")) {
    const chatId = update.message.chat.id;
    const parts = update.message.text.split(" ");
    const wallet = parts[1]?.toLowerCase();

    if (wallet && wallet.startsWith("0x") && wallet.length === 42) {
      // Register wallet → chat_id on the server
      try {
        await c.env.SENTINEL_SERVER.fetch("https://sentinel-server/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wallet, chat_id: String(chatId) }),
        });
        await bot.api.sendMessage(chatId,
          `✅ Sentinel active!\n\nWallet <code>${wallet}</code> linked.\nYou'll receive notifications when transactions need approval.`,
          { parse_mode: "HTML" }
        );
      } catch {
        await bot.api.sendMessage(chatId, "Failed to register wallet. Please try again.");
      }
    } else {
      await bot.api.sendMessage(chatId,
        `👋 Welcome to Sentinel!\n\nTo link your wallet, send:\n<code>/start 0xYourWalletAddress</code>`,
        { parse_mode: "HTML" }
      );
    }
    return c.json({ ok: true });
  }

  // Handle button callbacks
  if (update.callback_query?.data) {
    const data = update.callback_query.data;
    const callbackId = update.callback_query.id;
    const chatId = update.callback_query.message?.chat.id;
    const messageId = update.callback_query.message?.message_id;
    const originalText = update.callback_query.message?.text ?? "";

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
      } catch {
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
      } catch {
        try { await bot.api.answerCallbackQuery(callbackId, { text: "Error rejecting" }); } catch {}
      }
    }
  }

  return c.json({ ok: true });
});

// Called by sentinel server to send approval request
app.post("/notify", async (c) => {
  const data = await c.req.json() as ApprovalRequestData & {
    id: string;
    wallet_id: string;
    chain_id: string;
    chat_id: string;
  };

  if (!data.chat_id) return c.json({ ok: false, error: "no chat_id" }, 400);

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

    await bot.api.sendMessage(data.chat_id, message, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? String(e) }, 500);
  }
});

export default app;
