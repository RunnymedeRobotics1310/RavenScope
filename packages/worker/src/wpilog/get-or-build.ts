/**
 * Shared wpilog cache + regenerate logic. Both the download route at
 * /api/sessions/:id/wpilog and the embedded viewer log handler at
 * /v/:id/logs/<name> stream from the same source of truth: the cached R2
 * object at wpilogKey(session.id), regenerated on demand when the cache
 * is stale or missing.
 *
 * The helper does not set response headers -- callers wrap the body in
 * their own Response so each endpoint can pick its own Content-Disposition
 * (attachment vs inline) while sharing the cache policy verbatim. Error
 * responses (quota exceeded, generation failure, missing-after-write) are
 * already wrapped and returned in the non-ok branch for the caller to
 * forward.
 */
import type { Context } from "hono"
import { eq } from "drizzle-orm"
import type { OwnedSession } from "../auth/session-owner"
import { createDb } from "../db/client"
import { telemetrySessions } from "../db/schema"
import type { Env } from "../env"
import { chargeOrThrow, QuotaExceededError } from "../quota/daily-quota"
import { handleQuotaExceeded } from "../quota/http"
import {
  R2MultipartWpilogWriter,
  readPlainBlobStream,
  streamSessionBatches,
} from "../storage/r2"
import { wpilogKey as wpilogKeyFor } from "../storage/keys"
import { adaptedR2Source } from "./adapter"
import { convertStreaming } from "./convert"

export type WpilogResult =
  | { ok: true; body: ReadableStream<Uint8Array>; cached: boolean }
  | { ok: false; response: Response }

/**
 * Return a plain (uncompressed) WPILog stream for the given session,
 * using the cached R2 object when fresh or regenerating on miss. The
 * caller narrows on `ok` and wraps `body` in its own Response.
 */
export async function getOrBuildWpilog(
  c: Context<{ Bindings: Env }>,
  session: OwnedSession,
): Promise<WpilogResult> {
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
    try {
      // Charge the cache-hit read as one Class B op.
      await chargeOrThrow(c.env, { classB: 1 })
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        return { ok: false, response: handleQuotaExceeded(c, err, session.workspaceId) }
      }
      throw err
    }
    const cached = await c.env.BLOBS.get(session.wpilogKey!)
    if (cached) {
      return { ok: true, body: readPlainBlobStream(cached), cached: true }
    }
    // Stale key pointing at missing object — fall through to regenerate.
  }

  // Cache miss (or broken): regenerate.
  const key = wpilogKeyFor(session.id)
  const writer = new R2MultipartWpilogWriter(c.env.BLOBS, key)
  try {
    await writer.init(c.env)
    const factory = adaptedR2Source(
      () => streamSessionBatches(c.env, session.id),
      session.startedAt,
    )
    await convertStreaming(writer, factory, session.teamNumber ?? 0, session.sessionId)
    await writer.finalize()
  } catch (err) {
    await writer.abort().catch(() => {})
    if (err instanceof QuotaExceededError) {
      return { ok: false, response: handleQuotaExceeded(c, err, session.workspaceId) }
    }
    return { ok: false, response: c.text(`wpilog_generation_failed: ${String(err)}`, 503) }
  }

  const db = createDb(c.env)
  await db
    .update(telemetrySessions)
    .set({ wpilogKey: key, wpilogGeneratedAt: new Date() })
    .where(eq(telemetrySessions.id, session.id))

  const obj = await c.env.BLOBS.get(key)
  if (!obj) return { ok: false, response: c.text("wpilog_missing_after_write", 503) }
  return { ok: true, body: readPlainBlobStream(obj), cached: false }
}
