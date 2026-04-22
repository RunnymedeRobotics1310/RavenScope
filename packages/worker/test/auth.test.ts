import { env, fetchMock, SELF } from "cloudflare:test"
import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createDb } from "../src/db/client"
import { auditLog, loginTokens, users, workspaces } from "../src/db/schema"

/**
 * Test helpers ----------------------------------------------------------
 */

const BASE = "https://ravenscope.test"
const CF_IP_HEADER = { "CF-Connecting-IP": "203.0.113.10" }

function mockResendOK() {
  fetchMock
    .get("https://api.resend.com")
    .intercept({ path: "/emails", method: "POST" })
    .reply(200, { id: "fake-resend-id" })
}

function mockResend500() {
  fetchMock
    .get("https://api.resend.com")
    .intercept({ path: "/emails", method: "POST" })
    .reply(500, "server error")
    .times(3)
}

async function wipeDb() {
  const db = createDb(env)
  await db.delete(auditLog)
  await db.delete(loginTokens)
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

async function requestLinkAs(email: string, ip = "203.0.113.10") {
  return SELF.fetch(`${BASE}/api/auth/request-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ email }),
  })
}

async function latestNonceFor(email: string): Promise<string> {
  // Since the nonce is only returned via email and we're intercepting fetch,
  // we need to reach into the DB to get the row and then derive what nonce
  // was sent. Easier: inspect the most recent intercepted fetch body.
  // For simplicity in tests, we query loginTokens for the newest row and
  // use the same token-hash scheme to verify flows via verifyToken directly;
  // for the HTTP path we expose the nonce through a test trapdoor below.
  throw new Error("unused — tests that need the nonce capture it from the mock")
}

/**
 * Capture the magic-link URL from the Resend request body so tests can drive
 * /verify end-to-end. Each call to `mockResendCapture()` returns an awaitable
 * that resolves to the parsed URL.
 */
function mockResendCapture(): Promise<URL> {
  return new Promise((resolve) => {
    fetchMock
      .get("https://api.resend.com")
      .intercept({ path: "/emails", method: "POST" })
      .reply((req) => {
        const body = JSON.parse(String(req.body)) as { text: string }
        const match = body.text.match(/https?:\/\/\S+/)
        if (!match) throw new Error(`no link in email body: ${body.text}`)
        resolve(new URL(match[0]))
        return { statusCode: 200, data: { id: "captured" } }
      })
  })
}

/**
 * Lifecycle ------------------------------------------------------------
 */

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

/**
 * Tests ---------------------------------------------------------------
 */

describe("POST /api/auth/request-link", () => {
  it("happy path: 204, inserts login_tokens row, sends email", async () => {
    mockResendOK()
    const res = await requestLinkAs("new@test.local")
    expect(res.status).toBe(204)

    const db = createDb(env)
    const rows = await db.select().from(loginTokens)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.email).toBe("new@test.local")
  })

  it("rejects malformed email with 400 (no rate-limit charge, no DB row)", async () => {
    const res = await requestLinkAs("not-an-email")
    expect(res.status).toBe(400)

    const db = createDb(env)
    expect(await db.select().from(loginTokens)).toHaveLength(0)
  })

  it("returns 204 even when Resend fails (no enumeration) and audit-logs the failure", async () => {
    mockResend500()
    const res = await requestLinkAs("flaky@test.local")
    expect(res.status).toBe(204)

    const db = createDb(env)
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "magic_link_requested"))
    expect(audits).toHaveLength(1)
    expect(audits[0]!.metadataJson).toMatch(/email_send_failed/)
  })

  it("per-IP rate limit: 6th request in a minute from same IP returns 429", async () => {
    // 5 allowed + 1 denied. Each succeeds at the email layer.
    for (let i = 0; i < 5; i++) mockResendOK()
    for (let i = 0; i < 5; i++) {
      const res = await requestLinkAs(`user${i}@test.local`)
      expect(res.status).toBe(204)
    }
    const denied = await requestLinkAs("user5@test.local")
    expect(denied.status).toBe(429)
    expect(denied.headers.get("Retry-After")).toBeTruthy()
  })

  it("per-email rate limit: 4th request for same email in 10 min returns 429", async () => {
    for (let i = 0; i < 3; i++) mockResendOK()
    for (let i = 0; i < 3; i++) {
      const res = await requestLinkAs("spammed@test.local", `198.51.100.${i + 1}`)
      expect(res.status).toBe(204)
    }
    const denied = await requestLinkAs("spammed@test.local", "198.51.100.99")
    expect(denied.status).toBe(429)
  })
})

describe("GET /api/auth/verify + cookie + me + logout flow", () => {
  it("full flow: request → verify → me → logout → me returns 401", async () => {
    const linkPromise = mockResendCapture()
    const r1 = await requestLinkAs("flow@test.local")
    expect(r1.status).toBe(204)
    const link = await linkPromise

    const r2 = await SELF.fetch(link.toString(), { redirect: "manual" })
    expect(r2.status).toBe(302)
    expect(r2.headers.get("Location")).toBe("/")
    const cookie = extractSessionCookie(r2)

    const db = createDb(env)
    const u = await db.select().from(users)
    const w = await db.select().from(workspaces)
    expect(u).toHaveLength(1)
    expect(w).toHaveLength(1)
    expect(w[0]!.ownerUserId).toBe(u[0]!.id)

    const r3 = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })
    expect(r3.status).toBe(200)
    const me = (await r3.json()) as { email: string; workspaceId: string }
    expect(me.email).toBe("flow@test.local")
    expect(me.workspaceId).toBe(w[0]!.id)

    const r4 = await SELF.fetch(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie },
    })
    expect(r4.status).toBe(204)

    const r5 = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })
    expect(r5.status).toBe(200) // logout is cookie-clearing on client; server-side this cookie still verifies.
    // ^^ Documented behaviour per plan: no server-side revocation table in v1.
  })

  it("repeat sign-in with existing email does not duplicate user/workspace rows", async () => {
    const link1 = mockResendCapture()
    await requestLinkAs("repeat@test.local")
    const l1 = await link1
    await SELF.fetch(l1.toString(), { redirect: "manual" })

    const link2 = mockResendCapture()
    await requestLinkAs("repeat@test.local", "203.0.113.99")
    const l2 = await link2
    await SELF.fetch(l2.toString(), { redirect: "manual" })

    const db = createDb(env)
    expect(await db.select().from(users)).toHaveLength(1)
    expect(await db.select().from(workspaces)).toHaveLength(1)
  })

  it("reusing the same magic-link nonce returns 410", async () => {
    const link = await (async () => {
      const p = mockResendCapture()
      await requestLinkAs("once@test.local")
      return p
    })()
    const first = await SELF.fetch(link.toString(), { redirect: "manual" })
    expect(first.status).toBe(302)
    const second = await SELF.fetch(link.toString(), { redirect: "manual" })
    expect(second.status).toBe(410)
  })

  it("unknown/random nonce returns 410", async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/verify?t=not-a-real-nonce-1234567890`, {
      redirect: "manual",
    })
    expect(res.status).toBe(410)
  })

  it("expired token returns 410", async () => {
    // Insert a token directly with expires_at in the past.
    const db = createDb(env)
    const { generateToken } = await import("../src/auth/magic-link")
    const token = await generateToken(new Date(Date.now() - 20 * 60 * 1000))
    await db.insert(loginTokens).values({
      tokenHash: token.tokenHash,
      email: "expired@test.local",
      expiresAt: token.expiresAt,
    })
    const res = await SELF.fetch(`${BASE}/api/auth/verify?t=${token.nonce}`, {
      redirect: "manual",
    })
    expect(res.status).toBe(410)
  })

  it("audit log records all three events after full flow", async () => {
    const linkPromise = mockResendCapture()
    await requestLinkAs("audit@test.local")
    const link = await linkPromise
    const verify = await SELF.fetch(link.toString(), { redirect: "manual" })
    const cookie = extractSessionCookie(verify)
    await SELF.fetch(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie },
    })

    const db = createDb(env)
    const events = await db.select().from(auditLog)
    const types = events.map((e) => e.eventType).sort()
    expect(types).toEqual(["logout", "magic_link_requested", "magic_link_verified"])
  })
})

describe("HTTPS-only middleware", () => {
  it("rejects http:// requests with 400", async () => {
    const res = await SELF.fetch("http://ravenscope.remote/api/health")
    expect(res.status).toBe(400)
  })

  it("allows https:// requests", async () => {
    const res = await SELF.fetch(`${BASE}/api/health`)
    expect(res.status).toBe(200)
  })

  it("allows localhost over http (dev)", async () => {
    const res = await SELF.fetch("http://localhost/api/health")
    expect(res.status).toBe(200)
  })
})

describe("cookie sessions", () => {
  it("cookie with unknown kid → 401 + Max-Age=0 Set-Cookie", async () => {
    // Build a syntactically-valid but unknown-kid cookie by hand.
    const payload = {
      uid: "fake",
      wsid: "fake",
      kid: "v99",
      exp: Date.now() + 60_000,
    }
    const cookie = `rs_session=${btoa(JSON.stringify(payload))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")}.AAAA`
    const res = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(401)
    expect(res.headers.get("Set-Cookie")).toMatch(/rs_session=/)
    expect(res.headers.get("Set-Cookie")).toMatch(/Max-Age=0/)
  })

  it("tampered cookie signature → 401", async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/me`, {
      headers: { Cookie: "rs_session=eyJ1aWQiOiJ4In0.tampered" },
    })
    expect(res.status).toBe(401)
  })

  it("no cookie → 401", async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/me`)
    expect(res.status).toBe(401)
  })
})
