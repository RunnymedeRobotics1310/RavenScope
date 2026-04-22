import { Hono } from "hono"
import type { Env } from "./env"

export { SessionIngestDO } from "./ingest-do/session-ingest-do"

const app = new Hono<{ Bindings: Env }>()

app.get("/api/health", (c) => c.json({ ok: true }))

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>
