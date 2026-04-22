import { Hono } from "hono"
import { httpsOnly } from "./auth/https-only"
import { apiKeyRoutes } from "./routes/api-keys"
import { authRoutes } from "./routes/auth"
import { sessionsRoutes } from "./routes/sessions"
import { telemetryRoutes } from "./routes/telemetry"
import { wpilogRoutes } from "./routes/wpilog"
import type { Env } from "./env"

export { SessionIngestDO } from "./ingest-do/session-ingest-do"
export { RateLimitDO } from "./auth/rate-limit"

const app = new Hono<{ Bindings: Env }>()

app.use("*", httpsOnly)

app.get("/api/health", (c) => c.json({ ok: true }))
app.route("/api/auth", authRoutes)
app.route("/api/keys", apiKeyRoutes)
app.route("/api/sessions", sessionsRoutes)
app.route("/api/sessions", wpilogRoutes)
app.route("/api/telemetry", telemetryRoutes)

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>
