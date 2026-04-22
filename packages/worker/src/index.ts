import { Hono } from "hono"
import { httpsOnly } from "./auth/https-only"
import { authRoutes } from "./routes/auth"
import type { Env } from "./env"

export { SessionIngestDO } from "./ingest-do/session-ingest-do"
export { RateLimitDO } from "./auth/rate-limit"

const app = new Hono<{ Bindings: Env }>()

app.use("*", httpsOnly)

app.get("/api/health", (c) => c.json({ ok: true }))
app.route("/api/auth", authRoutes)

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>
