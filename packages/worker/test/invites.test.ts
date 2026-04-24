import { env, fetchMock, SELF } from "cloudflare:test"
import { and, eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  loadKeySet,
  SESSION_COOKIE_NAME,
  signSession,
  verifySession,
} from "../src/auth/cookie"
import {
  generateInviteToken,
  hashInviteNonce,
} from "../src/auth/invite-token"
import { createDb } from "../src/db/client"
import {
  auditLog,
  loginTokens,
  users,
  workspaceInvites,
  workspaceMembers,
  workspaces,
} from "../src/db/schema"
import type {
  CreateInviteResponse,
  PendingInvitesResponse,
  UserMeResponse,
} from "../src/dto"

const BASE = "https://ravenscope.test"

/* --------------------------------------------------------------- helpers */

async function wipeDb() {
  const db = createDb(env)
  await db.delete(auditLog)
  await db.delete(loginTokens)
  await db.delete(workspaceInvites)
  await db.delete(workspaceMembers)
  await db.delete(workspaces)
  await db.delete(users)
}

async function mintCookie(uid: string, wsid: string, expMs: number): Promise<string> {
  const keyset = await loadKeySet(env.SESSION_SECRET)
  const token = await signSession({ uid, wsid, exp: expMs }, keyset)
  return `${SESSION_COOKIE_NAME}=${token}`
}

function mockResendOK() {
  fetchMock
    .get("https://api.resend.com")
    .intercept({ path: "/emails", method: "POST" })
    .reply(200, { id: "fake-resend-id" })
}

function mockResend401() {
  fetchMock
    .get("https://api.resend.com")
    .intercept({ path: "/emails", method: "POST" })
    .reply(401, "unauthorized")
}

function mockResend503x3() {
  fetchMock
    .get("https://api.resend.com")
    .intercept({ path: "/emails", method: "POST" })
    .reply(503, "service unavailable")
    .times(3)
}

/**
 * Seed an owner + workspace + owner membership and return a signed cookie
 * for the owner's session (wsid = their workspace, exp = 1 hour out).
 */
async function seedOwner(email: string, wsName: string) {
  const db = createDb(env)
  const [user] = await db.insert(users).values({ email }).returning()
  const [ws] = await db.insert(workspaces).values({ name: wsName }).returning()
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: ws!.id, userId: user!.id, role: "owner" })
  const cookie = await mintCookie(user!.id, ws!.id, Date.now() + 3_600_000)
  return { userId: user!.id, workspaceId: ws!.id, workspaceName: ws!.name, cookie }
}

/* --------------------------------------------------------------- lifecycle */

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})

beforeEach(async () => {
  await wipeDb()
})

afterEach(() => {
  fetchMock.assertNoPendingInterceptors()
})

afterAll(() => {
  fetchMock.deactivate()
})

/* ================================================================ tests */

describe("POST /api/workspaces/:wsid/invites", () => {
  it("happy path: owner invites → 201, row inserted, Resend called, audit logged", async () => {
    const owner = await seedOwner("owner1@test.local", "ws-inv-1")
    mockResendOK()

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/invites`,
      {
        method: "POST",
        headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "invitee@test.local" }),
      },
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as CreateInviteResponse
    expect(body.invitedEmail).toBe("invitee@test.local")

    const db = createDb(env)
    const rows = await db
      .select()
      .from(workspaceInvites)
      .where(eq(workspaceInvites.workspaceId, owner.workspaceId))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.invitedEmail).toBe("invitee@test.local")
    expect(rows[0]!.role).toBe("member")
    expect(rows[0]!.acceptedAt).toBeNull()
    expect(rows[0]!.revokedAt).toBeNull()

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "workspace.member_invited"))
    expect(audits).toHaveLength(1)
    expect(audits[0]!.workspaceId).toBe(owner.workspaceId)
    expect(audits[0]!.actorUserId).toBe(owner.userId)
    const meta = JSON.parse(audits[0]!.metadataJson!) as Record<string, string>
    expect(meta.invited_email).toBe("invitee@test.local")
    expect(meta.role).toBe("member")
  })

  it("409 already_member when email is already a workspace member", async () => {
    const owner = await seedOwner("owner2@test.local", "ws-inv-2")
    const db = createDb(env)
    const [existing] = await db
      .insert(users)
      .values({ email: "already@test.local" })
      .returning()
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: owner.workspaceId, userId: existing!.id, role: "member" })

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/invites`,
      {
        method: "POST",
        headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "already@test.local" }),
      },
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("already_member")
  })

  it("409 invite_pending when an open invite already exists for same email", async () => {
    const owner = await seedOwner("owner3@test.local", "ws-inv-3")
    const db = createDb(env)
    const token = await generateInviteToken()
    await db.insert(workspaceInvites).values({
      workspaceId: owner.workspaceId,
      invitedEmail: "pending@test.local",
      invitedByUserId: owner.userId,
      role: "member",
      tokenHash: token.tokenHash,
      expiresAt: token.expiresAt,
    })

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/invites`,
      {
        method: "POST",
        headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "pending@test.local" }),
      },
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("invite_pending")
  })

  it("400 on malformed email", async () => {
    const owner = await seedOwner("owner4@test.local", "ws-inv-4")
    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/invites`,
      {
        method: "POST",
        headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "not-an-email" }),
      },
    )
    expect(res.status).toBe(400)
  })

  it("403 when a non-owner member attempts to invite", async () => {
    const owner = await seedOwner("owner5@test.local", "ws-inv-5")
    const db = createDb(env)
    const [member] = await db.insert(users).values({ email: "m5@test.local" }).returning()
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: owner.workspaceId, userId: member!.id, role: "member" })
    const memberCookie = await mintCookie(
      member!.id,
      owner.workspaceId,
      Date.now() + 3_600_000,
    )

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/invites`,
      {
        method: "POST",
        headers: { Cookie: memberCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nope@test.local" }),
      },
    )
    expect(res.status).toBe(403)
  })

  it("21st invite from same workspace in 24h → 429", async () => {
    const owner = await seedOwner("owner6@test.local", "ws-inv-6")
    for (let i = 0; i < 20; i++) mockResendOK()
    for (let i = 0; i < 20; i++) {
      const r = await SELF.fetch(
        `${BASE}/api/workspaces/${owner.workspaceId}/invites`,
        {
          method: "POST",
          headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ email: `recip${i}@test.local` }),
        },
      )
      expect(r.status).toBe(201)
    }
    const denied = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/invites`,
      {
        method: "POST",
        headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "overflow@test.local" }),
      },
    )
    expect(denied.status).toBe(429)
    expect(denied.headers.get("Retry-After")).toBeTruthy()
  })

  it("Resend 4xx: compensating DELETE removes row; returns 500", async () => {
    const owner = await seedOwner("owner7@test.local", "ws-inv-7")
    mockResend401()

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/invites`,
      {
        method: "POST",
        headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "badkey@test.local" }),
      },
    )
    expect(res.status).toBe(500)

    const db = createDb(env)
    const rows = await db
      .select()
      .from(workspaceInvites)
      .where(eq(workspaceInvites.workspaceId, owner.workspaceId))
    expect(rows).toHaveLength(0)
  })

  it("Resend 5xx after retries: row persists, audit marks email_send_failed, 202", async () => {
    const owner = await seedOwner("owner8@test.local", "ws-inv-8")
    mockResend503x3()

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/invites`,
      {
        method: "POST",
        headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "flaky@test.local" }),
      },
    )
    expect(res.status).toBe(202)

    const db = createDb(env)
    const rows = await db
      .select()
      .from(workspaceInvites)
      .where(eq(workspaceInvites.workspaceId, owner.workspaceId))
    expect(rows).toHaveLength(1)

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "workspace.member_invited"))
    expect(audits).toHaveLength(1)
    const meta = JSON.parse(audits[0]!.metadataJson!) as Record<string, unknown>
    expect(meta.email_send_failed).toBe(true)
  })
})

describe("GET /api/workspaces/:wsid/invites", () => {
  it("returns only pending invites (not accepted, revoked, or expired); newest first", async () => {
    const owner = await seedOwner("owner9@test.local", "ws-list-1")
    const db = createDb(env)

    // Make three invites at distinct createdAt timestamps so ordering is
    // deterministic. (The default $defaultFn uses `new Date()` at insert
    // time, and D1 in vitest can collide within a millisecond.)
    const t1 = await generateInviteToken()
    await db.insert(workspaceInvites).values({
      workspaceId: owner.workspaceId,
      invitedEmail: "pend-oldest@test.local",
      invitedByUserId: owner.userId,
      role: "member",
      tokenHash: t1.tokenHash,
      expiresAt: t1.expiresAt,
      createdAt: new Date(Date.now() - 30_000),
    })
    const t2 = await generateInviteToken()
    await db.insert(workspaceInvites).values({
      workspaceId: owner.workspaceId,
      invitedEmail: "accepted@test.local",
      invitedByUserId: owner.userId,
      role: "member",
      tokenHash: t2.tokenHash,
      expiresAt: t2.expiresAt,
      createdAt: new Date(Date.now() - 20_000),
      acceptedAt: new Date(),
    })
    const t3 = await generateInviteToken()
    await db.insert(workspaceInvites).values({
      workspaceId: owner.workspaceId,
      invitedEmail: "revoked@test.local",
      invitedByUserId: owner.userId,
      role: "member",
      tokenHash: t3.tokenHash,
      expiresAt: t3.expiresAt,
      createdAt: new Date(Date.now() - 15_000),
      revokedAt: new Date(),
    })
    const t4 = await generateInviteToken(new Date(Date.now() - 10 * 24 * 60 * 60 * 1000))
    await db.insert(workspaceInvites).values({
      workspaceId: owner.workspaceId,
      invitedEmail: "expired@test.local",
      invitedByUserId: owner.userId,
      role: "member",
      tokenHash: t4.tokenHash,
      expiresAt: new Date(Date.now() - 1_000), // expired
      createdAt: new Date(Date.now() - 10_000),
    })
    const t5 = await generateInviteToken()
    await db.insert(workspaceInvites).values({
      workspaceId: owner.workspaceId,
      invitedEmail: "pend-newest@test.local",
      invitedByUserId: owner.userId,
      role: "member",
      tokenHash: t5.tokenHash,
      expiresAt: t5.expiresAt,
      createdAt: new Date(Date.now() - 5_000),
    })

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/invites`,
      { headers: { Cookie: owner.cookie } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as PendingInvitesResponse
    expect(body.invites).toHaveLength(2)
    expect(body.invites[0]!.invitedEmail).toBe("pend-newest@test.local")
    expect(body.invites[1]!.invitedEmail).toBe("pend-oldest@test.local")
  })
})

describe("DELETE /api/workspaces/:wsid/invites/:id", () => {
  it("happy path: sets revoked_at, logs audit, returns 204", async () => {
    const owner = await seedOwner("owner10@test.local", "ws-rev-1")
    const db = createDb(env)
    const t = await generateInviteToken()
    const [row] = await db
      .insert(workspaceInvites)
      .values({
        workspaceId: owner.workspaceId,
        invitedEmail: "torevoke@test.local",
        invitedByUserId: owner.userId,
        role: "member",
        tokenHash: t.tokenHash,
        expiresAt: t.expiresAt,
      })
      .returning()

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/invites/${row!.id}`,
      { method: "DELETE", headers: { Cookie: owner.cookie } },
    )
    expect(res.status).toBe(204)

    const [after] = await db
      .select()
      .from(workspaceInvites)
      .where(eq(workspaceInvites.id, row!.id))
    expect(after!.revokedAt).not.toBeNull()

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "workspace.invite_revoked"))
    expect(audits).toHaveLength(1)
  })

  it("idempotent: revoking an already-revoked invite returns 204", async () => {
    const owner = await seedOwner("owner11@test.local", "ws-rev-2")
    const db = createDb(env)
    const t = await generateInviteToken()
    const [row] = await db
      .insert(workspaceInvites)
      .values({
        workspaceId: owner.workspaceId,
        invitedEmail: "already@test.local",
        invitedByUserId: owner.userId,
        role: "member",
        tokenHash: t.tokenHash,
        expiresAt: t.expiresAt,
        revokedAt: new Date(),
      })
      .returning()

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/invites/${row!.id}`,
      { method: "DELETE", headers: { Cookie: owner.cookie } },
    )
    expect(res.status).toBe(204)
  })

  it("409 already_accepted when invite was accepted", async () => {
    const owner = await seedOwner("owner12@test.local", "ws-rev-3")
    const db = createDb(env)
    const t = await generateInviteToken()
    const [row] = await db
      .insert(workspaceInvites)
      .values({
        workspaceId: owner.workspaceId,
        invitedEmail: "done@test.local",
        invitedByUserId: owner.userId,
        role: "member",
        tokenHash: t.tokenHash,
        expiresAt: t.expiresAt,
        acceptedAt: new Date(),
      })
      .returning()

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/invites/${row!.id}`,
      { method: "DELETE", headers: { Cookie: owner.cookie } },
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("already_accepted")
  })
})

describe("POST /api/workspaces/:wsid/invites/:id/resend", () => {
  it("happy path: new token_hash, new expires_at, audit with resend=true", async () => {
    const owner = await seedOwner("owner13@test.local", "ws-resend-1")
    const db = createDb(env)
    const t = await generateInviteToken(new Date(Date.now() - 60_000))
    const [row] = await db
      .insert(workspaceInvites)
      .values({
        workspaceId: owner.workspaceId,
        invitedEmail: "resend@test.local",
        invitedByUserId: owner.userId,
        role: "member",
        tokenHash: t.tokenHash,
        expiresAt: t.expiresAt,
      })
      .returning()
    const priorHash = row!.tokenHash
    const priorExpiresAt = row!.expiresAt.getTime()

    mockResendOK()
    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/invites/${row!.id}/resend`,
      { method: "POST", headers: { Cookie: owner.cookie } },
    )
    expect(res.status).toBe(204)

    const [after] = await db
      .select()
      .from(workspaceInvites)
      .where(eq(workspaceInvites.id, row!.id))
    expect(after!.tokenHash).not.toBe(priorHash)
    expect(after!.expiresAt.getTime()).toBeGreaterThan(priorExpiresAt)

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "workspace.member_invited"))
    expect(audits).toHaveLength(1)
    const meta = JSON.parse(audits[0]!.metadataJson!) as Record<string, unknown>
    expect(meta.resend).toBe(true)
  })

  it("409 when invite already accepted", async () => {
    const owner = await seedOwner("owner14@test.local", "ws-resend-2")
    const db = createDb(env)
    const t = await generateInviteToken()
    const [row] = await db
      .insert(workspaceInvites)
      .values({
        workspaceId: owner.workspaceId,
        invitedEmail: "done@test.local",
        invitedByUserId: owner.userId,
        role: "member",
        tokenHash: t.tokenHash,
        expiresAt: t.expiresAt,
        acceptedAt: new Date(),
      })
      .returning()

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/invites/${row!.id}/resend`,
      { method: "POST", headers: { Cookie: owner.cookie } },
    )
    expect(res.status).toBe(409)
  })

  it("409 when invite already revoked", async () => {
    const owner = await seedOwner("owner15@test.local", "ws-resend-3")
    const db = createDb(env)
    const t = await generateInviteToken()
    const [row] = await db
      .insert(workspaceInvites)
      .values({
        workspaceId: owner.workspaceId,
        invitedEmail: "rev@test.local",
        invitedByUserId: owner.userId,
        role: "member",
        tokenHash: t.tokenHash,
        expiresAt: t.expiresAt,
        revokedAt: new Date(),
      })
      .returning()

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/invites/${row!.id}/resend`,
      { method: "POST", headers: { Cookie: owner.cookie } },
    )
    expect(res.status).toBe(409)
  })
})

describe("POST /api/invites/accept", () => {
  async function seedInvite(workspaceId: string, invitedByUserId: string, email: string) {
    const db = createDb(env)
    const token = await generateInviteToken()
    const [row] = await db
      .insert(workspaceInvites)
      .values({
        workspaceId,
        invitedEmail: email,
        invitedByUserId,
        role: "member",
        tokenHash: token.tokenHash,
        expiresAt: token.expiresAt,
      })
      .returning()
    return { nonce: token.nonce, invite: row! }
  }

  it("new user happy path: 302 to /, Set-Cookie, user + membership + accepted set", async () => {
    const owner = await seedOwner("own-acc-1@test.local", "ws-acc-1")
    const { nonce, invite } = await seedInvite(
      owner.workspaceId,
      owner.userId,
      "new-invitee@test.local",
    )

    const res = await SELF.fetch(`${BASE}/api/invites/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: nonce }),
      redirect: "manual",
    })
    expect(res.status).toBe(302)
    expect(res.headers.get("Location")).toBe("/")
    expect(res.headers.get("Set-Cookie")).toMatch(/rs_session=/)
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer")
    expect(res.headers.get("Cache-Control")).toBe("no-store")

    const db = createDb(env)
    const [u] = await db
      .select()
      .from(users)
      .where(eq(users.email, "new-invitee@test.local"))
      .limit(1)
    expect(u).toBeDefined()

    const [mem] = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, owner.workspaceId),
          eq(workspaceMembers.userId, u!.id),
        ),
      )
      .limit(1)
    expect(mem).toBeDefined()
    expect(mem!.role).toBe("member")

    const [after] = await db
      .select()
      .from(workspaceInvites)
      .where(eq(workspaceInvites.id, invite.id))
    expect(after!.acceptedAt).not.toBeNull()

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "workspace.invite_accepted"))
    expect(audits).toHaveLength(1)
    expect(audits[0]!.workspaceId).toBe(owner.workspaceId)
    expect(audits[0]!.actorUserId).toBe(u!.id)
  })

  it("returning user happy path: membership appended, cookie re-signed to invited ws", async () => {
    const owner = await seedOwner("own-acc-2@test.local", "ws-acc-2")

    // Pre-existing user with their own workspace.
    const db = createDb(env)
    const [existing] = await db
      .insert(users)
      .values({ email: "ret@test.local" })
      .returning()
    const [existingWs] = await db
      .insert(workspaces)
      .values({ name: "ret-ws" })
      .returning()
    await db.insert(workspaceMembers).values({
      workspaceId: existingWs!.id,
      userId: existing!.id,
      role: "owner",
    })

    const { nonce } = await seedInvite(
      owner.workspaceId,
      owner.userId,
      "ret@test.local",
    )

    const res = await SELF.fetch(`${BASE}/api/invites/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: nonce }),
      redirect: "manual",
    })
    expect(res.status).toBe(302)
    const setCookie = res.headers.get("Set-Cookie")!
    const match = setCookie.match(/rs_session=([^;]+)/)!
    const newCookie = `rs_session=${match[1]}`

    // /me reflects the invited workspace as active.
    const me = await SELF.fetch(`${BASE}/api/auth/me`, {
      headers: { Cookie: newCookie },
    })
    expect(me.status).toBe(200)
    const body = (await me.json()) as UserMeResponse
    expect(body.activeWorkspace.id).toBe(owner.workspaceId)
    expect(body.workspaces).toHaveLength(2)
  })

  it("expired token → 410", async () => {
    const owner = await seedOwner("own-acc-3@test.local", "ws-acc-3")
    const db = createDb(env)
    const token = await generateInviteToken(
      new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // 10 days ago
    )
    await db.insert(workspaceInvites).values({
      workspaceId: owner.workspaceId,
      invitedEmail: "exp@test.local",
      invitedByUserId: owner.userId,
      role: "member",
      tokenHash: token.tokenHash,
      expiresAt: token.expiresAt,
    })

    const res = await SELF.fetch(`${BASE}/api/invites/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token.nonce }),
      redirect: "manual",
    })
    expect(res.status).toBe(410)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("token_expired")
  })

  it("revoked token → 410", async () => {
    const owner = await seedOwner("own-acc-4@test.local", "ws-acc-4")
    const db = createDb(env)
    const token = await generateInviteToken()
    await db.insert(workspaceInvites).values({
      workspaceId: owner.workspaceId,
      invitedEmail: "rev@test.local",
      invitedByUserId: owner.userId,
      role: "member",
      tokenHash: token.tokenHash,
      expiresAt: token.expiresAt,
      revokedAt: new Date(),
    })

    const res = await SELF.fetch(`${BASE}/api/invites/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token.nonce }),
      redirect: "manual",
    })
    expect(res.status).toBe(410)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("token_revoked")
  })

  it("already-accepted token → 410", async () => {
    const owner = await seedOwner("own-acc-5@test.local", "ws-acc-5")
    const db = createDb(env)
    const token = await generateInviteToken()
    await db.insert(workspaceInvites).values({
      workspaceId: owner.workspaceId,
      invitedEmail: "done@test.local",
      invitedByUserId: owner.userId,
      role: "member",
      tokenHash: token.tokenHash,
      expiresAt: token.expiresAt,
      acceptedAt: new Date(),
    })

    const res = await SELF.fetch(`${BASE}/api/invites/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token.nonce }),
      redirect: "manual",
    })
    expect(res.status).toBe(410)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("token_accepted")
  })

  it("malformed token → 400", async () => {
    const res = await SELF.fetch(`${BASE}/api/invites/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "short" }),
      redirect: "manual",
    })
    expect(res.status).toBe(400)
  })

  it("email_mismatch: signed in as different email → 409, cookie unchanged, no membership", async () => {
    const owner = await seedOwner("own-acc-6@test.local", "ws-acc-6")

    // Create signed-in user "alice" with their own workspace.
    const db = createDb(env)
    const [alice] = await db
      .insert(users)
      .values({ email: "alice@test.local" })
      .returning()
    const [aliceWs] = await db
      .insert(workspaces)
      .values({ name: "alice-ws" })
      .returning()
    await db.insert(workspaceMembers).values({
      workspaceId: aliceWs!.id,
      userId: alice!.id,
      role: "owner",
    })
    const aliceCookie = await mintCookie(alice!.id, aliceWs!.id, Date.now() + 3_600_000)

    // Invite is for a different address.
    const token = await generateInviteToken()
    const [invite] = await db
      .insert(workspaceInvites)
      .values({
        workspaceId: owner.workspaceId,
        invitedEmail: "bob@test.local",
        invitedByUserId: owner.userId,
        role: "member",
        tokenHash: token.tokenHash,
        expiresAt: token.expiresAt,
      })
      .returning()

    const res = await SELF.fetch(`${BASE}/api/invites/accept`, {
      method: "POST",
      headers: { Cookie: aliceCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ token: token.nonce }),
      redirect: "manual",
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("email_mismatch")
    // No Set-Cookie on an email-mismatch response.
    expect(res.headers.get("Set-Cookie")).toBeNull()

    // No new membership row created for alice under owner's workspace.
    const memships = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, owner.workspaceId),
          eq(workspaceMembers.userId, alice!.id),
        ),
      )
    expect(memships).toHaveLength(0)

    // Invite still pending (not marked accepted).
    const [afterInvite] = await db
      .select()
      .from(workspaceInvites)
      .where(eq(workspaceInvites.id, invite!.id))
    expect(afterInvite!.acceptedAt).toBeNull()
  })

  it("already_member: invited user is already a member → 409, invite marked accepted", async () => {
    const owner = await seedOwner("own-acc-7@test.local", "ws-acc-7")
    const db = createDb(env)

    // Create a user for the invited email, already a member.
    const [u] = await db
      .insert(users)
      .values({ email: "already@test.local" })
      .returning()
    await db.insert(workspaceMembers).values({
      workspaceId: owner.workspaceId,
      userId: u!.id,
      role: "member",
    })

    const token = await generateInviteToken()
    const [invite] = await db
      .insert(workspaceInvites)
      .values({
        workspaceId: owner.workspaceId,
        invitedEmail: "already@test.local",
        invitedByUserId: owner.userId,
        role: "member",
        tokenHash: token.tokenHash,
        expiresAt: token.expiresAt,
      })
      .returning()

    const res = await SELF.fetch(`${BASE}/api/invites/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token.nonce }),
      redirect: "manual",
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("already_member")

    // Invite was marked accepted to prevent reuse.
    const [after] = await db
      .select()
      .from(workspaceInvites)
      .where(eq(workspaceInvites.id, invite!.id))
    expect(after!.acceptedAt).not.toBeNull()

    // Membership count for (wsid, userId) still exactly 1.
    const memships = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, owner.workspaceId),
          eq(workspaceMembers.userId, u!.id),
        ),
      )
    expect(memships).toHaveLength(1)
  })

  it("accepted session cookie verifies with wsid = invited workspace", async () => {
    const owner = await seedOwner("own-acc-8@test.local", "ws-acc-8")
    const db = createDb(env)
    const token = await generateInviteToken()
    await db.insert(workspaceInvites).values({
      workspaceId: owner.workspaceId,
      invitedEmail: "sess@test.local",
      invitedByUserId: owner.userId,
      role: "member",
      tokenHash: token.tokenHash,
      expiresAt: token.expiresAt,
    })

    const res = await SELF.fetch(`${BASE}/api/invites/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token.nonce }),
      redirect: "manual",
    })
    expect(res.status).toBe(302)
    const setCookie = res.headers.get("Set-Cookie")!
    const match = setCookie.match(/rs_session=([^;]+)/)!
    const rawToken = match[1]!

    const keyset = await loadKeySet(env.SESSION_SECRET)
    const v = await verifySession(rawToken, keyset)
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.payload.wsid).toBe(owner.workspaceId)
  })
})
