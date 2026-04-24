/**
 * Workspace invites — U4 of the workspace-members plan.
 *
 * Owner-only management endpoints under `/api/workspaces/:wsid/invites/*`:
 *   POST    /             send an invite
 *   GET     /             list pending invites
 *   DELETE  /:id          revoke
 *   POST    /:id/resend   re-send (new token, new expiry)
 *
 * Public accept endpoint under `/api/invites/accept` (separate app export):
 *   POST /accept          consume invite + sign session cookie
 *
 * Compensating-action pattern on email send: Workers + D1 cannot hold a
 * transaction across `fetch()`, so we INSERT first, then call Resend. If
 * Resend returns 4xx (non-retriable), we DELETE the row before returning
 * 500 — keeps the table free of stranded pending invites. If Resend 5xx's
 * after retries, we keep the row, stamp `email_send_failed=true` in the
 * audit metadata, and return 202 so the owner can `POST /resend` later.
 */

import { and, asc, desc, eq, isNull, gt } from "drizzle-orm"
import { Hono } from "hono"
import { getCookie } from "hono/cookie"
import { hashIp, logAudit } from "../audit/log"
import {
  loadKeySet,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  serializeCookie,
  signSession,
  verifySession,
} from "../auth/cookie"
import { sendInviteEmail } from "../auth/email"
import {
  generateInviteToken,
  hashInviteNonce,
} from "../auth/invite-token"
import { checkRateLimit } from "../auth/rate-limit"
import { requireCookieUser } from "../auth/require-cookie-user"
import { requireOwnerRole } from "../auth/require-owner-role"
import { requireCookieKind } from "../auth/user"
import { createDb } from "../db/client"
import {
  users,
  workspaceInvites,
  workspaceMembers,
  workspaces,
} from "../db/schema"
import type {
  CreateInviteResponse,
  InviteCreateRequest,
  InviteDto,
  PendingInvitesResponse,
} from "../dto"
import type { Env } from "../env"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/* --------------------------------------------------------- owner routes */

export const workspacesRoutes = new Hono<{ Bindings: Env }>()

// All /:wsid/invites routes require a cookie user AND the owner role on the
// workspace addressed by the cookie's wsid. The :wsid path param must match
// the user's active workspace; otherwise 403 (no cross-workspace operation).
workspacesRoutes.use("/:wsid/invites/*", requireCookieUser, requireOwnerRole)
workspacesRoutes.use("/:wsid/invites", requireCookieUser, requireOwnerRole)

function assertActiveWsid(
  userWsid: string,
  paramWsid: string,
): "ok" | "mismatch" {
  return userWsid === paramWsid ? "ok" : "mismatch"
}

workspacesRoutes.post("/:wsid/invites", async (c) => {
  const user = c.var.user
  requireCookieKind(user)
  const paramWsid = c.req.param("wsid")
  if (assertActiveWsid(user.workspaceId, paramWsid) !== "ok") {
    return c.json({ error: "forbidden" }, 403)
  }

  const body = await c.req.json<InviteCreateRequest>().catch(() => null)
  if (!body || typeof body.email !== "string" || !EMAIL_RE.test(body.email)) {
    return c.json({ error: "invalid_email" }, 400)
  }
  if (body.role !== undefined && body.role !== "member") {
    return c.json({ error: "invalid_role" }, 400)
  }
  const invitedEmail = body.email.trim().toLowerCase()

  // Rate limits: per-workspace 20/day, per-email 3/hour (global across
  // workspaces — caps harassment volume to any single address).
  const [wsLimit, emailLimit] = await Promise.all([
    checkRateLimit(c.env, {
      key: `invite_ws:${paramWsid}`,
      limit: 20,
      windowSeconds: 86_400,
    }),
    checkRateLimit(c.env, {
      key: `invite_email:${invitedEmail}`,
      limit: 3,
      windowSeconds: 3_600,
    }),
  ])
  if (!wsLimit.ok || !emailLimit.ok) {
    const retryAfter = Math.max(wsLimit.retryAfter, emailLimit.retryAfter)
    return c.text("rate_limited", 429, { "Retry-After": String(retryAfter) })
  }

  const db = createDb(c.env)

  // Already-member check: email resolves to a user who is already a member.
  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, invitedEmail))
    .limit(1)
  if (existingUser) {
    const [existingMembership] = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, paramWsid),
          eq(workspaceMembers.userId, existingUser.id),
        ),
      )
      .limit(1)
    if (existingMembership) {
      return c.json({ error: "already_member" }, 409)
    }
  }

  // Pending-invite check: a non-accepted, non-revoked invite already exists.
  const [pending] = await db
    .select()
    .from(workspaceInvites)
    .where(
      and(
        eq(workspaceInvites.workspaceId, paramWsid),
        eq(workspaceInvites.invitedEmail, invitedEmail),
        isNull(workspaceInvites.acceptedAt),
        isNull(workspaceInvites.revokedAt),
      ),
    )
    .limit(1)
  if (pending) {
    return c.json({ error: "invite_pending" }, 409)
  }

  // Generate token + insert invite row. Token nonce leaves only via email.
  const token = await generateInviteToken()
  const [row] = await db
    .insert(workspaceInvites)
    .values({
      workspaceId: paramWsid,
      invitedEmail,
      invitedByUserId: user.userId,
      role: "member",
      tokenHash: token.tokenHash,
      expiresAt: token.expiresAt,
    })
    .returning()

  const origin = new URL(c.req.url).origin
  const acceptLink = `${origin}/accept-invite?token=${token.nonce}`
  const sendResult = await sendInviteEmail(
    { apiKey: c.env.RESEND_API_KEY, from: c.env.EMAIL_FROM },
    invitedEmail,
    {
      workspaceName: user.workspaceName,
      inviterEmail: user.email,
      acceptLink,
    },
  )

  const ipHash = await hashIp(c.req.header("CF-Connecting-IP") ?? "unknown")

  if (!sendResult.ok) {
    // 4xx = non-retriable (bad API key, bad recipient). Compensate.
    const is4xx = sendResult.error?.startsWith("resend-4") ?? false
    if (is4xx) {
      await db.delete(workspaceInvites).where(eq(workspaceInvites.id, row!.id))
      return c.json({ error: "email_send_failed" }, 500)
    }
    // 5xx (or network) after retries — keep the row, audit the failure, 202.
    await logAudit(db, {
      eventType: "workspace.member_invited",
      actorUserId: user.userId,
      workspaceId: paramWsid,
      ipHash,
      metadata: {
        invited_email: invitedEmail,
        role: "member",
        email_send_failed: true,
        error: sendResult.error,
      },
    })
    const payload: CreateInviteResponse = {
      id: row!.id,
      invitedEmail: row!.invitedEmail,
      createdAt: row!.createdAt.getTime(),
      expiresAt: row!.expiresAt.getTime(),
    }
    return c.json(payload, 202)
  }

  await logAudit(db, {
    eventType: "workspace.member_invited",
    actorUserId: user.userId,
    workspaceId: paramWsid,
    ipHash,
    metadata: { invited_email: invitedEmail, role: "member" },
  })

  const payload: CreateInviteResponse = {
    id: row!.id,
    invitedEmail: row!.invitedEmail,
    createdAt: row!.createdAt.getTime(),
    expiresAt: row!.expiresAt.getTime(),
  }
  return c.json(payload, 201)
})

workspacesRoutes.get("/:wsid/invites", async (c) => {
  const user = c.var.user
  requireCookieKind(user)
  const paramWsid = c.req.param("wsid")
  if (assertActiveWsid(user.workspaceId, paramWsid) !== "ok") {
    return c.json({ error: "forbidden" }, 403)
  }

  const db = createDb(c.env)
  const now = new Date()
  const rows = await db
    .select()
    .from(workspaceInvites)
    .where(
      and(
        eq(workspaceInvites.workspaceId, paramWsid),
        isNull(workspaceInvites.acceptedAt),
        isNull(workspaceInvites.revokedAt),
        gt(workspaceInvites.expiresAt, now),
      ),
    )
    .orderBy(desc(workspaceInvites.createdAt))

  const invites: InviteDto[] = rows.map((r) => ({
    id: r.id,
    invitedEmail: r.invitedEmail,
    role: "member",
    createdAt: r.createdAt.getTime(),
    expiresAt: r.expiresAt.getTime(),
    invitedByUserId: r.invitedByUserId ?? null,
  }))
  const response: PendingInvitesResponse = { invites }
  return c.json(response)
})

workspacesRoutes.delete("/:wsid/invites/:id", async (c) => {
  const user = c.var.user
  requireCookieKind(user)
  const paramWsid = c.req.param("wsid")
  if (assertActiveWsid(user.workspaceId, paramWsid) !== "ok") {
    return c.json({ error: "forbidden" }, 403)
  }
  const id = c.req.param("id")

  const db = createDb(c.env)
  const [row] = await db
    .select()
    .from(workspaceInvites)
    .where(
      and(eq(workspaceInvites.id, id), eq(workspaceInvites.workspaceId, paramWsid)),
    )
    .limit(1)
  if (!row) return c.json({ error: "not_found" }, 404)
  if (row.acceptedAt) return c.json({ error: "already_accepted" }, 409)
  if (row.revokedAt) return c.body(null, 204) // idempotent

  await db
    .update(workspaceInvites)
    .set({ revokedAt: new Date() })
    .where(eq(workspaceInvites.id, id))

  const ipHash = await hashIp(c.req.header("CF-Connecting-IP") ?? "unknown")
  await logAudit(db, {
    eventType: "workspace.invite_revoked",
    actorUserId: user.userId,
    workspaceId: paramWsid,
    ipHash,
    metadata: { invite_id: id, invited_email: row.invitedEmail },
  })
  return c.body(null, 204)
})

workspacesRoutes.post("/:wsid/invites/:id/resend", async (c) => {
  const user = c.var.user
  requireCookieKind(user)
  const paramWsid = c.req.param("wsid")
  if (assertActiveWsid(user.workspaceId, paramWsid) !== "ok") {
    return c.json({ error: "forbidden" }, 403)
  }
  const id = c.req.param("id")

  const db = createDb(c.env)
  const [row] = await db
    .select()
    .from(workspaceInvites)
    .where(
      and(eq(workspaceInvites.id, id), eq(workspaceInvites.workspaceId, paramWsid)),
    )
    .limit(1)
  if (!row) return c.json({ error: "not_found" }, 404)
  if (row.acceptedAt) return c.json({ error: "already_accepted" }, 409)
  if (row.revokedAt) return c.json({ error: "already_revoked" }, 409)

  // Rate-limit — shared buckets with initial send.
  const [wsLimit, emailLimit] = await Promise.all([
    checkRateLimit(c.env, {
      key: `invite_ws:${paramWsid}`,
      limit: 20,
      windowSeconds: 86_400,
    }),
    checkRateLimit(c.env, {
      key: `invite_email:${row.invitedEmail}`,
      limit: 3,
      windowSeconds: 3_600,
    }),
  ])
  if (!wsLimit.ok || !emailLimit.ok) {
    const retryAfter = Math.max(wsLimit.retryAfter, emailLimit.retryAfter)
    return c.text("rate_limited", 429, { "Retry-After": String(retryAfter) })
  }

  // Generate new token + update row. Save old values so we can revert on
  // 4xx email failure (compensating update).
  const priorTokenHash = row.tokenHash
  const priorExpiresAt = row.expiresAt
  const token = await generateInviteToken()
  await db
    .update(workspaceInvites)
    .set({ tokenHash: token.tokenHash, expiresAt: token.expiresAt })
    .where(eq(workspaceInvites.id, id))

  const origin = new URL(c.req.url).origin
  const acceptLink = `${origin}/accept-invite?token=${token.nonce}`
  const sendResult = await sendInviteEmail(
    { apiKey: c.env.RESEND_API_KEY, from: c.env.EMAIL_FROM },
    row.invitedEmail,
    {
      workspaceName: user.workspaceName,
      inviterEmail: user.email,
      acceptLink,
    },
  )

  const ipHash = await hashIp(c.req.header("CF-Connecting-IP") ?? "unknown")

  if (!sendResult.ok) {
    const is4xx = sendResult.error?.startsWith("resend-4") ?? false
    if (is4xx) {
      // Revert to the prior token/expiry so the original link (if still valid)
      // continues to work.
      await db
        .update(workspaceInvites)
        .set({ tokenHash: priorTokenHash, expiresAt: priorExpiresAt })
        .where(eq(workspaceInvites.id, id))
      return c.json({ error: "email_send_failed" }, 500)
    }
    // 5xx — keep the new token, audit, return 202.
    await logAudit(db, {
      eventType: "workspace.member_invited",
      actorUserId: user.userId,
      workspaceId: paramWsid,
      ipHash,
      metadata: {
        invited_email: row.invitedEmail,
        role: "member",
        resend: true,
        email_send_failed: true,
        error: sendResult.error,
      },
    })
    return c.body(null, 202)
  }

  await logAudit(db, {
    eventType: "workspace.member_invited",
    actorUserId: user.userId,
    workspaceId: paramWsid,
    ipHash,
    metadata: {
      invited_email: row.invitedEmail,
      role: "member",
      resend: true,
    },
  })
  return c.body(null, 204)
})

/* --------------------------------------------------------- public accept */

export const inviteAcceptRoutes = new Hono<{ Bindings: Env }>()

interface AcceptRequest {
  token: string
}

/**
 * Public invite acceptance. Tolerates a signed cookie (for
 * signed-in-while-clicking flows) but does not require one.
 *
 * Reasoning for the ordering of checks:
 *   1. parse + hash nonce (400 on malformed)
 *   2. lookup by hash (410 on unknown / expired / revoked / accepted)
 *   3. resolve invited_email → user id (ALWAYS run this query — constant
 *      work, see magic-link.ts's enumeration-guard discipline)
 *   4. if cookie present AND user email differs from invited_email → 409
 *      (email_mismatch); do NOT touch invite or cookie
 *   5. if already a member → mark invite accepted_at (single-use), 409
 *   6. happy path: db.batch() creates/uses user + adds membership + marks
 *      invite accepted. Sign a session cookie for the invited workspace.
 */
inviteAcceptRoutes.post("/accept", async (c) => {
  const body = await c.req.json<AcceptRequest>().catch(() => null)
  const nonce =
    body && typeof body.token === "string" ? body.token : ""
  if (!nonce || nonce.length < 16) {
    return c.json({ error: "token_malformed" }, 400, { "Cache-Control": "no-store" })
  }

  const db = createDb(c.env)
  const tokenHash = await hashInviteNonce(nonce)
  const [invite] = await db
    .select()
    .from(workspaceInvites)
    .where(eq(workspaceInvites.tokenHash, tokenHash))
    .limit(1)

  const now = new Date()
  if (!invite) {
    return respondAcceptError(c, "token_unknown", 410)
  }
  if (invite.revokedAt) return respondAcceptError(c, "token_revoked", 410)
  if (invite.acceptedAt) return respondAcceptError(c, "token_accepted", 410)
  if (invite.expiresAt.getTime() < now.getTime()) {
    return respondAcceptError(c, "token_expired", 410)
  }

  // Constant-work: ALWAYS run the user-lookup query here, before branching on
  // existing-vs-new-user. Matches the enumeration-guard discipline in
  // magic-link.ts. Both branches execute this single SELECT.
  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, invite.invitedEmail))
    .limit(1)

  // Email-mismatch check against the cookie, if any verifies.
  const raw = getCookie(c, SESSION_COOKIE_NAME)
  if (raw) {
    const keyset = await loadKeySet(c.env.SESSION_SECRET)
    const verifyResult = await verifySession(raw, keyset)
    if (verifyResult.ok) {
      // Resolve the signed-in user's email.
      const [signedInUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, verifyResult.payload.uid))
        .limit(1)
      if (signedInUser && signedInUser.email !== invite.invitedEmail) {
        return c.json(
          { error: "email_mismatch" },
          409,
          {
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-store",
          },
        )
      }
    }
  }

  // Already-member check (by the invited email's user id, if that user
  // exists). If so, mark invite accepted to prevent reuse and return 409.
  if (existingUser) {
    const [membership] = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, invite.workspaceId),
          eq(workspaceMembers.userId, existingUser.id),
        ),
      )
      .limit(1)
    if (membership) {
      await db
        .update(workspaceInvites)
        .set({ acceptedAt: now })
        .where(eq(workspaceInvites.id, invite.id))
      return c.json(
        { error: "already_member" },
        409,
        {
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "no-store",
        },
      )
    }
  }

  // Happy path — batch so a crash mid-insert leaves no partial rows.
  let resolvedUserId: string
  if (existingUser) {
    resolvedUserId = existingUser.id
    await db.batch([
      db.insert(workspaceMembers).values({
        workspaceId: invite.workspaceId,
        userId: existingUser.id,
        role: "member",
        invitedByUserId: invite.invitedByUserId ?? null,
      }),
      db
        .update(workspaceInvites)
        .set({ acceptedAt: now })
        .where(eq(workspaceInvites.id, invite.id)),
    ])
  } else {
    resolvedUserId = crypto.randomUUID()
    await db.batch([
      db.insert(users).values({ id: resolvedUserId, email: invite.invitedEmail }),
      db.insert(workspaceMembers).values({
        workspaceId: invite.workspaceId,
        userId: resolvedUserId,
        role: "member",
        invitedByUserId: invite.invitedByUserId ?? null,
      }),
      db
        .update(workspaceInvites)
        .set({ acceptedAt: now })
        .where(eq(workspaceInvites.id, invite.id)),
    ])
  }

  // Fresh session cookie — full TTL is fine for a fresh acceptance (the
  // plan allows this even when an existing user was signed in).
  const keyset = await loadKeySet(c.env.SESSION_SECRET)
  const exp = Date.now() + SESSION_TTL_SECONDS * 1000
  const signed = await signSession(
    { uid: resolvedUserId, wsid: invite.workspaceId, exp },
    keyset,
  )

  const ipHash = await hashIp(c.req.header("CF-Connecting-IP") ?? "unknown")
  await logAudit(db, {
    eventType: "workspace.invite_accepted",
    actorUserId: resolvedUserId,
    workspaceId: invite.workspaceId,
    ipHash,
    metadata: { invited_email: invite.invitedEmail },
  })

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": serializeCookie(SESSION_COOKIE_NAME, signed, {
        maxAgeSeconds: SESSION_TTL_SECONDS,
        secure: new URL(c.req.url).protocol === "https:",
      }),
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  })
})

function respondAcceptError(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  reason: string,
  status: 400 | 410,
): Response {
  return c.json(
    { error: reason },
    status,
    {
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  )
}

// Silence unused-import warnings for drizzle helpers referenced via dynamic
// schema expressions.
void workspaces
