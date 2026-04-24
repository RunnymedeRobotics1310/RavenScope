/**
 * Session ownership lookup for cookie-authenticated routes.
 *
 * Every session-scoped route under /api/sessions/:id and /v/:id must
 * enforce the same workspace-scoped ownership check: the authenticated
 * user's workspace must own the session, or the route returns 404
 * not_found. The check is workspace-scoped, not user-scoped --
 * telemetry_sessions carries no userId column, and workspaces are the
 * membership boundary.
 *
 * This helper is the single source of truth for that policy. Callers
 * pattern-match on a null return and respond with 404 themselves so
 * route-level framing stays in the route file.
 */
import type { Context } from "hono"
import { and, eq } from "drizzle-orm"
import { requireCookieKind } from "./user"
import { createDb } from "../db/client"
import { telemetrySessions } from "../db/schema"
import type { Env } from "../env"

export type OwnedSession = typeof telemetrySessions.$inferSelect

/**
 * Load a telemetry session the current cookie-authenticated user owns.
 * Returns null when the session does not exist or belongs to a different
 * workspace. Does not throw on missing rows -- callers should render 404
 * themselves to keep error shape consistent across routes.
 */
export async function loadOwnedSession(
  c: Context<{ Bindings: Env }>,
  id: string,
): Promise<OwnedSession | null> {
  const user = c.var.user
  requireCookieKind(user)

  const db = createDb(c.env)
  const [row] = await db
    .select()
    .from(telemetrySessions)
    .where(
      and(
        eq(telemetrySessions.id, id),
        eq(telemetrySessions.workspaceId, user.workspaceId),
      ),
    )
    .limit(1)
  return row ?? null
}
