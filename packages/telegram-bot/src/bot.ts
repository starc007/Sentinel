import { Bot, InlineKeyboard } from "grammy";
import { formatApprovalRequest } from "./messages";

export type BotEnv = {
  TELEGRAM_BOT_TOKEN: string;
  SENTINEL_SERVER: Fetcher;
  TELEGRAM_CHAT_ID: string;
};

export function createBot(env: BotEnv) {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  bot.command("start", (ctx) =>
    ctx.reply("Sentinel active. You'll receive notifications when agent transactions need approval.")
  );

  bot.callbackQuery(/^approve:(.+)$/, async (ctx) => {
    const id = ctx.match![1];

    // Critical: approve the tx on the server
    const res = await env.SENTINEL_SERVER.fetch(`https://sentinel-server/approve/${id}`, {
      method: "POST",
    });
    const data = (await res.json()) as { status: string };

    // Best-effort: update Telegram UI (don't let failures crash the handler)
    try {
      if (data.status === "approved") {
        await ctx.answerCallbackQuery({ text: "Approved!" });
        await ctx.editMessageText("✅ Transaction APPROVED");
      } else {
        await ctx.answerCallbackQuery({ text: "Already resolved" });
      }
    } catch { /* Telegram UI update failed — tx is still approved */ }
  });

  bot.callbackQuery(/^reject:(.+)$/, async (ctx) => {
    const id = ctx.match![1];

    const res = await env.SENTINEL_SERVER.fetch(`https://sentinel-server/reject/${id}`, {
      method: "POST",
    });
    const data = (await res.json()) as { status: string };

    try {
      if (data.status === "rejected") {
        await ctx.answerCallbackQuery({ text: "Rejected" });
        await ctx.editMessageText("❌ Transaction REJECTED");
      } else {
        await ctx.answerCallbackQuery({ text: "Already resolved" });
      }
    } catch { /* Telegram UI update failed — tx is still rejected */ }
  });

  bot.catch((err) => {
    console.error("Bot error:", err.message);
  });

  return bot;
}

export async function sendApprovalRequest(
  env: BotEnv,
  data: {
    id: string;
    wallet_id: string;
    to: string;
    tier: string;
    value: string;
    chain_id: string;
    score: number;
    reason: string;
  }
) {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
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

  await bot.api.sendMessage(env.TELEGRAM_CHAT_ID, message, {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}
