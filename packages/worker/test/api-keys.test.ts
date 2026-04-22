import {
  createExecutionContext,
  env,
  fetchMock,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { generateApiKey } from "../src/auth/apikey"
import { requireApiKeyUser } from "../src/auth/require-apikey-user"
import { createDb } from "../src/db/client"
import { apiKeys, auditLog, loginTokens, users, workspaces } from "../src/db/schema"
import type {
  ApiKeyCreateResponse,
  ApiKeyListResponse,
} from "../src/dto"

const BASE = "https://ravenscope.test"

async function wipeDb() {
  const db = createDb(env)
  await db.delete(auditLog)
  await db.delete(apiKeys)
  await db.delete(loginTokens)
  await db.delete(workspaces)
  await db.delete(users)
}

/**
 * Sign in via the magic-link flow and return the session cookie for a fresh
 * user+workspace. Avoids duplicating the flow in every test.
 */
async function signInAs(email: string): Promise<{ cookie: string; workspaceId: string }> {
  const captured = new Promise<URL>((resolve) => {
    fetchMock
      .get("https://api.resend.com")
      .intercept({ path: "/emails", method: "POST" })
      .reply((req) => {
        const body = JSON.parse(String(req.body)) as { text: string }
        const match = body.text.match(/https?:\/\/\S+/)
        if (!match) throw new Error("no link")
        resolve(new URL(match[0]))
        return { statusCode: 200, data: { id: "fake" } }
      })
  })

  const reqLink = await SELF.fetch(`${BASE}/api/auth/request-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.42" },
    body: JSON.stringify({ email }),
  })
  expect(reqLink.status).toBe(204)

  const link = await captured
  const verifyRes = await SELF.fetch(link.toString(), { redirect: "manual" })
  expect(verifyRes.status).toBe(302)
  const setCookie = verifyRes.headers.get("Set-Cookie")!
  const match = setCookie.match(/rs_session=([^;]+)/)!
  const cookie = `rs_session=${match[1]}`

  const me = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })
  const meBody = (await me.json()) as { workspaceId: string }
  return { cookie, workspaceId: meBody.workspaceId }
}

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

describe("POST /api/keys", () => {
  it("returns plaintext once; list thereafter returns prefix+last4 only", async () => {
    const { cookie } = await signInAs("keys@test.local")

    const createRes = await SELF.fetch(`${BASE}/api/keys`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "CI key" }),
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as ApiKeyCreateResponse
    expect(created.plaintext.startsWith("rsk_live_")).toBe(true)
    expect(created.plaintext.length).toBeGreaterThan(20)
    expect(created.prefix).toBe("rsk_live_")
    expect(created.last4).toHaveLength(4)

    const listRes = await SELF.fetch(`${BASE}/api/keys`, { headers: { Cookie: cookie } })
    const list = (await listRes.json()) as ApiKeyListResponse
    expect(list.items).toHaveLength(1)
    expect(list.items[0]!.name).toBe("CI key")
    expect(list.items[0]).not.toHaveProperty("plaintext")
    expect(list.items[0]).not.toHaveProperty("hash")
  })

  it("rejects empty name with 400", async () => {
    const { cookie } = await signInAs("empty@test.local")
    const res = await SELF.fetch(`${BASE}/api/keys`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    })
    expect(res.status).toBe(400)
  })

  it("rejects name > 100 chars with 400", async () => {
    const { cookie } = await signInAs("long@test.local")
    const res = await SELF.fetch(`${BASE}/api/keys`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(101) }),
    })
    expect(res.status).toBe(400)
  })

  it("rejects unauthenticated create with 401", async () => {
    const res = await SELF.fetch(`${BASE}/api/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    })
    expect(res.status).toBe(401)
  })
})

describe("workspace isolation", () => {
  it("workspace A cannot see workspace B's keys", async () => {
    const a = await signInAs("a@test.local")
    const b = await signInAs("b@test.local")

    const createInB = await SELF.fetch(`${BASE}/api/keys`, {
      method: "POST",
      headers: { Cookie: b.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "b-key" }),
    })
    expect(createInB.status).toBe(201)

    const aList = await SELF.fetch(`${BASE}/api/keys`, { headers: { Cookie: a.cookie } })
    const aBody = (await aList.json()) as ApiKeyListResponse
    expect(aBody.items).toHaveLength(0)
  })

  it("deleting a key from another workspace returns 404 (no existence leak)", async () => {
    const a = await signInAs("aa@test.local")
    const b = await signInAs("bb@test.local")

    const createInB = await SELF.fetch(`${BASE}/api/keys`, {
      method: "POST",
      headers: { Cookie: b.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bkey" }),
    })
    const bKey = (await createInB.json()) as ApiKeyCreateResponse

    const aDelete = await SELF.fetch(`${BASE}/api/keys/${bKey.id}`, {
      method: "DELETE",
      headers: { Cookie: a.cookie },
    })
    expect(aDelete.status).toBe(404)
  })
})

describe("DELETE /api/keys/:id (revoke)", () => {
  it("revokes the key and idempotent on second call", async () => {
    const { cookie } = await signInAs("rev@test.local")
    const create = await SELF.fetch(`${BASE}/api/keys`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "to-revoke" }),
    })
    const key = (await create.json()) as ApiKeyCreateResponse

    const r1 = await SELF.fetch(`${BASE}/api/keys/${key.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    })
    expect(r1.status).toBe(204)
    const r2 = await SELF.fetch(`${BASE}/api/keys/${key.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    })
    expect(r2.status).toBe(204)

    const list = await SELF.fetch(`${BASE}/api/keys`, { headers: { Cookie: cookie } })
    const body = (await list.json()) as ApiKeyListResponse
    expect(body.items[0]!.revokedAt).toBeTruthy()
  })
})

describe("requireApiKeyUser middleware", () => {
  // Build a tiny app wrapping the middleware so we can test it at HTTP level
  // without polluting production routes. Unit 5's ingest routes will wire the
  // real integration.
  function testApp() {
    const app = new Hono<{ Bindings: typeof env }>()
    app.use("*", requireApiKeyUser)
    app.get("/whoami", (c) => c.json(c.var.user))
    return app
  }

  it("valid bearer populates c.var.user with workspaceId", async () => {
    const db = createDb(env)
    const [user] = await db.insert(users).values({ email: "owner@t.local" }).returning()
    const [workspace] = await db
      .insert(workspaces)
      .values({ ownerUserId: user!.id, name: "owner's workspace" })
      .returning()
    const generated = await generateApiKey()
    await db.insert(apiKeys).values({
      workspaceId: workspace!.id,
      name: "bearer test",
      prefix: generated.prefix,
      last4: generated.last4,
      hash: generated.hash,
    })

    const ctx = createExecutionContext()
    const res = await testApp().fetch(
      new Request("https://t/whoami", {
        headers: { Authorization: `Bearer ${generated.plaintext}` },
      }),
      env,
      ctx,
    )
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { kind: string; workspaceId: string }
    expect(body.kind).toBe("apikey")
    expect(body.workspaceId).toBe(workspace!.id)
  })

  it("revoked bearer returns 401", async () => {
    const db = createDb(env)
    const [user] = await db.insert(users).values({ email: "revoked@t.local" }).returning()
    const [workspace] = await db
      .insert(workspaces)
      .values({ ownerUserId: user!.id, name: "ws" })
      .returning()
    const generated = await generateApiKey()
    await db.insert(apiKeys).values({
      workspaceId: workspace!.id,
      name: "revoked",
      prefix: generated.prefix,
      last4: generated.last4,
      hash: generated.hash,
      revokedAt: new Date(),
    })
    const ctx = createExecutionContext()
    const res = await testApp().fetch(
      new Request("https://t/whoami", {
        headers: { Authorization: `Bearer ${generated.plaintext}` },
      }),
      env,
      ctx,
    )
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(401)
  })

  it("malformed Authorization header returns 401", async () => {
    const ctx1 = createExecutionContext()
    const res = await testApp().fetch(
      new Request("https://t/whoami", { headers: { Authorization: "Basic x" } }),
      env,
      ctx1,
    )
    await waitOnExecutionContext(ctx1)
    expect(res.status).toBe(401)
  })

  it("cookie on an ingest route returns 401 (not accepted)", async () => {
    const { cookie } = await signInAs("nocookie@t.local")
    const ctx = createExecutionContext()
    const res = await testApp().fetch(
      new Request("https://t/whoami", { headers: { Cookie: cookie } }),
      env,
      ctx,
    )
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(401)
  })

  it("unknown bearer returns 401", async () => {
    const ctx = createExecutionContext()
    const res = await testApp().fetch(
      new Request("https://t/whoami", {
        headers: { Authorization: "Bearer rsk_live_totally_bogus_token_value" },
      }),
      env,
      ctx,
    )
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(401)
  })

  it("updates api_keys.last_used_at after a successful request", async () => {
    const db = createDb(env)
    const [user] = await db.insert(users).values({ email: "tick@t.local" }).returning()
    const [workspace] = await db
      .insert(workspaces)
      .values({ ownerUserId: user!.id, name: "ws" })
      .returning()
    const generated = await generateApiKey()
    const [apiKeyRow] = await db
      .insert(apiKeys)
      .values({
        workspaceId: workspace!.id,
        name: "tick",
        prefix: generated.prefix,
        last4: generated.last4,
        hash: generated.hash,
      })
      .returning()
    expect(apiKeyRow!.lastUsedAt).toBeNull()

    const ctx = createExecutionContext()
    const res = await testApp().fetch(
      new Request("https://t/whoami", {
        headers: { Authorization: `Bearer ${generated.plaintext}` },
      }),
      env,
      ctx,
    )
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)

    // waitUntil runs asynchronously — give it a tick to settle.
    await new Promise((r) => setTimeout(r, 20))

    const [refreshed] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, apiKeyRow!.id))
    expect(refreshed!.lastUsedAt).not.toBeNull()
  })
})

describe("cookie and bearer shape parity", () => {
  it("both middlewares expose workspaceId via c.var.user", async () => {
    // Cookie side.
    const { cookie, workspaceId } = await signInAs("parity@t.local")
    const fromCookie = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })
    const me = (await fromCookie.json()) as { workspaceId: string }
    expect(me.workspaceId).toBe(workspaceId)

    // Bearer side — create a key, then use it to hit a test probe.
    const createRes = await SELF.fetch(`${BASE}/api/keys`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "parity" }),
    })
    const created = (await createRes.json()) as ApiKeyCreateResponse

    const app = new Hono<{ Bindings: typeof env }>()
    app.use("*", requireApiKeyUser)
    app.get("/workspaceId", (c) => c.json({ workspaceId: c.var.user.workspaceId }))

    const ctx = createExecutionContext()
    const res = await app.fetch(
      new Request("https://t/workspaceId", {
        headers: { Authorization: `Bearer ${created.plaintext}` },
      }),
      env,
      ctx,
    )
    await waitOnExecutionContext(ctx)
    const body = (await res.json()) as { workspaceId: string }
    expect(body.workspaceId).toBe(workspaceId)
  })
})
