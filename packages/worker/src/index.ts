import { Hono } from "hono"
import { httpsOnly } from "./auth/https-only"
import { advantagescopeRoutes } from "./routes/advantagescope"
import { apiKeyRoutes } from "./routes/api-keys"
import { authRoutes } from "./routes/auth"
import { inviteAcceptRoutes, workspacesRoutes } from "./routes/invites"
import { meViewerLayoutRoutes } from "./routes/me-viewer-layout"
import { sessionsRoutes } from "./routes/sessions"
import { telemetryRoutes } from "./routes/telemetry"
import { viewerLayoutsRoutes } from "./routes/viewer-layouts"
import { workspaceMembersRoutes } from "./routes/workspace-members"
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
app.route("/api/workspaces", workspacesRoutes)
app.route("/api/workspaces", workspaceMembersRoutes)
app.route("/api/workspaces", viewerLayoutsRoutes)
app.route("/api/invites", inviteAcceptRoutes)
app.route("/api/me", meViewerLayoutRoutes)
app.route("/v", advantagescopeRoutes)

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>
