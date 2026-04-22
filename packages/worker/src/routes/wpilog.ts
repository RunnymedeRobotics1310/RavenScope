import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { requireCookieUser } from "../auth/require-cookie-user"
import { requireCookieKind } from "../auth/user"
import { createDb } from "../db/client"
import { telemetrySessions } from "../db/schema"
import type { Env } from "../env"
import { R2MultipartWpilogWriter, streamSessionBatches } from "../storage/r2"
import { wpilogKey as wpilogKeyFor } from "../storage/keys"
import { adaptedR2Source } from "../wpilog/adapter"
import { convertStreaming } from "../wpilog/convert"

export const wpilogRoutes = new Hono<{ Bindings: Env }>()
wpilogRoutes.use("*", requireCookieUser)

wpilogRoutes.get("/:id/wpilog", async (c) => {
  const user = c.var.user
  requireCookieKind(user)
  const id = c.req.param("id")

  const db = createDb(c.env)
  const [session] = await db
    .select()
    .from(telemetrySessions)
    .where(
      and(
        eq(telemetrySessions.id, id),
        eq(telemetrySessions.workspaceId, user.workspaceId),
      ),
    )
    .limit(1)
  if (!session) return c.json({ error: "not_found" }, 404)

  // Cache gate: cache is fresh when wpilog_generated_at >=
  // COALESCE(last_batch_at, ended_at, 0).
  const cacheMark = Math.max(
    session.lastBatchAt ? session.lastBatchAt.getTime() : 0,
    session.endedAt ? session.endedAt.getTime() : 0,
  )
  const cacheFresh =
    !!session.wpilogKey &&
    !!session.wpilogGeneratedAt &&
    session.wpilogGeneratedAt.getTime() >= cacheMark

  if (cacheFresh) {
    const cached = await c.env.BLOBS.get(session.wpilogKey!)
    if (cached) {
      return streamWpilogResponse(cached.body, session.sessionId)
    }
    // Stale key pointing at missing object — fall through to regenerate.
  }

  // Cache miss (or broken): regenerate.
  const key = wpilogKeyFor(session.id)
  const writer = new R2MultipartWpilogWriter(c.env.BLOBS, key)
  try {
    await writer.init()
    const factory = adaptedR2Source(
      () => streamSessionBatches(c.env, session.id),
      session.startedAt,
    )
    await convertStreaming(writer, factory, session.teamNumber ?? 0, session.sessionId)
    await writer.finalize()
  } catch (err) {
    await writer.abort().catch(() => {})
    return c.text(`wpilog_generation_failed: ${String(err)}`, 503)
  }

  await db
    .update(telemetrySessions)
    .set({ wpilogKey: key, wpilogGeneratedAt: new Date() })
    .where(eq(telemetrySessions.id, session.id))

  const obj = await c.env.BLOBS.get(key)
  if (!obj) return c.text("wpilog_missing_after_write", 503)
  return streamWpilogResponse(obj.body, session.sessionId)
})

function streamWpilogResponse(body: ReadableStream, sessionId: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${sessionId}.wpilog"`,
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  })
}
