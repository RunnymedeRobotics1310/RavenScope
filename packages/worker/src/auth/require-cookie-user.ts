import type { MiddlewareHandler } from "hono"
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

export interface CookieUser {
  userId: string
  workspaceId: string
  email: string
  workspaceName: string
}

declare module "hono" {
  interface ContextVariableMap {
    user: CookieUser
  }
}

/**
 * Reads the session cookie, verifies the signature + expiry, and loads the
 * authenticated user/workspace into `c.var.user`. Responds with 401 on any
 * failure; rolls the cookie forward to the current kid when verification
 * succeeded under an older key.
 */
export const requireCookieUser: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const raw = getCookie(c, SESSION_COOKIE_NAME)
  if (!raw) return c.json({ error: "unauthenticated" }, 401)

  const keyset = await loadKeySet(c.env.SESSION_SECRET)
  const result = await verifySession(raw, keyset)
  if (!result.ok) {
    // On unknown kid or bad sig, clear the cookie to force a fresh sign-in.
    c.header(
      "Set-Cookie",
      serializeCookie(SESSION_COOKIE_NAME, "", {
        maxAgeSeconds: 0,
        secure: isSecureRequest(c.req.url),
      }),
    )
    return c.json({ error: "unauthenticated" }, 401)
  }

  // Hydrate user/workspace from the db for the request.
  const { createDb } = await import("../db/client")
  const { users, workspaces } = await import("../db/schema")
  const { eq } = await import("drizzle-orm")
  const db = createDb(c.env)
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, result.payload.uid))
    .limit(1)
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, result.payload.wsid))
    .limit(1)
  if (!user || !workspace) {
    return c.json({ error: "unauthenticated" }, 401)
  }

  c.set("user", {
    userId: user.id,
    workspaceId: workspace.id,
    email: user.email,
    workspaceName: workspace.name,
  })

  // Roll forward to the current signing key when needed.
  if (result.reSignNeeded) {
    const reSigned = await signSession(
      { uid: user.id, wsid: workspace.id, exp: result.payload.exp },
      keyset,
    )
    honoSetCookie(c, SESSION_COOKIE_NAME, reSigned, {
      maxAge: SESSION_TTL_SECONDS,
      path: "/",
      secure: isSecureRequest(c.req.url),
      httpOnly: true,
      sameSite: "Lax",
    })
  }

  await next()
}

function isSecureRequest(url: string): boolean {
  try {
    return new URL(url).protocol === "https:"
  } catch {
    return true
  }
}
