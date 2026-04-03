import { Hono } from "hono";
import { paymentMiddlewareFromConfig } from "@x402/hono";
import type { Bindings } from "./types";
import { reputation } from "./routes/reputation";
import { audit } from "./routes/audit";
import { queue } from "./routes/queue";
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

// Auth middleware for internal routes
const internal = new Hono<{ Bindings: Bindings }>();
internal.use("*", async (c, next) => {
  const key = c.req.header("X-Sentinel-Key");
  if (key !== c.env.SENTINEL_KEY) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});
internal.route("/", reputation);
internal.route("/", audit);
internal.route("/", queue);
app.route("/", internal);

export default app;
