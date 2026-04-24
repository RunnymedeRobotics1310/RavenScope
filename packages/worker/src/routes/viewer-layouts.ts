/**
 * Workspace-shared viewer layouts — shared-viewer-layouts plan U2.
 *
 * Mounted at /api/workspaces. Any workspace member can create, rename,
 * update the state of, or delete a layout in their workspace. Permission
 * model matches how sessions and wpilogs are already shared — no
 * owner-only gate. Cross-tenancy guard: the :wsid path param must match
 * c.var.user.workspaceId, else 403 forbidden.
 *
 * Routes:
 *   GET    /:wsid/layouts              list summaries (no state payload)
 *   GET    /:wsid/layouts/:id          full layout (with state)
 *   POST   /:wsid/layouts              {name, state} -> 201
 *   PATCH  /:wsid/layouts/:id          {name?, state?}
 *   DELETE /:wsid/layouts/:id          204
 *
 * Request bodies carrying `state` are capped at 256 KiB (stringified
 * JSON). HubState in practice is well under that; the cap is a sanity
 * guard against pathological payloads, surfaced as 413.
 */
import { and, asc, desc, eq } from "drizzle-orm"
import { Hono } from "hono"
import { requireCookieUser } from "../auth/require-cookie-user"
import { requireCookieKind } from "../auth/user"
import { createDb } from "../db/client"
import { workspaceViewerLayouts } from "../db/schema"
import type {
  SaveViewerLayoutRequest,
  UpdateViewerLayoutRequest,
  ViewerLayoutDto,
  ViewerLayoutSummary,
  ViewerLayoutsResponse,
} from "../dto"
import type { Env } from "../env"

export const viewerLayoutsRoutes = new Hono<{ Bindings: Env }>()
viewerLayoutsRoutes.use("*", requireCookieUser)

/** Max stringified JSON size for a layout state payload. HubState is
 *  usually sub-10 KiB; 256 KiB is a very loose guard against pathology
 *  or accidental JSON bomb, not an expected constraint. */
export const MAX_STATE_JSON_BYTES = 256 * 1024

function assertActiveWsid(
  userWsid: string,
  paramWsid: string,
): "ok" | "mismatch" {
  return userWsid === paramWsid ? "ok" : "mismatch"
}

function toSummary(row: {
  id: string
  name: string
  createdAt: Date
  updatedAt: Date
  createdByUserId: string | null
}): ViewerLayoutSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    createdByUserId: row.createdByUserId,
  }
}

function tryParse(state: string): unknown {
  try {
    return JSON.parse(state)
  } catch {
    // Shouldn't happen: we only ever write JSON-stringified values, and
    // the route cap prevents truncation. If it does, surface as null so
    // the viewer's graceful-degrade path kicks in client-side.
    return null
  }
}

/* ------------------------------------------------- GET /:wsid/layouts */

viewerLayoutsRoutes.get("/:wsid/layouts", async (c) => {
  const user = c.var.user
  requireCookieKind(user)
  const paramWsid = c.req.param("wsid")
  if (assertActiveWsid(user.workspaceId, paramWsid) !== "ok") {
    return c.json({ error: "forbidden" }, 403)
  }

  const db = createDb(c.env)
  const rows = await db
    .select({
      id: workspaceViewerLayouts.id,
      name: workspaceViewerLayouts.name,
      createdAt: workspaceViewerLayouts.createdAt,
      updatedAt: workspaceViewerLayouts.updatedAt,
      createdByUserId: workspaceViewerLayouts.createdByUserId,
    })
    .from(workspaceViewerLayouts)
    .where(eq(workspaceViewerLayouts.workspaceId, paramWsid))
    .orderBy(desc(workspaceViewerLayouts.updatedAt), asc(workspaceViewerLayouts.id))

  const response: ViewerLayoutsResponse = {
    layouts: rows.map(toSummary),
  }
  return c.json(response)
})

/* --------------------------------------------- GET /:wsid/layouts/:id */

viewerLayoutsRoutes.get("/:wsid/layouts/:id", async (c) => {
  const user = c.var.user
  requireCookieKind(user)
  const paramWsid = c.req.param("wsid")
  const layoutId = c.req.param("id")
  if (assertActiveWsid(user.workspaceId, paramWsid) !== "ok") {
    return c.json({ error: "forbidden" }, 403)
  }

  const db = createDb(c.env)
  const [row] = await db
    .select()
    .from(workspaceViewerLayouts)
    .where(
      and(
        eq(workspaceViewerLayouts.id, layoutId),
        eq(workspaceViewerLayouts.workspaceId, paramWsid),
      ),
    )
    .limit(1)
  if (!row) return c.json({ error: "not_found" }, 404)

  const dto: ViewerLayoutDto = {
    ...toSummary(row),
    state: tryParse(row.stateJson),
  }
  return c.json(dto)
})

/* ------------------------------------------------ POST /:wsid/layouts */

viewerLayoutsRoutes.post("/:wsid/layouts", async (c) => {
  const user = c.var.user
  requireCookieKind(user)
  const paramWsid = c.req.param("wsid")
  if (assertActiveWsid(user.workspaceId, paramWsid) !== "ok") {
    return c.json({ error: "forbidden" }, 403)
  }

  const body = (await c.req.json().catch(() => null)) as
    | SaveViewerLayoutRequest
    | null
  const name = typeof body?.name === "string" ? body.name.trim() : ""
  if (!name) return c.json({ error: "name_required" }, 400)
  if (!("state" in (body ?? {}))) {
    return c.json({ error: "state_required" }, 400)
  }

  const stateJson = JSON.stringify(body!.state)
  if (stateJson.length > MAX_STATE_JSON_BYTES) {
    return c.json({ error: "payload_too_large" }, 413)
  }

  const db = createDb(c.env)
  const now = new Date()
  try {
    const [row] = await db
      .insert(workspaceViewerLayouts)
      .values({
        workspaceId: paramWsid,
        name,
        stateJson,
        createdByUserId: user.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    const dto: ViewerLayoutDto = {
      ...toSummary(row!),
      state: body!.state,
    }
    return c.json(dto, 201)
  } catch (err) {
    if (isUniqueError(err)) {
      return c.json({ error: "name_in_use" }, 409)
    }
    throw err
  }
})

/* -------------------------------------------- PATCH /:wsid/layouts/:id */

viewerLayoutsRoutes.patch("/:wsid/layouts/:id", async (c) => {
  const user = c.var.user
  requireCookieKind(user)
  const paramWsid = c.req.param("wsid")
  const layoutId = c.req.param("id")
  if (assertActiveWsid(user.workspaceId, paramWsid) !== "ok") {
    return c.json({ error: "forbidden" }, 403)
  }

  const body = (await c.req.json().catch(() => null)) as
    | UpdateViewerLayoutRequest
    | null
  const patch: Record<string, unknown> = {}
  if (body && typeof body.name === "string") {
    const trimmed = body.name.trim()
    if (!trimmed) return c.json({ error: "name_required" }, 400)
    patch.name = trimmed
  }
  if (body && "state" in body) {
    const stateJson = JSON.stringify(body.state)
    if (stateJson.length > MAX_STATE_JSON_BYTES) {
      return c.json({ error: "payload_too_large" }, 413)
    }
    patch.stateJson = stateJson
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "no_fields" }, 400)
  }
  patch.updatedAt = new Date()

  const db = createDb(c.env)
  try {
    const [row] = await db
      .update(workspaceViewerLayouts)
      .set(patch)
      .where(
        and(
          eq(workspaceViewerLayouts.id, layoutId),
          eq(workspaceViewerLayouts.workspaceId, paramWsid),
        ),
      )
      .returning()
    if (!row) return c.json({ error: "not_found" }, 404)
    const dto: ViewerLayoutDto = {
      ...toSummary(row),
      state: tryParse(row.stateJson),
    }
    return c.json(dto)
  } catch (err) {
    if (isUniqueError(err)) {
      return c.json({ error: "name_in_use" }, 409)
    }
    throw err
  }
})

/* ------------------------------------------ DELETE /:wsid/layouts/:id */

viewerLayoutsRoutes.delete("/:wsid/layouts/:id", async (c) => {
  const user = c.var.user
  requireCookieKind(user)
  const paramWsid = c.req.param("wsid")
  const layoutId = c.req.param("id")
  if (assertActiveWsid(user.workspaceId, paramWsid) !== "ok") {
    return c.json({ error: "forbidden" }, 403)
  }

  const db = createDb(c.env)
  const result = await db
    .delete(workspaceViewerLayouts)
    .where(
      and(
        eq(workspaceViewerLayouts.id, layoutId),
        eq(workspaceViewerLayouts.workspaceId, paramWsid),
      ),
    )
    .returning({ id: workspaceViewerLayouts.id })
  if (result.length === 0) return c.json({ error: "not_found" }, 404)
  return c.body(null, 204)
})

/* ---------- helpers ------------------------------------------------- */

/** Drizzle wraps the SQLite error; look at the cause chain for the
 *  underlying UNIQUE-constraint message. */
function isUniqueError(err: unknown): boolean {
  const cause = (err as { cause?: { message?: string } } | undefined)?.cause
  const msg = cause?.message ?? (err as Error | undefined)?.message ?? ""
  return /UNIQUE|constraint/i.test(msg)
}
