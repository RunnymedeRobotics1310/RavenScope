import { asc, eq, and } from "drizzle-orm"
import { Hono } from "hono"
import { getCookie, setCookie as honoSetCookie } from "hono/cookie"
import type { Env } from "../env"
import { hashIp, logAudit } from "../audit/log"
import {
  loadKeySet,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  serializeCookie,
  signSession,
  verifySession,
} from "../auth/cookie"
import { sendMagicLink } from "../auth/email"
import { generateToken, recordTokenRequest, verifyToken } from "../auth/magic-link"
import { checkRateLimit } from "../auth/rate-limit"
import { requireCookieUser } from "../auth/require-cookie-user"
import { requireCookieKind } from "../auth/user"
import { createDb } from "../db/client"
import { workspaceMembers, workspaces } from "../db/schema"
import type {
  RequestLinkRequest,
  SwitchWorkspaceRequest,
  UserMeResponse,
  WorkspaceInfo,
} from "../dto"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const authRoutes = new Hono<{ Bindings: Env }>()

authRoutes.post("/request-link", async (c) => {
  const body = await c.req.json<RequestLinkRequest>().catch(() => null)
  if (!body || typeof body.email !== "string" || !EMAIL_RE.test(body.email)) {
    return c.json({ error: "invalid_email" }, 400)
  }
  const email = body.email.trim().toLowerCase()
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown"
  const ipHashPromise = hashIp(ip)

  // Rate limits: per-IP 5/min, per-email 3/10min.
  const [ipLimit, emailLimit] = await Promise.all([
    checkRateLimit(c.env, { key: `ip:${ip}`, limit: 5, windowSeconds: 60 }),
    checkRateLimit(c.env, { key: `email:${email}`, limit: 3, windowSeconds: 600 }),
  ])
  if (!ipLimit.ok || !emailLimit.ok) {
    const retryAfter = Math.max(ipLimit.retryAfter, emailLimit.retryAfter)
    return c.text("rate_limited", 429, { "Retry-After": String(retryAfter) })
  }

  const db = createDb(c.env)
  const token = await generateToken()
  await recordTokenRequest(db, email, token)

  const origin = new URL(c.req.url).origin
  const link = `${origin}/api/auth/verify?t=${token.nonce}`
  const sendResult = await sendMagicLink(
    { apiKey: c.env.RESEND_API_KEY, from: c.env.EMAIL_FROM },
    email,
    link,
  )

  const ipHash = await ipHashPromise
  await logAudit(db, {
    eventType: "magic_link_requested",
    ipHash,
    metadata: sendResult.ok ? undefined : { email_send_failed: true, error: sendResult.error },
  })

  // Always 204 regardless of send success — prevents email enumeration.
  return c.body(null, 204)
})

authRoutes.get("/verify", async (c) => {
  const nonce = c.req.query("t")
  if (!nonce) return c.text("missing_token", 410)

  const db = createDb(c.env)
  const outcome = await verifyToken(db, nonce)
  if (!outcome.ok) {
    return c.text(`token_${outcome.reason}`, 410)
  }

  const keyset = await loadKeySet(c.env.SESSION_SECRET)
  const exp = Date.now() + SESSION_TTL_SECONDS * 1000
  const signed = await signSession(
    { uid: outcome.userId, wsid: outcome.workspaceId, exp },
    keyset,
  )
  const ipHash = await hashIp(c.req.header("CF-Connecting-IP") ?? "unknown")
  await logAudit(db, {
    eventType: "magic_link_verified",
    actorUserId: outcome.userId,
    workspaceId: outcome.workspaceId,
    ipHash,
    metadata: outcome.firstSignIn ? { first_sign_in: true } : undefined,
  })

  const url = new URL(c.req.url)
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": serializeCookie(SESSION_COOKIE_NAME, signed, {
        maxAgeSeconds: SESSION_TTL_SECONDS,
        secure: url.protocol === "https:",
      }),
    },
  })
})

authRoutes.post("/logout", requireCookieUser, async (c) => {
  const user = c.var.user
  requireCookieKind(user)
  const db = createDb(c.env)
  const ipHash = await hashIp(c.req.header("CF-Connecting-IP") ?? "unknown")
  await logAudit(db, {
    eventType: "logout",
    actorUserId: user.userId,
    workspaceId: user.workspaceId,
    ipHash,
  })
  honoSetCookie(c, SESSION_COOKIE_NAME, "", {
    maxAge: 0,
    path: "/",
    secure: new URL(c.req.url).protocol === "https:",
    httpOnly: true,
    sameSite: "Lax",
  })
  return c.body(null, 204)
})

authRoutes.get("/me", requireCookieUser, async (c) => {
  const user = c.var.user
  requireCookieKind(user)

  const db = createDb(c.env)
  const memberships = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, user.userId))
    .orderBy(asc(workspaceMembers.joinedAt), asc(workspaceMembers.workspaceId))

  const workspaceList: WorkspaceInfo[] = memberships.map((m) => ({
    id: m.id,
    name: m.name,
    role: m.role as "owner" | "member",
  }))

  const activeWorkspace: WorkspaceInfo = {
    id: user.workspaceId,
    name: user.workspaceName,
    role: user.role,
  }

  const payload: UserMeResponse = {
    userId: user.userId,
    email: user.email,
    workspaceId: user.workspaceId,
    workspaceName: user.workspaceName,
    activeWorkspace,
    workspaces: workspaceList,
  }
  return c.json(payload)
})

authRoutes.post("/switch-workspace", requireCookieUser, async (c) => {
  const user = c.var.user
  requireCookieKind(user)

  const body = await c.req.json<SwitchWorkspaceRequest>().catch(() => null)
  if (!body || typeof body.workspaceId !== "string" || body.workspaceId.trim() === "") {
    return c.json({ error: "invalid_request" }, 400)
  }
  const targetWsid = body.workspaceId.trim()

  const db = createDb(c.env)

  // Workspace must exist.
  const [targetWorkspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, targetWsid))
    .limit(1)
  if (!targetWorkspace) {
    return c.json({ error: "unknown_workspace" }, 404)
  }

  // User must be a member of the target workspace.
  const [membership] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, targetWsid),
        eq(workspaceMembers.userId, user.userId),
      ),
    )
    .limit(1)
  if (!membership) {
    return c.json({ error: "not_a_member" }, 403)
  }

  // Re-read the cookie to extract the original exp for preservation.
  // (The handler-invariant "never re-parse the Cookie header" is about using
  // `workspaceId` from c.var.user; this route needs `exp` which isn't on it.)
  const raw = getCookie(c, SESSION_COOKIE_NAME)!
  const keyset = await loadKeySet(c.env.SESSION_SECRET)
  const verifyResult = await verifySession(raw, keyset)
  const exp = verifyResult.ok
    ? verifyResult.payload.exp
    : Date.now() + SESSION_TTL_SECONDS * 1000

  const reSigned = await signSession(
    { uid: user.userId, wsid: targetWsid, exp },
    keyset,
  )
  honoSetCookie(c, SESSION_COOKIE_NAME, reSigned, {
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
    secure: new URL(c.req.url).protocol === "https:",
    httpOnly: true,
    sameSite: "Lax",
  })

  const ipHash = await hashIp(c.req.header("CF-Connecting-IP") ?? "unknown")
  await logAudit(db, {
    eventType: "workspace.switched",
    actorUserId: user.userId,
    workspaceId: targetWsid,
    ipHash,
    metadata: {
      reason: "explicit",
      previous_wsid: user.workspaceId,
      new_wsid: targetWsid,
    },
  })

  return c.body(null, 204)
})
