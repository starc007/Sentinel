import { Hono } from "hono";
import type { Bindings } from "./types";
import { reputation } from "./routes/reputation";
import { audit } from "./routes/audit";
import { queue } from "./routes/queue";
import { scan } from "./routes/scan";

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => c.json({ status: "ok", service: "sentinel" }));

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

// x402 payment gate on /scan — wrap in try/catch in case x402 isn't configured
app.route("/", scan);

export default app;
