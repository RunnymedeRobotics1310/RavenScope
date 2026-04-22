import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm"
import { Hono } from "hono"
import { requireCookieUser } from "../auth/require-cookie-user"
import { requireCookieKind } from "../auth/user"
import { createDb, type Db } from "../db/client"
import { sessionBatches, telemetrySessions } from "../db/schema"
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

  // Serve from cache if fresh relative to the latest batch.
  const cached = await loadCachedTree(c.env, row.id)
  if (cached && isCacheFresh(cached, row.lastBatchAt)) {
    return c.json(cached satisfies KeyTreeResponse)
  }

  const tree = await buildTree(c.env, row.id)
  await cacheTree(c.env, row.id, tree)
  return c.json(tree satisfies KeyTreeResponse)
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
