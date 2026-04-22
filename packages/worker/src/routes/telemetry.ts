import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { requireApiKeyUser } from "../auth/require-apikey-user"
import { requireApiKeyKind } from "../auth/user"
import { logAudit } from "../audit/log"
import { createDb } from "../db/client"
import { telemetrySessions } from "../db/schema"
import type {
  BatchInsertResult,
  CompleteSessionRequest,
  CreateSessionRequest,
  TelemetryEntryRequest,
  TelemetrySessionResponse,
} from "../dto"
import type { Env } from "../env"

export const telemetryRoutes = new Hono<{ Bindings: Env }>()
telemetryRoutes.use("*", requireApiKeyUser)

telemetryRoutes.post("/session", async (c) => {
  const user = c.var.user
  requireApiKeyKind(user)

  const body = await c.req.json<CreateSessionRequest>().catch(() => null)
  if (!body || typeof body.sessionId !== "string" || typeof body.teamNumber !== "number") {
    return c.json({ error: "invalid_request" }, 400)
  }
  if (!body.robotIp || !body.startedAt) {
    return c.json({ error: "invalid_request" }, 400)
  }

  const db = createDb(c.env)

  // Idempotent: if (workspaceId, sessionId) already exists, return it.
  const [existing] = await db
    .select()
    .from(telemetrySessions)
    .where(
      and(
        eq(telemetrySessions.workspaceId, user.workspaceId),
        eq(telemetrySessions.sessionId, body.sessionId),
      ),
    )
    .limit(1)

  if (existing) {
    return c.json(serialize(existing) satisfies TelemetrySessionResponse)
  }

  const [created] = await db
    .insert(telemetrySessions)
    .values({
      workspaceId: user.workspaceId,
      sessionId: body.sessionId,
      teamNumber: body.teamNumber,
      robotIp: body.robotIp,
      startedAt: new Date(body.startedAt),
    })
    .returning()

  await logAudit(db, {
    eventType: "session_create",
    actorApiKeyId: user.apiKeyId,
    workspaceId: user.workspaceId,
    metadata: { sessionDbId: created!.id, sessionId: body.sessionId },
  })

  return c.json(serialize(created!) satisfies TelemetrySessionResponse)
})

telemetryRoutes.get("/session/:sessionId", async (c) => {
  const user = c.var.user
  requireApiKeyKind(user)
  const sessionId = c.req.param("sessionId")

  const db = createDb(c.env)
  const [row] = await db
    .select()
    .from(telemetrySessions)
    .where(
      and(
        eq(telemetrySessions.workspaceId, user.workspaceId),
        eq(telemetrySessions.sessionId, sessionId),
      ),
    )
    .limit(1)
  if (!row) return c.json({ error: "not_found" }, 404)

  return c.json(serialize(row) satisfies TelemetrySessionResponse)
})

telemetryRoutes.post("/session/:sessionId/data", async (c) => {
  const user = c.var.user
  requireApiKeyKind(user)
  const sessionId = c.req.param("sessionId")

  const entries = await c.req.json<TelemetryEntryRequest[]>().catch(() => null)
  if (!Array.isArray(entries)) {
    return c.json({ error: "invalid_body" }, 400)
  }

  const db = createDb(c.env)
  const [row] = await db
    .select({ id: telemetrySessions.id })
    .from(telemetrySessions)
    .where(
      and(
        eq(telemetrySessions.workspaceId, user.workspaceId),
        eq(telemetrySessions.sessionId, sessionId),
      ),
    )
    .limit(1)
  if (!row) return c.json({ error: "not_found" }, 404)

  const stub = c.env.SESSION_INGEST_DO.get(c.env.SESSION_INGEST_DO.idFromName(row.id))
  const res = await stub.fetch("https://ingest.do/data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionDbId: row.id, entries }),
  })
  if (res.status >= 500) {
    return c.text(await res.text(), 503)
  }
  const result = (await res.json()) as BatchInsertResult
  return c.json(result satisfies BatchInsertResult)
})

telemetryRoutes.post("/session/:sessionId/complete", async (c) => {
  const user = c.var.user
  requireApiKeyKind(user)
  const sessionId = c.req.param("sessionId")

  const body = await c.req.json<CompleteSessionRequest>().catch(() => null)
  if (!body || typeof body.entryCount !== "number" || !body.endedAt) {
    return c.json({ error: "invalid_body" }, 400)
  }

  const db = createDb(c.env)
  const [row] = await db
    .select({ id: telemetrySessions.id })
    .from(telemetrySessions)
    .where(
      and(
        eq(telemetrySessions.workspaceId, user.workspaceId),
        eq(telemetrySessions.sessionId, sessionId),
      ),
    )
    .limit(1)
  if (!row) return c.json({ error: "not_found" }, 404)

  const stub = c.env.SESSION_INGEST_DO.get(c.env.SESSION_INGEST_DO.idFromName(row.id))
  const res = await stub.fetch("https://ingest.do/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionDbId: row.id,
      endedAt: body.endedAt,
      entryCount: body.entryCount,
    }),
  })
  if (res.status === 404) return c.json({ error: "not_found" }, 404)
  if (res.status >= 500) return c.text(await res.text(), 503)
  const session = (await res.json()) as TelemetrySessionResponse

  await logAudit(db, {
    eventType: "session_complete",
    actorApiKeyId: user.apiKeyId,
    workspaceId: user.workspaceId,
    metadata: { sessionDbId: row.id, sessionId },
  })

  return c.json(session satisfies TelemetrySessionResponse)
})

function serialize(row: typeof telemetrySessions.$inferSelect): TelemetrySessionResponse {
  return {
    id: row.id,
    sessionId: row.sessionId,
    teamNumber: row.teamNumber ?? 0,
    robotIp: row.robotIp ?? "",
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    entryCount: row.entryCount,
    uploadedCount: row.uploadedCount,
    createdAt: row.createdAt.toISOString(),
    tournamentId: row.tournamentId,
    matchLabel: row.matchLabel,
    matchLevel: row.matchLevel,
    matchNumber: row.matchNumber,
    playoffRound: row.playoffRound,
    fmsEventName: row.fmsEventName,
  }
}
