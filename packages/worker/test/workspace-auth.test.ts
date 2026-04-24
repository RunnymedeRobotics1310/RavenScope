import { env, fetchMock, SELF } from "cloudflare:test"
import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  loadKeySet,
  SESSION_COOKIE_NAME,
  signSession,
  verifySession,
} from "../src/auth/cookie"
import { generateToken, recordTokenRequest, verifyToken } from "../src/auth/magic-link"
import { createDb } from "../src/db/client"
import {
  auditLog,
  loginTokens,
  users,
  workspaceMembers,
  workspaces,
} from "../src/db/schema"
import type { UserMeResponse } from "../src/dto"

const BASE = "https://ravenscope.test"

/* --------------------------------------------------------------- helpers */

async function wipeDb() {
  const db = createDb(env)
  await db.delete(auditLog)
  await db.delete(loginTokens)
  await db.delete(workspaceMembers)
  await db.delete(workspaces)
  await db.delete(users)
}

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get("Set-Cookie")
  if (!setCookie) throw new Error("no Set-Cookie on response")
  const match = setCookie.match(/rs_session=([^;]+)/)
  if (!match) throw new Error(`no rs_session in Set-Cookie: ${setCookie}`)
  return `rs_session=${match[1]}`
}

function extractRawToken(res: Response): string {
  const setCookie = res.headers.get("Set-Cookie")
  if (!setCookie) throw new Error("no Set-Cookie on response")
  const match = setCookie.match(/rs_session=([^;]+)/)
  if (!match) throw new Error(`no rs_session value in: ${setCookie}`)
  return match[1]!
}

/** Mint a signed cookie directly, bypassing the magic-link flow. */
async function mintCookie(uid: string, wsid: string, expMs: number): Promise<string> {
  const keyset = await loadKeySet(env.SESSION_SECRET)
  const token = await signSession({ uid, wsid, exp: expMs }, keyset)
  return `${SESSION_COOKIE_NAME}=${token}`
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

/* =============================================================== tests */

describe("requireCookieUser — membership-aware middleware", () => {
  it("happy path: membership found, role='owner' reflected on /me", async () => {
    const db = createDb(env)
    const [u] = await db.insert(users).values({ email: "o1@test.local" }).returning()
    const [ws] = await db.insert(workspaces).values({ name: "ws-o1" }).returning()
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws!.id, userId: u!.id, role: "owner" })

    const cookie = await mintCookie(u!.id, ws!.id, Date.now() + 60_000)
    const res = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as UserMeResponse
    expect(body.activeWorkspace.role).toBe("owner")
  })

  it("happy path: member role reflected", async () => {
    const db = createDb(env)
    const [owner] = await db.insert(users).values({ email: "o2@test.local" }).returning()
    const [ws] = await db.insert(workspaces).values({ name: "ws-m1" }).returning()
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws!.id, userId: owner!.id, role: "owner" })
    const [mem] = await db.insert(users).values({ email: "m1@test.local" }).returning()
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws!.id, userId: mem!.id, role: "member" })

    const cookie = await mintCookie(mem!.id, ws!.id, Date.now() + 60_000)
    const res = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as UserMeResponse
    expect(body.activeWorkspace.role).toBe("member")
  })

  it("GET fallback: removed from wsid, re-signs to oldest membership + logs audit", async () => {
    const db = createDb(env)
    const [u] = await db.insert(users).values({ email: "fb@test.local" }).returning()
    const [wsStale] = await db.insert(workspaces).values({ name: "ws-stale" }).returning()
    const [wsValid] = await db.insert(workspaces).values({ name: "ws-valid" }).returning()
    // wsValid joined earlier → becomes the fallback target.
    await db.insert(workspaceMembers).values({
      workspaceId: wsValid!.id,
      userId: u!.id,
      role: "owner",
      joinedAt: new Date(Date.now() - 20_000),
    })
    // No membership row for wsStale — cookie points at a workspace the user
    // was removed from.
    const cookie = await mintCookie(u!.id, wsStale!.id, Date.now() + 60_000)
    const res = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })

    expect(res.status).toBe(200)
    const body = (await res.json()) as UserMeResponse
    expect(body.activeWorkspace.id).toBe(wsValid!.id)

    // Response must include a fresh Set-Cookie for the new wsid.
    expect(res.headers.get("Set-Cookie")).toMatch(/rs_session=/)

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "workspace.switched"))
    expect(audits).toHaveLength(1)
    expect(audits[0]!.workspaceId).toBe(wsValid!.id)
    const meta = JSON.parse(audits[0]!.metadataJson!) as Record<string, string>
    expect(meta.reason).toBe("cookie_fallback")
    expect(meta.previous_wsid).toBe(wsStale!.id)
    expect(meta.new_wsid).toBe(wsValid!.id)
  })

  it("POST rejection: stale cookie on mutating method → 401, no re-sign, no audit", async () => {
    const db = createDb(env)
    const [u] = await db.insert(users).values({ email: "post@test.local" }).returning()
    const [wsStale] = await db.insert(workspaces).values({ name: "ws-stale-p" }).returning()
    const [wsValid] = await db.insert(workspaces).values({ name: "ws-valid-p" }).returning()
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: wsValid!.id, userId: u!.id, role: "owner" })

    const cookie = await mintCookie(u!.id, wsStale!.id, Date.now() + 60_000)
    const res = await SELF.fetch(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(401)
    // Cookie must be cleared.
    expect(res.headers.get("Set-Cookie")).toMatch(/Max-Age=0/)
    // No workspace.switched audit row for a rejected mutating request.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "workspace.switched"))
    expect(audits).toHaveLength(0)
  })

  it("zero memberships → 401 + cookie cleared", async () => {
    const db = createDb(env)
    const [u] = await db.insert(users).values({ email: "none@test.local" }).returning()
    const [ws] = await db.insert(workspaces).values({ name: "ws-none" }).returning()
    // No workspace_members row.
    const cookie = await mintCookie(u!.id, ws!.id, Date.now() + 60_000)
    const res = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(401)
    expect(res.headers.get("Set-Cookie")).toMatch(/Max-Age=0/)
  })

  it("fallback preserves original exp (does not extend to full TTL)", async () => {
    const db = createDb(env)
    const [u] = await db.insert(users).values({ email: "exp@test.local" }).returning()
    const [wsStale] = await db.insert(workspaces).values({ name: "ws-stale-e" }).returning()
    const [wsValid] = await db.insert(workspaces).values({ name: "ws-valid-e" }).returning()
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: wsValid!.id, userId: u!.id, role: "owner" })

    const originalExp = Date.now() + 5 * 60 * 1000 // 5 minutes
    const cookie = await mintCookie(u!.id, wsStale!.id, originalExp)
    const res = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)

    const newToken = extractRawToken(res)
    const keyset = await loadKeySet(env.SESSION_SECRET)
    const verifyResult = await verifySession(newToken, keyset)
    expect(verifyResult.ok).toBe(true)
    if (!verifyResult.ok) return
    // exp preserved within 1s tolerance; wsid switched.
    expect(Math.abs(verifyResult.payload.exp - originalExp)).toBeLessThan(1000)
    expect(verifyResult.payload.wsid).toBe(wsValid!.id)

    // The browser Max-Age must track the remaining exp lifetime, NOT
    // default to the full SESSION_TTL. Otherwise the cookie outlives
    // the payload's exp in the browser and obscures session-expiry UX.
    const setCookie = res.headers.get("Set-Cookie")
    const maxAgeMatch = setCookie?.match(/Max-Age=(\d+)/)
    expect(maxAgeMatch).toBeTruthy()
    const maxAge = Number(maxAgeMatch![1])
    // Original exp was 5 minutes out; Max-Age should be <= 300s (+ small slack).
    expect(maxAge).toBeLessThanOrEqual(305)
    expect(maxAge).toBeGreaterThan(0)
  })

  it("concurrent GETs with stale cookie converge on same fallback target", async () => {
    const db = createDb(env)
    const [u] = await db.insert(users).values({ email: "cc@test.local" }).returning()
    const [wsStale] = await db.insert(workspaces).values({ name: "ws-stale-c" }).returning()
    const [wsValid] = await db.insert(workspaces).values({ name: "ws-valid-c" }).returning()
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: wsValid!.id, userId: u!.id, role: "owner" })

    const cookie = await mintCookie(u!.id, wsStale!.id, Date.now() + 60_000)
    const [r1, r2, r3] = await Promise.all([
      SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } }),
      SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } }),
      SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } }),
    ])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(r3.status).toBe(200)

    const keyset = await loadKeySet(env.SESSION_SECRET)
    for (const res of [r1, r2, r3]) {
      const tok = extractRawToken(res)
      const v = await verifySession(tok, keyset)
      expect(v.ok).toBe(true)
      if (!v.ok) return
      expect(v.payload.wsid).toBe(wsValid!.id)
    }
  })
})

describe("magic-link verifyToken", () => {
  it("first sign-in creates user + workspace + owner membership (all three rows)", async () => {
    const db = createDb(env)
    const token = await generateToken()
    await recordTokenRequest(db, "first@test.local", token)

    const outcome = await verifyToken(db, token.nonce)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.firstSignIn).toBe(true)

    const allUsers = await db.select().from(users)
    const allWorkspaces = await db.select().from(workspaces)
    const allMembers = await db.select().from(workspaceMembers)
    expect(allUsers).toHaveLength(1)
    expect(allWorkspaces).toHaveLength(1)
    expect(allMembers).toHaveLength(1)
    expect(allMembers[0]!.role).toBe("owner")
    expect(allMembers[0]!.userId).toBe(allUsers[0]!.id)
    expect(allMembers[0]!.workspaceId).toBe(allWorkspaces[0]!.id)
  })

  it("returning user with two memberships resolves to oldest by joined_at", async () => {
    const db = createDb(env)
    const [u] = await db.insert(users).values({ email: "ret@test.local" }).returning()
    const [wsOld] = await db.insert(workspaces).values({ name: "ws-old" }).returning()
    const [wsNew] = await db.insert(workspaces).values({ name: "ws-new" }).returning()
    await db.insert(workspaceMembers).values({
      workspaceId: wsOld!.id,
      userId: u!.id,
      role: "owner",
      joinedAt: new Date(Date.now() - 20_000),
    })
    await db.insert(workspaceMembers).values({
      workspaceId: wsNew!.id,
      userId: u!.id,
      role: "member",
      joinedAt: new Date(Date.now() - 10_000),
    })

    const token = await generateToken()
    await recordTokenRequest(db, "ret@test.local", token)
    const outcome = await verifyToken(db, token.nonce)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.workspaceId).toBe(wsOld!.id)
  })
})

describe("POST /api/auth/switch-workspace", () => {
  it("happy path: switch to a workspace user is a member of → 204, /me reflects", async () => {
    const db = createDb(env)
    const [u] = await db.insert(users).values({ email: "sw@test.local" }).returning()
    const [wsA] = await db.insert(workspaces).values({ name: "ws-sw-a" }).returning()
    const [wsB] = await db.insert(workspaces).values({ name: "ws-sw-b" }).returning()
    await db.insert(workspaceMembers).values({
      workspaceId: wsA!.id,
      userId: u!.id,
      role: "owner",
      joinedAt: new Date(Date.now() - 20_000),
    })
    await db.insert(workspaceMembers).values({
      workspaceId: wsB!.id,
      userId: u!.id,
      role: "member",
      joinedAt: new Date(Date.now() - 10_000),
    })

    const cookie = await mintCookie(u!.id, wsA!.id, Date.now() + 60_000)
    const res = await SELF.fetch(`${BASE}/api/auth/switch-workspace`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: wsB!.id }),
    })
    expect(res.status).toBe(204)

    const newCookie = extractSessionCookie(res)
    const meRes = await SELF.fetch(`${BASE}/api/auth/me`, {
      headers: { Cookie: newCookie },
    })
    const body = (await meRes.json()) as UserMeResponse
    expect(body.activeWorkspace.id).toBe(wsB!.id)
    expect(body.activeWorkspace.role).toBe("member")

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "workspace.switched"))
    expect(audits).toHaveLength(1)
    expect(audits[0]!.workspaceId).toBe(wsB!.id)
    const meta = JSON.parse(audits[0]!.metadataJson!) as Record<string, string>
    expect(meta.reason).toBe("explicit")

    // Max-Age must track remaining exp (≤60s here), not reset to full TTL.
    const setCookieHeader = res.headers.get("Set-Cookie")
    const maxAgeMatch = setCookieHeader?.match(/Max-Age=(\d+)/)
    expect(maxAgeMatch).toBeTruthy()
    const maxAge = Number(maxAgeMatch![1])
    expect(maxAge).toBeLessThanOrEqual(60)
    expect(maxAge).toBeGreaterThan(0)
  })

  it("403 not_a_member when target workspace is not joined", async () => {
    const db = createDb(env)
    const [u] = await db.insert(users).values({ email: "nm@test.local" }).returning()
    const [ws] = await db.insert(workspaces).values({ name: "ws-nm" }).returning()
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws!.id, userId: u!.id, role: "owner" })
    // Foreign workspace the user is NOT a member of.
    const [foreign] = await db.insert(workspaces).values({ name: "foreign" }).returning()

    const cookie = await mintCookie(u!.id, ws!.id, Date.now() + 60_000)
    const res = await SELF.fetch(`${BASE}/api/auth/switch-workspace`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: foreign!.id }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("not_a_member")
  })

  it("404 unknown_workspace when target id does not exist", async () => {
    const db = createDb(env)
    const [u] = await db.insert(users).values({ email: "uw@test.local" }).returning()
    const [ws] = await db.insert(workspaces).values({ name: "ws-uw" }).returning()
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws!.id, userId: u!.id, role: "owner" })

    const cookie = await mintCookie(u!.id, ws!.id, Date.now() + 60_000)
    const res = await SELF.fetch(`${BASE}/api/auth/switch-workspace`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "00000000-0000-0000-0000-000000000000" }),
    })
    expect(res.status).toBe(404)
  })

  it("400 on malformed body (no workspaceId)", async () => {
    const db = createDb(env)
    const [u] = await db.insert(users).values({ email: "bad@test.local" }).returning()
    const [ws] = await db.insert(workspaces).values({ name: "ws-bad" }).returning()
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws!.id, userId: u!.id, role: "owner" })

    const cookie = await mintCookie(u!.id, ws!.id, Date.now() + 60_000)
    const res = await SELF.fetch(`${BASE}/api/auth/switch-workspace`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ wrongField: "x" }),
    })
    expect(res.status).toBe(400)
  })
})

describe("Role gating (U6): api-keys + sessions PATCH/DELETE owner-only", () => {
  async function seedOwnerMemberWorkspace() {
    const db = createDb(env)
    const [owner] = await db.insert(users).values({ email: "owner-gate@test.local" }).returning()
    const [mem] = await db.insert(users).values({ email: "mem-gate@test.local" }).returning()
    const [ws] = await db.insert(workspaces).values({ name: "gate-ws" }).returning()
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws!.id, userId: owner!.id, role: "owner" })
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws!.id, userId: mem!.id, role: "member" })
    return { owner: owner!, mem: mem!, ws: ws! }
  }

  it("member: GET /api/keys returns 403", async () => {
    const { mem, ws } = await seedOwnerMemberWorkspace()
    const cookie = await mintCookie(mem.id, ws.id, Date.now() + 60_000)
    const res = await SELF.fetch(`${BASE}/api/keys`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(403)
  })

  it("member: POST /api/keys returns 403", async () => {
    const { mem, ws } = await seedOwnerMemberWorkspace()
    const cookie = await mintCookie(mem.id, ws.id, Date.now() + 60_000)
    const res = await SELF.fetch(`${BASE}/api/keys`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nope" }),
    })
    expect(res.status).toBe(403)
  })

  it("owner: GET /api/keys returns 200 (unchanged)", async () => {
    const { owner, ws } = await seedOwnerMemberWorkspace()
    const cookie = await mintCookie(owner.id, ws.id, Date.now() + 60_000)
    const res = await SELF.fetch(`${BASE}/api/keys`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
  })
})

describe("GET /api/auth/me — workspaces list", () => {
  it("returns workspaces sorted by joinedAt ASC with per-entry role", async () => {
    const db = createDb(env)
    const [u] = await db.insert(users).values({ email: "list@test.local" }).returning()
    const [wsA] = await db.insert(workspaces).values({ name: "ws-list-a" }).returning()
    const [wsB] = await db.insert(workspaces).values({ name: "ws-list-b" }).returning()
    await db.insert(workspaceMembers).values({
      workspaceId: wsA!.id,
      userId: u!.id,
      role: "owner",
      joinedAt: new Date(Date.now() - 20_000),
    })
    await db.insert(workspaceMembers).values({
      workspaceId: wsB!.id,
      userId: u!.id,
      role: "member",
      joinedAt: new Date(Date.now() - 10_000),
    })

    const cookie = await mintCookie(u!.id, wsB!.id, Date.now() + 60_000)
    const res = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as UserMeResponse
    expect(body.activeWorkspace.id).toBe(wsB!.id)
    expect(body.workspaces).toHaveLength(2)
    expect(body.workspaces[0]!.id).toBe(wsA!.id)
    expect(body.workspaces[0]!.role).toBe("owner")
    expect(body.workspaces[1]!.id).toBe(wsB!.id)
    expect(body.workspaces[1]!.role).toBe("member")
  })

  it("single-workspace user: workspaces is a one-element array", async () => {
    const db = createDb(env)
    const [u] = await db.insert(users).values({ email: "solo@test.local" }).returning()
    const [ws] = await db.insert(workspaces).values({ name: "ws-solo" }).returning()
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws!.id, userId: u!.id, role: "owner" })

    const cookie = await mintCookie(u!.id, ws!.id, Date.now() + 60_000)
    const res = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as UserMeResponse
    expect(body.workspaces).toHaveLength(1)
    expect(body.workspaces[0]!.role).toBe("owner")
  })
})
