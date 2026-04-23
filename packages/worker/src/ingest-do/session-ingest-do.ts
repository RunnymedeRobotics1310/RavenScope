import { eq, sql } from "drizzle-orm"
import { createDb, type Db } from "../db/client"
import { sessionBatches, telemetrySessions } from "../db/schema"
import type { Env } from "../env"
import { putBatchJsonl } from "../storage/r2"

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
  private sessionDbId: string | null = null

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    state.blockConcurrencyWhile(async () => {
      const storedSeq = await state.storage.get<number>("seq")
      const storedId = await state.storage.get<string>("sessionDbId")
      if (typeof storedSeq === "number") this.seq = storedSeq
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

    // Critical section: seq allocation + R2 write + D1 batch + seq advance.
    // Wrapped in blockConcurrencyWhile so two concurrent /data calls to the
    // same session (same DO) can't both compute the same seq and race on the
    // session_batches UNIQUE constraint. Cloudflare's default input gate
    // preserves state across I/O yields but does not serialize full
    // critical sections — blockConcurrencyWhile does.
    return this.state.blockConcurrencyWhile(async () => {
      await this.bindSessionId(sessionDbId)

      const db = createDb(this.env)
      await this.hydrateSeq(db, sessionDbId)
      const nextSeq = (this.seq ?? 0) + 1

      // 1. R2 write first. On failure, no seq advance, no D1 mutation.
      let r2Result: { key: string; rawByteLength: number; storedByteLength: number }
      try {
        r2Result = await putBatchJsonl(this.env, sessionDbId, nextSeq, entries)
      } catch (err) {
        return new Response(`r2_write_failed: ${String(err)}`, { status: 503 })
      }

      // 2. D1 atomic group: insert batch row + bump uploaded_count + touch
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
            byteLength: r2Result.rawByteLength,
            entryCount: entries.length,
            r2Key: r2Result.key,
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
        // the same number and overwrites the orphan R2 object.
        return new Response(`d1_batch_failed: ${String(err)}`, { status: 503 })
      }

      // 3. Only now advance seq in memory + storage.
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
