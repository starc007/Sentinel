import { Bot, InlineKeyboard } from "grammy";
import { formatApprovalRequest } from "./messages";

export type BotEnv = {
  TELEGRAM_BOT_TOKEN: string;
  SENTINEL_SERVER: Fetcher;
  SENTINEL_KEY: string;
  TELEGRAM_CHAT_ID: string;
};

export function createBot(env: BotEnv) {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  bot.command("start", (ctx) =>
    ctx.reply("Sentinel active. You'll receive notifications when agent transactions need approval.")
  );

  bot.callbackQuery(/^approve:(.+)$/, async (ctx) => {
    const id = ctx.match![1];
    try {
      const res = await env.SENTINEL_SERVER.fetch(`https://sentinel-server/approve/${id}`, {
        method: "POST",
        headers: { "X-Sentinel-Key": env.SENTINEL_KEY },
      });
      const data = (await res.json()) as { status: string };

      if (data.status === "approved") {
        await ctx.answerCallbackQuery({ text: "Approved!" });
        await ctx.editMessageText(
          ctx.callbackQuery.message?.text + "\n\n✅ <b>APPROVED</b>",
          { parse_mode: "HTML" }
        );
      } else {
        await ctx.answerCallbackQuery({ text: "Already resolved" });
      }
    } catch (e: any) {
      await ctx.answerCallbackQuery({ text: "Error: " + (e?.message ?? "unknown") });
    }
  });

  bot.callbackQuery(/^reject:(.+)$/, async (ctx) => {
    const id = ctx.match![1];
    try {
      const res = await env.SENTINEL_SERVER.fetch(`https://sentinel-server/reject/${id}`, {
        method: "POST",
        headers: { "X-Sentinel-Key": env.SENTINEL_KEY },
      });
      const data = (await res.json()) as { status: string };

      if (data.status === "rejected") {
        await ctx.answerCallbackQuery({ text: "Rejected" });
        await ctx.editMessageText(
          ctx.callbackQuery.message?.text + "\n\n❌ <b>REJECTED</b>",
          { parse_mode: "HTML" }
        );
      } else {
        await ctx.answerCallbackQuery({ text: "Already resolved" });
      }
    } catch (e: any) {
      await ctx.answerCallbackQuery({ text: "Error: " + (e?.message ?? "unknown") });
    }
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
