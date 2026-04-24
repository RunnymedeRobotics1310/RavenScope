import type { Context, MiddlewareHandler } from "hono"
import { getCookie, setCookie as honoSetCookie } from "hono/cookie"
import type { Env } from "../env"
import {
  loadKeySet,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  serializeCookie,
  signSession,
  verifySession,
} from "./cookie"
// Imports the module augmentation that registers `user` in ContextVariableMap.
import "./user"

// Handler invariant: every route handler reads c.var.user.workspaceId —
// never re-parses the Cookie header. A cookie-fallback rewrite is reflected
// in c.var.user so the downstream handler operates on a consistent identity.

/** HTTP methods treated as safe for cookie fallback. Everything else refuses. */
const SAFE_METHODS = new Set(["GET", "HEAD"])

/**
 * Reads the session cookie, verifies signature + expiry, checks workspace
 * membership, and hydrates c.var.user. Returns 401 on any failure.
 *
 * Outcome A — membership found for (wsid, uid):
 *   Hydrate c.var.user with role; handle key-rotation re-sign; continue.
 *
 * Outcome B — no membership for wsid, user has at least one other:
 *   GET/HEAD: fall back to oldest membership (ORDER BY joined_at ASC,
 *     workspace_id ASC LIMIT 1). Re-sign cookie with new wsid preserving
 *     original exp. Log workspace.switched (reason=cookie_fallback). Continue.
 *   POST/PATCH/PUT/DELETE: 401 + clear cookie. No re-sign. No audit row.
 *
 * Outcome C — zero memberships: 401 + clear cookie.
 *
 * Both re-sign paths (key-rotation and fallback) preserve the original exp —
 * no TTL extension happens on re-sign.
 */
export const requireCookieUser: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const raw = getCookie(c, SESSION_COOKIE_NAME)
  if (!raw) return c.json({ error: "unauthenticated" }, 401)

  const keyset = await loadKeySet(c.env.SESSION_SECRET)
  const result = await verifySession(raw, keyset)
  if (!result.ok) {
    clearCookie(c)
    return c.json({ error: "unauthenticated" }, 401)
  }

  const { createDb } = await import("../db/client")
  const { users, workspaces, workspaceMembers } = await import("../db/schema")
  const { eq, and, asc } = await import("drizzle-orm")
  const { logAudit } = await import("../audit/log")

  const db = createDb(c.env)
  const { uid, wsid, exp } = result.payload

  // Load the user row.
  const [user] = await db.select().from(users).where(eq(users.id, uid)).limit(1)
  if (!user) {
    clearCookie(c)
    return c.json({ error: "unauthenticated" }, 401)
  }

  // Check membership for the cookie's current wsid.
  const [membership] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, wsid), eq(workspaceMembers.userId, uid)))
    .limit(1)

  if (membership) {
    // Outcome A: membership found.
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, wsid))
      .limit(1)
    if (!workspace) {
      clearCookie(c)
      return c.json({ error: "unauthenticated" }, 401)
    }

    c.set("user", {
      kind: "cookie",
      userId: user.id,
      workspaceId: workspace.id,
      email: user.email,
      workspaceName: workspace.name,
      role: membership.role as "owner" | "member",
    })

    // Key-rotation re-sign: preserve original exp, only the signing key changes.
    if (result.reSignNeeded) {
      const reSigned = await signSession({ uid: user.id, wsid: workspace.id, exp }, keyset)
      honoSetCookie(c, SESSION_COOKIE_NAME, reSigned, {
        maxAge: SESSION_TTL_SECONDS,
        path: "/",
        secure: isSecureRequest(c.req.url),
        httpOnly: true,
        sameSite: "Lax",
      })
    }

    await next()
    return
  }

  // No membership for (wsid, uid). Find fallback.
  const [fallback] = await db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, uid))
    .orderBy(asc(workspaceMembers.joinedAt), asc(workspaceMembers.workspaceId))
    .limit(1)

  if (!fallback) {
    // Outcome C: zero memberships.
    clearCookie(c)
    return c.json({ error: "unauthenticated" }, 401)
  }

  // Outcome B: user has other memberships.
  if (!SAFE_METHODS.has(c.req.method)) {
    // Mutating request with stale wsid: refuse and clear. No re-sign, no audit.
    clearCookie(c)
    return c.json({ error: "unauthenticated" }, 401)
  }

  // Safe-method fallback: re-sign with fallback wsid, preserving original exp.
  const newWsid = fallback.workspaceId
  const [newWorkspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, newWsid))
    .limit(1)
  if (!newWorkspace) {
    clearCookie(c)
    return c.json({ error: "unauthenticated" }, 401)
  }

  // Re-sign preserving original exp — never extend session TTL on fallback.
  const reSigned = await signSession({ uid: user.id, wsid: newWsid, exp }, keyset)
  honoSetCookie(c, SESSION_COOKIE_NAME, reSigned, {
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
    secure: isSecureRequest(c.req.url),
    httpOnly: true,
    sameSite: "Lax",
  })

  // Audit row: workspace_id = new wsid per forensics spec.
  await logAudit(db, {
    eventType: "workspace.switched",
    actorUserId: user.id,
    workspaceId: newWsid,
    metadata: {
      reason: "cookie_fallback",
      previous_wsid: wsid,
      new_wsid: newWsid,
    },
  })

  c.set("user", {
    kind: "cookie",
    userId: user.id,
    workspaceId: newWorkspace.id,
    email: user.email,
    workspaceName: newWorkspace.name,
    role: fallback.role as "owner" | "member",
  })

  await next()
}

function clearCookie(c: Context<{ Bindings: Env }>): void {
  c.header(
    "Set-Cookie",
    serializeCookie(SESSION_COOKIE_NAME, "", {
      maxAgeSeconds: 0,
      secure: isSecureRequest(c.req.url),
    }),
  )
}

function isSecureRequest(url: string): boolean {
  try {
    return new URL(url).protocol === "https:"
  } catch {
    return true
  }
}
