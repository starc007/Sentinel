import { Hono } from "hono";
import { paymentMiddlewareFromConfig } from "@x402/hono";
import { verifyMessage } from "ethers";
import type { Bindings } from "./types";
import { reputation } from "./routes/reputation";
import { audit } from "./routes/audit";
import { queue, publicRoutes } from "./routes/queue";
import { scan } from "./routes/scan";

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => c.json({ status: "ok", service: "sentinel" }));

// x402 payment gate on /scan (public, before auth middleware)
app.use("/scan/*", async (c, next) => {
  try {
    const mw = paymentMiddlewareFromConfig(
      {
        "GET /scan/:address": {
          accepts: {
            scheme: "exact",
            payTo: c.env.X402_RECEIVE_ADDRESS,
            price: "$0.01",
            network: "eip155:84532",
          },
          description: "Sentinel reputation query",
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      false // don't sync facilitator on start — avoids crash in dev
    );
    return await mw(c, next);
  } catch {
    // x402 not available — pass through without payment gate
    return next();
  }
});
app.route("/", scan);

// Public: agent SDK polls status, Telegram bot calls approve/reject
app.route("/", publicRoutes);

// Wallet signature auth middleware
// Policy sends X-Wallet-Sig (signed "sentinel:{address}") and X-Wallet-Address headers
// Server recovers address from sig and verifies it matches
const authed = new Hono<{ Bindings: Bindings }>();
authed.use("*", async (c, next) => {
  const sig = c.req.header("X-Wallet-Sig");
  const wallet = c.req.header("X-Wallet-Address")?.toLowerCase();

  if (!sig || !wallet) {
    return c.json({ error: "missing X-Wallet-Sig or X-Wallet-Address header" }, 401);
  }

  try {
    const recovered = verifyMessage(`sentinel:${wallet}`, sig).toLowerCase();
    if (recovered !== wallet) {
      return c.json({ error: "signature does not match wallet" }, 401);
    }
  } catch {
    return c.json({ error: "invalid signature" }, 401);
  }

  await next();
});
authed.route("/", reputation);
authed.route("/", audit);
authed.route("/", queue);
app.route("/", authed);

export default app;
