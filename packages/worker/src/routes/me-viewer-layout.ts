/**
 * Per-user viewer bootstrap + preferences — shared-viewer-layouts plan U2.
 *
 * Mounted at /api/me. All endpoints are scoped to the caller's identity
 * (userId + active workspaceId) — no path params for the user or
 * workspace, because both come from c.var.user.
 *
 * Routes:
 *   GET /viewer-layout               bootstrap payload the patched AS
 *                                    outer shell fetches on boot. Picks
 *                                    the user's default layout if set,
 *                                    else the captured last-used state,
 *                                    else returns {state: null, source:
 *                                    "none"}.
 *   PUT /viewer-layout/last-used     {state} -> upsert preferences row's
 *                                    last_used_state_json. Debounced by
 *                                    the client (~2s); the server
 *                                    trusts whatever arrives.
 *   GET /viewer-preferences          {defaultLayoutId}
 *   PUT /viewer-preferences          {defaultLayoutId: string | null}
 *                                    Validates that a non-null target
 *                                    lives in the caller's workspace
 *                                    before upserting.
 */
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { requireCookieUser } from "../auth/require-cookie-user"
import { requireCookieKind } from "../auth/user"
import { createDb } from "../db/client"
import { userViewerPreferences, workspaceViewerLayouts } from "../db/schema"
import type {
  SaveViewerLastUsedRequest,
  UpdateViewerPreferencesRequest,
  ViewerLayoutBootstrap,
  ViewerPreferencesResponse,
} from "../dto"
import type { Env } from "../env"
import { MAX_STATE_JSON_BYTES } from "./viewer-layouts"

export const meViewerLayoutRoutes = new Hono<{ Bindings: Env }>()
meViewerLayoutRoutes.use("*", requireCookieUser)

function tryParse(state: string): unknown {
  try {
    return JSON.parse(state)
  } catch {
    return null
  }
}

/* ---------------------------------------------- GET /viewer-layout */

meViewerLayoutRoutes.get("/viewer-layout", async (c) => {
  const user = c.var.user
  requireCookieKind(user)

  const db = createDb(c.env)
  const [prefs] = await db
    .select()
    .from(userViewerPreferences)
    .where(
      and(
        eq(userViewerPreferences.userId, user.userId),
        eq(userViewerPreferences.workspaceId, user.workspaceId),
      ),
    )
    .limit(1)

  // Default first — resolve the joined layout if the FK is set.
  if (prefs?.defaultLayoutId) {
    const [layout] = await db
      .select({
        id: workspaceViewerLayouts.id,
        stateJson: workspaceViewerLayouts.stateJson,
        workspaceId: workspaceViewerLayouts.workspaceId,
      })
      .from(workspaceViewerLayouts)
      .where(eq(workspaceViewerLayouts.id, prefs.defaultLayoutId))
      .limit(1)
    // Guard: the layout's workspace must match the user's active
    // workspace. Deleting the layout sets default_layout_id null via
    // FK, so a mismatch here would only surface if the row moved
    // workspaces — not a path we support, but cheap to defend.
    if (layout && layout.workspaceId === user.workspaceId) {
      const body: ViewerLayoutBootstrap = {
        state: tryParse(layout.stateJson),
        source: "default",
        defaultLayoutId: layout.id,
      }
      return c.json(body)
    }
  }

  if (prefs?.lastUsedStateJson) {
    const body: ViewerLayoutBootstrap = {
      state: tryParse(prefs.lastUsedStateJson),
      source: "last-used",
    }
    return c.json(body)
  }

  const body: ViewerLayoutBootstrap = { state: null, source: "none" }
  return c.json(body)
})

/* ------------------------------------ PUT /viewer-layout/last-used */

meViewerLayoutRoutes.put("/viewer-layout/last-used", async (c) => {
  const user = c.var.user
  requireCookieKind(user)

  const body = (await c.req.json().catch(() => null)) as
    | SaveViewerLastUsedRequest
    | null
  if (!body || !("state" in body)) {
    return c.json({ error: "state_required" }, 400)
  }
  const stateJson = JSON.stringify(body.state)
  if (stateJson.length > MAX_STATE_JSON_BYTES) {
    return c.json({ error: "payload_too_large" }, 413)
  }

  const db = createDb(c.env)
  const now = new Date()
  // UPSERT on composite PK. D1 supports sqlite's ON CONFLICT DO UPDATE.
  await db
    .insert(userViewerPreferences)
    .values({
      userId: user.userId,
      workspaceId: user.workspaceId,
      lastUsedStateJson: stateJson,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userViewerPreferences.userId, userViewerPreferences.workspaceId],
      set: { lastUsedStateJson: stateJson, updatedAt: now },
    })
  return c.body(null, 204)
})

/* ---------------------------------------- GET /viewer-preferences */

meViewerLayoutRoutes.get("/viewer-preferences", async (c) => {
  const user = c.var.user
  requireCookieKind(user)

  const db = createDb(c.env)
  const [prefs] = await db
    .select({
      defaultLayoutId: userViewerPreferences.defaultLayoutId,
    })
    .from(userViewerPreferences)
    .where(
      and(
        eq(userViewerPreferences.userId, user.userId),
        eq(userViewerPreferences.workspaceId, user.workspaceId),
      ),
    )
    .limit(1)

  const response: ViewerPreferencesResponse = {
    defaultLayoutId: prefs?.defaultLayoutId ?? null,
  }
  return c.json(response)
})

/* ---------------------------------------- PUT /viewer-preferences */

meViewerLayoutRoutes.put("/viewer-preferences", async (c) => {
  const user = c.var.user
  requireCookieKind(user)

  const body = (await c.req.json().catch(() => null)) as
    | UpdateViewerPreferencesRequest
    | null
  if (!body || !("defaultLayoutId" in body)) {
    return c.json({ error: "default_layout_id_required" }, 400)
  }
  const target = body.defaultLayoutId
  if (target !== null && typeof target !== "string") {
    return c.json({ error: "default_layout_id_required" }, 400)
  }

  const db = createDb(c.env)
  // Validate the target layout belongs to the caller's workspace before
  // setting it. Cross-workspace ids surface as 404 to match the other
  // cross-tenancy 404 shapes.
  if (target !== null) {
    const [layout] = await db
      .select({ id: workspaceViewerLayouts.id })
      .from(workspaceViewerLayouts)
      .where(
        and(
          eq(workspaceViewerLayouts.id, target),
          eq(workspaceViewerLayouts.workspaceId, user.workspaceId),
        ),
      )
      .limit(1)
    if (!layout) return c.json({ error: "not_found" }, 404)
  }

  const now = new Date()
  await db
    .insert(userViewerPreferences)
    .values({
      userId: user.userId,
      workspaceId: user.workspaceId,
      defaultLayoutId: target,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userViewerPreferences.userId, userViewerPreferences.workspaceId],
      set: { defaultLayoutId: target, updatedAt: now },
    })

  const response: ViewerPreferencesResponse = { defaultLayoutId: target }
  return c.json(response)
})
