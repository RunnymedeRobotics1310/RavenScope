import { eq, sql } from "drizzle-orm"
import { createDb, type Db } from "../db/client"
import { sessionBatches, telemetrySessions } from "../db/schema"
import type { Env } from "../env"
import { chargeOrThrow, QuotaExceededError } from "../quota/daily-quota"
import { encodeBatchJsonl, putBatchJsonlBytes } from "../storage/r2"

/**
 * Per-session ingest coordinator (one DO instance per telemetry_sessions.id).
 *
 * Serializes all /data and /complete writes for a given session so:
 *   - `seq` allocation cannot race
 *   - R2 writes, D1 batches, and WPILog cache invalidation happen in one
 *     atomic-ish sequence
 *
 * Invariants:
 *   - `seq` is loaded lazily from D1 on first call and cached in memory +
 *     DO storage across isolate lifetimes.
 *   - On R2 failure the DO returns 503 with no D1 mutation and no seq
 *     advance — the RavenLink uploader retries and reuses the same seq,
 *     deterministically overwriting any orphan R2 object.
 *   - `uploaded_count` is incremented atomically by `entries.length` per
 *     successful /data call, before the response is returned. No deferred
 *     waitUntil on that counter — RavenLink's resume path reads it via
 *     GET /session/{id}.
 */

interface IngestDataRequest {
  sessionDbId: string
  entries: unknown[]
}

interface IngestCompleteRequest {
  sessionDbId: string
  endedAt: string
  entryCount: number
}

export class SessionIngestDO implements DurableObject {
  private seq: number | null = null
  /**
   * Highest seq we've ever debited the daily quota for. Persisted
   * before the R2 PUT so that a retry after a D1 batch failure (or a DO
   * eviction between charge and success) doesn't double-charge the
   * counter for the same logical batch. See review finding F4.
   */
  private chargedSeq = 0
  private sessionDbId: string | null = null

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    state.blockConcurrencyWhile(async () => {
      const storedSeq = await state.storage.get<number>("seq")
      const storedChargedSeq = await state.storage.get<number>("chargedSeq")
      const storedId = await state.storage.get<string>("sessionDbId")
      if (typeof storedSeq === "number") this.seq = storedSeq
      if (typeof storedChargedSeq === "number") this.chargedSeq = storedChargedSeq
      if (typeof storedId === "string") this.sessionDbId = storedId
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    switch (url.pathname) {
      case "/data":
        return this.handleData(request)
      case "/complete":
        return this.handleComplete(request)
      default:
        return new Response("not found", { status: 404 })
    }
  }

  private async handleData(request: Request): Promise<Response> {
    const body = (await request.json()) as IngestDataRequest
    const { sessionDbId, entries } = body

    if (entries.length === 0) {
      await this.bindSessionId(sessionDbId)
      return Response.json({ count: 0 } satisfies { count: number })
    }

    // Critical section: seq allocation + quota charge + R2 write + D1 batch
    // + seq advance. Wrapped in blockConcurrencyWhile so two concurrent
    // /data calls to the same session (same DO) can't both compute the same
    // seq and race on the session_batches UNIQUE constraint.
    return this.state.blockConcurrencyWhile(async () => {
      await this.bindSessionId(sessionDbId)

      const db = createDb(this.env)
      await this.hydrateSeq(db, sessionDbId)
      const nextSeq = (this.seq ?? 0) + 1

      // 1. Encode the batch locally (no R2 yet) so we know the exact byte
      //    count to charge.
      const encoded = await encodeBatchJsonl(sessionDbId, nextSeq, entries)

      // 2. Charge quota, but only if we haven't already charged for this
      //    seq on a prior attempt. `chargedSeq` is persisted BEFORE the R2
      //    PUT so a D1 failure (or DO eviction) that forces a retry sees
      //    chargedSeq == nextSeq and skips the second charge. Without this
      //    dedup, a D1-flappy window would double-charge the daily counter
      //    per retry (review finding F4).
      if (nextSeq > this.chargedSeq) {
        try {
          await chargeOrThrow(this.env, {
            bytes: encoded.storedByteLength,
            classA: 1,
          })
        } catch (err) {
          if (err instanceof QuotaExceededError) {
            return cappedDoResponse(err)
          }
          throw err
        }
        this.chargedSeq = nextSeq
        await this.state.storage.put("chargedSeq", nextSeq)
      }

      // 3. R2 PUT. Uncharged at this layer — the charge already committed.
      //    On failure, chargedSeq stays at nextSeq so the retry skips the
      //    charge and deterministically overwrites any orphan object.
      try {
        await putBatchJsonlBytes(this.env, encoded.key, encoded.compressed)
      } catch (err) {
        return new Response(`r2_write_failed: ${String(err)}`, { status: 503 })
      }

      // 4. D1 atomic group: insert batch row + bump uploaded_count + touch
      //    last_batch_at + invalidate wpilog cache. db.batch ensures all-or-
      //    nothing at the D1 layer.
      try {
        await db.batch([
          db.insert(sessionBatches).values({
            sessionId: sessionDbId,
            seq: nextSeq,
            // byte_length stays as the raw JSONL length (users reading this
            // column see "N bytes of real telemetry"). storedByteLength is
            // used separately by the quota system (plan 2026-04-23-001).
            byteLength: encoded.rawByteLength,
            entryCount: entries.length,
            r2Key: encoded.key,
          }),
          db
            .update(telemetrySessions)
            .set({
              uploadedCount: sql`${telemetrySessions.uploadedCount} + ${entries.length}`,
              lastBatchAt: new Date(),
              wpilogKey: null,
              wpilogGeneratedAt: null,
            })
            .where(eq(telemetrySessions.id, sessionDbId)),
        ])
      } catch (err) {
        // D1 failed after R2 succeeded. Leave seq alone so the retry reuses
        // the same number and overwrites the orphan R2 object. chargedSeq
        // is already persisted at nextSeq → retry won't double-charge.
        return new Response(`d1_batch_failed: ${String(err)}`, { status: 503 })
      }

      // 5. Only now advance seq in memory + storage.
      this.seq = nextSeq
      await this.state.storage.put("seq", nextSeq)

      return Response.json({ count: entries.length } satisfies { count: number })
    })
  }

  private async handleComplete(request: Request): Promise<Response> {
    const body = (await request.json()) as IngestCompleteRequest
    const { sessionDbId, endedAt, entryCount } = body
    await this.bindSessionId(sessionDbId)

    const db = createDb(this.env)
    const [existing] = await db
      .select()
      .from(telemetrySessions)
      .where(eq(telemetrySessions.id, sessionDbId))
      .limit(1)
    if (!existing) return new Response("not_found", { status: 404 })

    const newEndedAt = new Date(endedAt)

    // Idempotent: same endedAt → no-op.
    if (existing.endedAt && existing.endedAt.getTime() === newEndedAt.getTime()) {
      return Response.json(serialize(existing))
    }

    await db
      .update(telemetrySessions)
      .set({
        endedAt: newEndedAt,
        entryCount,
        // Different endedAt (or first complete) always invalidates the
        // wpilog cache — the session's time range may have shifted.
        wpilogKey: null,
        wpilogGeneratedAt: null,
      })
      .where(eq(telemetrySessions.id, sessionDbId))

    const [updated] = await db
      .select()
      .from(telemetrySessions)
      .where(eq(telemetrySessions.id, sessionDbId))
      .limit(1)
    return Response.json(serialize(updated!))
  }

  private async bindSessionId(sessionDbId: string): Promise<void> {
    if (this.sessionDbId === sessionDbId) return
    this.sessionDbId = sessionDbId
    await this.state.storage.put("sessionDbId", sessionDbId)
  }

  private async hydrateSeq(db: Db, sessionDbId: string): Promise<void> {
    if (this.seq !== null) return
    const [row] = await db
      .select({ maxSeq: sql<number | null>`MAX(${sessionBatches.seq})` })
      .from(sessionBatches)
      .where(eq(sessionBatches.sessionId, sessionDbId))
    this.seq = row?.maxSeq ?? 0
    await this.state.storage.put("seq", this.seq)
  }
}

/**
 * DO-side 429 builder. Emits:
 *  - Retry-After (seconds-until-UTC-midnight, computed at breach time)
 *  - X-Quota-First-Breach (only on the 0→1 latch flip) so the Worker
 *    fires the operator alert via ctx.waitUntil
 *  - X-Quota-Breach-Date (always, when firstBreach) so the Worker's
 *    waitUntil reads the right D1 row even if it runs after UTC
 *    midnight (review finding F9).
 */
function cappedDoResponse(err: QuotaExceededError): Response {
  const headers: Record<string, string> = {
    "Retry-After": String(err.retryAfter),
  }
  if (err.firstBreach) {
    headers["X-Quota-First-Breach"] = err.metric
    headers["X-Quota-Breach-Date"] = err.row.date
  }
  return new Response(`quota_cap_hit: ${err.metric}`, {
    status: 429,
    headers,
  })
}

function serialize(row: typeof telemetrySessions.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    sessionId: row.sessionId,
    teamNumber: row.teamNumber,
    robotIp: row.robotIp,
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
