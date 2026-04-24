import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm"
import { Hono } from "hono"
import { hashIp, logAudit } from "../audit/log"
import { requireCookieUser } from "../auth/require-cookie-user"
import { requireOwnerRole } from "../auth/require-owner-role"
import { requireCookieKind } from "../auth/user"
import { createDb, type Db } from "../db/client"
import { sessionBatches, telemetrySessions } from "../db/schema"
import { batchPrefix } from "../storage/keys"
import type {
  KeyTreeResponse,
  SessionDetail,
  SessionListItem,
  SessionListOrder,
  SessionListResponse,
  SessionListSort,
} from "../dto"
import type { Env } from "../env"
import { buildTree, cacheTree, loadCachedTree } from "../ingest/tree-builder"
import { QuotaExceededError } from "../quota/daily-quota"
import { handleQuotaExceeded } from "../quota/http"
import { deleteBlob, listBlobs } from "../storage/r2"

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

export const sessionsRoutes = new Hono<{ Bindings: Env }>()
sessionsRoutes.use("*", requireCookieUser)

sessionsRoutes.get("/", async (c) => {
  const user = c.var.user
  requireCookieKind(user)

  const q = c.req.query("q")?.trim().toLowerCase()
  const sort = (c.req.query("sort") ?? "started_at") as SessionListSort
  const order = (c.req.query("order") ?? "desc") as SessionListOrder
  const cursor = c.req.query("cursor")
  const limit = clampLimit(c.req.query("limit"))

  if (!isValidSort(sort) || !isValidOrder(order)) {
    return c.json({ error: "invalid_query" }, 400)
  }

  const db = createDb(c.env)
  const conditions = [eq(telemetrySessions.workspaceId, user.workspaceId)]

  if (q) {
    conditions.push(
      sql`LOWER(COALESCE(${telemetrySessions.fmsEventName}, '')) LIKE ${`%${q}%`}`,
    )
  }

  if (cursor) {
    const decoded = decodeCursor(cursor)
    if (!decoded) return c.json({ error: "invalid_cursor" }, 400)
    conditions.push(keysetCondition(sort, order, decoded))
  }

  // Primary sort + deterministic tie-breaker on id.
  const sortColumn = sortColumnFor(sort)
  const primary = order === "desc" ? desc(sortColumn) : asc(sortColumn)
  const tiebreak = order === "desc" ? desc(telemetrySessions.id) : asc(telemetrySessions.id)

  const rows = await db
    .select()
    .from(telemetrySessions)
    .where(and(...conditions))
    .orderBy(primary, tiebreak)
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const lastRow = pageRows.at(-1)
  const nextCursor =
    hasMore && lastRow
      ? encodeCursor({
          sort,
          sortValue: readSortValue(lastRow, sort),
          id: lastRow.id,
        })
      : null

  const response: SessionListResponse = {
    items: pageRows.map(toListItem),
    nextCursor,
  }
  return c.json(response)
})

sessionsRoutes.get("/:id", async (c) => {
  const user = c.var.user
  requireCookieKind(user)
  const id = c.req.param("id")

  const db = createDb(c.env)
  const [row] = await db
    .select()
    .from(telemetrySessions)
    .where(
      and(eq(telemetrySessions.id, id), eq(telemetrySessions.workspaceId, user.workspaceId)),
    )
    .limit(1)
  if (!row) return c.json({ error: "not_found" }, 404)

  const batchCount = await countBatches(db, row.id)

  const detail: SessionDetail = {
    ...toListItem(row),
    robotIp: row.robotIp ?? "",
    createdAt: row.createdAt.toISOString(),
    tournamentId: row.tournamentId,
    matchLevel: row.matchLevel,
    matchNumber: row.matchNumber,
    playoffRound: row.playoffRound,
    batchCount,
    wpilogKey: row.wpilogKey,
  }
  return c.json(detail)
})

// PATCH + DELETE are writes — Members see + download session data (R2 in
// the plan) but cannot edit or delete it. Owner-only. See plan U6.
sessionsRoutes.patch("/:id", requireOwnerRole, async (c) => {
  const user = c.var.user
  requireCookieKind(user)
  const id = c.req.param("id")

  const body = await c.req.json<{ fmsEventName?: string | null }>().catch(() => null)
  if (!body) return c.json({ error: "invalid_body" }, 400)

  // Explicit allowlist — only fields the UI is allowed to edit.
  const patch: Partial<typeof telemetrySessions.$inferInsert> = {}
  if ("fmsEventName" in body) {
    const v = body.fmsEventName
    if (v !== null && (typeof v !== "string" || v.length > 200)) {
      return c.json({ error: "invalid_fms_event_name" }, 400)
    }
    patch.fmsEventName = typeof v === "string" ? v.trim() || null : null
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "no_fields_to_update" }, 400)
  }

  const db = createDb(c.env)
  const [row] = await db
    .select()
    .from(telemetrySessions)
    .where(
      and(eq(telemetrySessions.id, id), eq(telemetrySessions.workspaceId, user.workspaceId)),
    )
    .limit(1)
  if (!row) return c.json({ error: "not_found" }, 404)

  await db.update(telemetrySessions).set(patch).where(eq(telemetrySessions.id, row.id))

  const [updated] = await db
    .select()
    .from(telemetrySessions)
    .where(eq(telemetrySessions.id, row.id))
    .limit(1)

  const batchCount = await countBatches(db, row.id)
  const detail: SessionDetail = {
    ...toListItem(updated!),
    robotIp: updated!.robotIp ?? "",
    createdAt: updated!.createdAt.toISOString(),
    tournamentId: updated!.tournamentId,
    matchLevel: updated!.matchLevel,
    matchNumber: updated!.matchNumber,
    playoffRound: updated!.playoffRound,
    batchCount,
    wpilogKey: updated!.wpilogKey,
  }
  return c.json(detail)
})

sessionsRoutes.delete("/:id", requireOwnerRole, async (c) => {
  const user = c.var.user
  requireCookieKind(user)
  const id = c.req.param("id")

  const db = createDb(c.env)
  const [row] = await db
    .select()
    .from(telemetrySessions)
    .where(
      and(eq(telemetrySessions.id, id), eq(telemetrySessions.workspaceId, user.workspaceId)),
    )
    .limit(1)
  if (!row) return c.json({ error: "not_found" }, 404)

  // Delete every R2 object under sessions/<id>/ — batches, tree cache, and
  // any cached wpilog. Do this before the D1 delete so a mid-operation
  // failure leaves a recoverable state (D1 row + possibly orphan blobs)
  // rather than a dangling-pointer state (D1 gone, blobs still there).
  const prefix = batchPrefix(row.id)
  let cursor: string | undefined
  try {
    while (true) {
      const options: R2ListOptions = cursor ? { prefix, cursor } : { prefix }
      const listed = await listBlobs(c.env, options)
      for (const obj of listed.objects) {
        await deleteBlob(c.env, obj.key)
      }
      if (!listed.truncated) break
      cursor = listed.cursor
    }
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return handleQuotaExceeded(c, err, user.workspaceId)
    }
    throw err
  }

  // session_batches rows have ON DELETE CASCADE, so the telemetry_sessions
  // delete takes them out atomically.
  await db.delete(telemetrySessions).where(eq(telemetrySessions.id, row.id))

  const ipHash = await hashIp(c.req.header("CF-Connecting-IP") ?? "unknown")
  await logAudit(db, {
    eventType: "session_complete", // reusing existing enum; no session_delete yet
    actorUserId: user.userId,
    workspaceId: user.workspaceId,
    ipHash,
    metadata: { deleted: true, sessionDbId: row.id, sessionId: row.sessionId },
  })

  return c.body(null, 204)
})

sessionsRoutes.get("/:id/tree", async (c) => {
  const user = c.var.user
  requireCookieKind(user)
  const id = c.req.param("id")

  const db = createDb(c.env)
  const [row] = await db
    .select()
    .from(telemetrySessions)
    .where(
      and(eq(telemetrySessions.id, id), eq(telemetrySessions.workspaceId, user.workspaceId)),
    )
    .limit(1)
  if (!row) return c.json({ error: "not_found" }, 404)

  try {
    // Serve from cache if fresh relative to the latest batch.
    const cached = await loadCachedTree(c.env, row.id)
    if (cached && isCacheFresh(cached, row.lastBatchAt)) {
      return c.json(cached satisfies KeyTreeResponse)
    }

    const tree = await buildTree(c.env, row.id)
    await cacheTree(c.env, row.id, tree)
    return c.json(tree satisfies KeyTreeResponse)
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return handleQuotaExceeded(c, err, user.workspaceId)
    }
    throw err
  }
})

function isCacheFresh(cached: KeyTreeResponse, lastBatchAt: Date | null): boolean {
  if (!lastBatchAt) return true // no batches — any cache is fine
  return Date.parse(cached.generatedAt) >= lastBatchAt.getTime()
}

function toListItem(row: typeof telemetrySessions.$inferSelect): SessionListItem {
  return {
    id: row.id,
    sessionId: row.sessionId,
    teamNumber: row.teamNumber ?? 0,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    entryCount: row.entryCount,
    uploadedCount: row.uploadedCount,
    fmsEventName: row.fmsEventName,
    matchLabel: row.matchLabel,
    lastBatchAt: row.lastBatchAt ? row.lastBatchAt.toISOString() : null,
    wpilogGeneratedAt: row.wpilogGeneratedAt ? row.wpilogGeneratedAt.toISOString() : null,
  }
}

async function countBatches(db: Db, sessionDbId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(sessionBatches)
    .where(eq(sessionBatches.sessionId, sessionDbId))
  return row?.n ?? 0
}

function sortColumnFor(sort: SessionListSort) {
  switch (sort) {
    case "started_at":
      return telemetrySessions.startedAt
    case "fms_event_name":
      return telemetrySessions.fmsEventName
    case "match_label":
      return telemetrySessions.matchLabel
  }
}

function isValidSort(s: string): s is SessionListSort {
  return s === "started_at" || s === "fms_event_name" || s === "match_label"
}

function isValidOrder(o: string): o is SessionListOrder {
  return o === "asc" || o === "desc"
}

function clampLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}

/* Cursor encoding ---------------------------------------------------- */

interface CursorPayload {
  sort: SessionListSort
  /** Numeric (ms) for date sorts, string otherwise; null when the sort
   *  column was null — which still needs keyset comparison. */
  sortValue: number | string | null
  id: string
}

function encodeCursor(payload: CursorPayload): string {
  return btoa(JSON.stringify(payload))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const json = atob(
      cursor.replaceAll("-", "+").replaceAll("_", "/") +
        "===".slice((cursor.length + 3) % 4),
    )
    return JSON.parse(json) as CursorPayload
  } catch {
    return null
  }
}

function readSortValue(
  row: typeof telemetrySessions.$inferSelect,
  sort: SessionListSort,
): number | string | null {
  switch (sort) {
    case "started_at":
      return row.startedAt.getTime()
    case "fms_event_name":
      return row.fmsEventName
    case "match_label":
      return row.matchLabel
  }
}

function keysetCondition(
  sort: SessionListSort,
  order: SessionListOrder,
  cursor: CursorPayload,
) {
  const col = sortColumnFor(sort)
  // started_at is stored as INTEGER ms — use the raw number, not a Date
  // (D1 serializes Date via toString()/ISO, which doesn't match INTEGER).
  // Other sorts (fms_event_name, match_label) are TEXT columns and pass
  // through as-is.
  const bound = cursor.sortValue

  if (order === "desc") {
    return sql`((${col} < ${bound}) OR (${col} = ${bound} AND ${telemetrySessions.id} < ${cursor.id}))`
  }
  return sql`((${col} > ${bound}) OR (${col} = ${bound} AND ${telemetrySessions.id} > ${cursor.id}))`
}

// Silence unused-import warnings when neither gt nor lt is reached via helpers.
void gt
void lt
