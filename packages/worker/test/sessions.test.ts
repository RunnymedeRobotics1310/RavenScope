import { env, fetchMock, SELF } from "cloudflare:test"
import { and, eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { generateApiKey } from "../src/auth/apikey"
import { createDb } from "../src/db/client"
import {
  apiKeys,
  loginTokens,
  sessionBatches,
  telemetrySessions,
  users,
  workspaces,
} from "../src/db/schema"
import type {
  KeyTreeResponse,
  SessionDetail,
  SessionListResponse,
  TelemetryEntryRequest,
} from "../src/dto"

const BASE = "https://ravenscope.test"

async function wipeDb() {
  const db = createDb(env)
  await db.delete(sessionBatches)
  await db.delete(telemetrySessions)
  await db.delete(apiKeys)
  await db.delete(loginTokens)
  await db.delete(workspaces)
  await db.delete(users)
}

async function wipeR2() {
  const list = await env.BLOBS.list()
  for (const obj of list.objects) await env.BLOBS.delete(obj.key)
}

async function signInAs(email: string): Promise<{ cookie: string; workspaceId: string }> {
  const captured = new Promise<URL>((resolve) => {
    fetchMock
      .get("https://api.resend.com")
      .intercept({ path: "/emails", method: "POST" })
      .reply((req) => {
        const body = JSON.parse(String(req.body)) as { text: string }
        const m = body.text.match(/https?:\/\/\S+/)
        if (!m) throw new Error("no link")
        resolve(new URL(m[0]))
        return { statusCode: 200, data: { id: "fake" } }
      })
  })
  const r1 = await SELF.fetch(`${BASE}/api/auth/request-link`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": `203.0.113.${Math.floor(Math.random() * 200) + 1}`,
    },
    body: JSON.stringify({ email }),
  })
  expect(r1.status).toBe(204)
  const link = await captured
  const r2 = await SELF.fetch(link.toString(), { redirect: "manual" })
  const setCookie = r2.headers.get("Set-Cookie")!
  const m = setCookie.match(/rs_session=([^;]+)/)!
  const cookie = `rs_session=${m[1]}`
  const me = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })
  const meBody = (await me.json()) as { workspaceId: string }
  return { cookie, workspaceId: meBody.workspaceId }
}

/** Create a session row directly in D1. */
async function seedSession(
  workspaceId: string,
  opts: {
    sessionId: string
    startedAt?: Date
    fmsEventName?: string | null
    matchLabel?: string | null
    endedAt?: Date | null
  },
): Promise<string> {
  const db = createDb(env)
  const [row] = await db
    .insert(telemetrySessions)
    .values({
      workspaceId,
      sessionId: opts.sessionId,
      teamNumber: 1310,
      robotIp: "10.13.10.2",
      startedAt: opts.startedAt ?? new Date(),
      endedAt: opts.endedAt ?? null,
      fmsEventName: opts.fmsEventName ?? null,
      matchLabel: opts.matchLabel ?? null,
    })
    .returning()
  return row!.id
}

/** Write a JSONL batch directly to R2 + insert a session_batches row. */
async function seedBatch(
  sessionDbId: string,
  seq: number,
  entries: TelemetryEntryRequest[],
): Promise<void> {
  const body = entries.map((e) => JSON.stringify(e)).join("\n")
  const bytes = new TextEncoder().encode(body)
  const key = `sessions/${sessionDbId}/batch-${seq.toString().padStart(4, "0")}.jsonl`
  await env.BLOBS.put(key, bytes)
  const db = createDb(env)
  await db.insert(sessionBatches).values({
    sessionId: sessionDbId,
    seq,
    byteLength: bytes.length,
    entryCount: entries.length,
    r2Key: key,
  })
  await db
    .update(telemetrySessions)
    .set({ lastBatchAt: new Date(), uploadedCount: entries.length })
    .where(eq(telemetrySessions.id, sessionDbId))
}

function entry(
  ntKey: string,
  ntType: string,
  ts = new Date().toISOString(),
): TelemetryEntryRequest {
  // entryType: "data" matches RavenLink's uploader and RavenBrain's
  // TelemetryApi — it's the canonical wire value for NT data entries.
  return { ts, entryType: "data", ntKey, ntType, ntValue: "1" }
}

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})

beforeEach(async () => {
  await wipeDb()
  await wipeR2()
})

afterEach(() => {
  fetchMock.assertNoPendingInterceptors()
})

afterAll(() => {
  fetchMock.deactivate()
})

/* --- GET /api/sessions (list) -------------------------------------- */

describe("GET /api/sessions — list", () => {
  it("returns only caller's sessions, newest-first by default", async () => {
    const a = await signInAs("a@test.local")
    const b = await signInAs("b@test.local")

    await seedSession(a.workspaceId, {
      sessionId: "a-old",
      startedAt: new Date("2026-04-10T10:00:00Z"),
    })
    await seedSession(a.workspaceId, {
      sessionId: "a-new",
      startedAt: new Date("2026-04-12T10:00:00Z"),
    })
    await seedSession(b.workspaceId, {
      sessionId: "b-hidden",
      startedAt: new Date("2026-04-11T10:00:00Z"),
    })

    const res = await SELF.fetch(`${BASE}/api/sessions`, { headers: { Cookie: a.cookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as SessionListResponse
    expect(body.items.map((i) => i.sessionId)).toEqual(["a-new", "a-old"])
    expect(body.nextCursor).toBeNull()
  })

  it("?q=quals filters case-insensitively on fms_event_name", async () => {
    const a = await signInAs("q@test.local")
    await seedSession(a.workspaceId, { sessionId: "s1", fmsEventName: "Quals Day 1" })
    await seedSession(a.workspaceId, { sessionId: "s2", fmsEventName: "Playoffs" })

    const res = await SELF.fetch(`${BASE}/api/sessions?q=quals`, {
      headers: { Cookie: a.cookie },
    })
    const body = (await res.json()) as SessionListResponse
    expect(body.items.map((i) => i.sessionId)).toEqual(["s1"])
  })

  it("?sort=match_label&order=asc orders by match_label ascending", async () => {
    const a = await signInAs("sort@test.local")
    await seedSession(a.workspaceId, { sessionId: "s1", matchLabel: "Q12" })
    await seedSession(a.workspaceId, { sessionId: "s2", matchLabel: "Q4" })
    await seedSession(a.workspaceId, { sessionId: "s3", matchLabel: "SF1.1" })

    const res = await SELF.fetch(
      `${BASE}/api/sessions?sort=match_label&order=asc`,
      { headers: { Cookie: a.cookie } },
    )
    const body = (await res.json()) as SessionListResponse
    expect(body.items.map((i) => i.matchLabel)).toEqual(["Q12", "Q4", "SF1.1"])
  })

  it("pagination cursor round-trips across pages", async () => {
    const a = await signInAs("page@test.local")
    for (let i = 0; i < 10; i++) {
      await seedSession(a.workspaceId, {
        sessionId: `s${i.toString().padStart(2, "0")}`,
        startedAt: new Date(2026, 3, 1, 10, i, 0),
      })
    }

    const first = await SELF.fetch(`${BASE}/api/sessions?limit=4`, {
      headers: { Cookie: a.cookie },
    })
    const firstBody = (await first.json()) as SessionListResponse
    expect(firstBody.items).toHaveLength(4)
    expect(firstBody.nextCursor).not.toBeNull()

    const second = await SELF.fetch(
      `${BASE}/api/sessions?limit=4&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      { headers: { Cookie: a.cookie } },
    )
    const secondBody = (await second.json()) as SessionListResponse
    expect(secondBody.items).toHaveLength(4)

    const third = await SELF.fetch(
      `${BASE}/api/sessions?limit=4&cursor=${encodeURIComponent(secondBody.nextCursor!)}`,
      { headers: { Cookie: a.cookie } },
    )
    const thirdBody = (await third.json()) as SessionListResponse
    expect(thirdBody.items).toHaveLength(2)
    expect(thirdBody.nextCursor).toBeNull()

    // All session IDs appear exactly once, no duplicates across pages.
    const ids = [...firstBody.items, ...secondBody.items, ...thirdBody.items].map(
      (i) => i.sessionId,
    )
    expect(new Set(ids).size).toBe(10)
  })

  it("rejects invalid sort/order with 400", async () => {
    const { cookie } = await signInAs("bad@test.local")
    const badSort = await SELF.fetch(`${BASE}/api/sessions?sort=foo`, {
      headers: { Cookie: cookie },
    })
    expect(badSort.status).toBe(400)
    const badOrder = await SELF.fetch(`${BASE}/api/sessions?order=sideways`, {
      headers: { Cookie: cookie },
    })
    expect(badOrder.status).toBe(400)
  })

  it("requires cookie auth", async () => {
    const res = await SELF.fetch(`${BASE}/api/sessions`)
    expect(res.status).toBe(401)
  })
})

/* --- GET /api/sessions/:id (detail) -------------------------------- */

describe("GET /api/sessions/:id — detail", () => {
  it("returns full detail including batchCount", async () => {
    const a = await signInAs("d@test.local")
    const id = await seedSession(a.workspaceId, { sessionId: "detail" })
    await seedBatch(id, 1, [entry("/SmartDashboard/Foo", "double")])
    await seedBatch(id, 2, [entry("/SmartDashboard/Bar", "double")])

    const res = await SELF.fetch(`${BASE}/api/sessions/${id}`, {
      headers: { Cookie: a.cookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as SessionDetail
    expect(body.id).toBe(id)
    expect(body.batchCount).toBe(2)
    expect(body.robotIp).toBe("10.13.10.2")
  })

  it("404 for a session in another workspace (no existence leak)", async () => {
    const a = await signInAs("x@test.local")
    const b = await signInAs("y@test.local")
    const id = await seedSession(b.workspaceId, { sessionId: "b-private" })
    const res = await SELF.fetch(`${BASE}/api/sessions/${id}`, {
      headers: { Cookie: a.cookie },
    })
    expect(res.status).toBe(404)
  })
})

/* --- GET /api/sessions/:id/tree ------------------------------------ */

describe("GET /api/sessions/:id/tree", () => {
  it("returns a nested tree with correct top-level and children", async () => {
    const a = await signInAs("t@test.local")
    const id = await seedSession(a.workspaceId, { sessionId: "tree" })
    await seedBatch(id, 1, [
      entry("/SmartDashboard/foo", "double", "2026-04-12T10:00:00.000Z"),
      entry("/SmartDashboard/foo", "double", "2026-04-12T10:00:01.000Z"),
      entry("/SmartDashboard/bar", "string", "2026-04-12T10:00:00.500Z"),
      entry("/Shuffleboard/baz/qux", "boolean", "2026-04-12T10:00:00.750Z"),
    ])

    const res = await SELF.fetch(`${BASE}/api/sessions/${id}/tree`, {
      headers: { Cookie: a.cookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as KeyTreeResponse
    expect(body.nodes.map((n) => n.name)).toEqual(["Shuffleboard", "SmartDashboard"])

    const sd = body.nodes.find((n) => n.name === "SmartDashboard")!
    expect(sd.children.map((c) => c.name)).toEqual(["bar", "foo"])
    const foo = sd.children.find((c) => c.name === "foo")!
    expect(foo.ntType).toBe("double")
    expect(foo.sampleCount).toBe(2)
    expect(foo.firstTs).toBe("2026-04-12T10:00:00.000Z")
    expect(foo.lastTs).toBe("2026-04-12T10:00:01.000Z")

    const sb = body.nodes.find((n) => n.name === "Shuffleboard")!
    expect(sb.children[0]!.name).toBe("baz")
    expect(sb.children[0]!.children[0]!.name).toBe("qux")
    expect(sb.children[0]!.children[0]!.ntType).toBe("boolean")
  })

  it("malformed and empty-key entries counted, not crashing", async () => {
    const a = await signInAs("m@test.local")
    const id = await seedSession(a.workspaceId, { sessionId: "malformed" })
    // Build a batch with a valid entry + an invalid JSON line + an empty-key
    // nt_update. The second and third must be counted as malformed.
    const jsonl = [
      JSON.stringify(entry("/Foo", "double")),
      "{ not valid json",
      // Empty-key data entry: tree-builder should count it as malformed,
      // not a topic. Uses the canonical "data" entryType.
      JSON.stringify({
        ts: new Date().toISOString(),
        entryType: "data",
        ntKey: "/",
        ntType: "double",
        ntValue: "0",
      }),
    ].join("\n")
    const key = `sessions/${id}/batch-0001.jsonl`
    await env.BLOBS.put(key, new TextEncoder().encode(jsonl))
    const db = createDb(env)
    await db.insert(sessionBatches).values({
      sessionId: id,
      seq: 1,
      byteLength: jsonl.length,
      entryCount: 3,
      r2Key: key,
    })
    await db
      .update(telemetrySessions)
      .set({ lastBatchAt: new Date() })
      .where(eq(telemetrySessions.id, id))

    const res = await SELF.fetch(`${BASE}/api/sessions/${id}/tree`, {
      headers: { Cookie: a.cookie },
    })
    const body = (await res.json()) as KeyTreeResponse
    expect(body.totalKeys).toBe(1)
    expect(body.malformedLines).toBe(2)
  })

  it("skips non-data entries (session_start, match_start, etc.)", async () => {
    const a = await signInAs("nd@test.local")
    const id = await seedSession(a.workspaceId, { sessionId: "non-data" })
    await seedBatch(id, 1, [
      { ts: "2026-04-12T10:00:00Z", entryType: "session_start" },
      { ts: "2026-04-12T10:00:01Z", entryType: "match_start" },
      entry("/Only", "double"),
    ])
    const res = await SELF.fetch(`${BASE}/api/sessions/${id}/tree`, {
      headers: { Cookie: a.cookie },
    })
    const body = (await res.json()) as KeyTreeResponse
    expect(body.totalKeys).toBe(1)
    expect(body.nodes[0]!.name).toBe("Only")
  })

  it("empty session (no batches) returns [] nodes, not 404", async () => {
    const a = await signInAs("empty@test.local")
    const id = await seedSession(a.workspaceId, { sessionId: "empty" })
    const res = await SELF.fetch(`${BASE}/api/sessions/${id}/tree`, {
      headers: { Cookie: a.cookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as KeyTreeResponse
    expect(body.nodes).toEqual([])
    expect(body.totalKeys).toBe(0)
  })

  it("serves from cache on second call; rebuilds when stale", async () => {
    const a = await signInAs("cache@test.local")
    const id = await seedSession(a.workspaceId, { sessionId: "cache" })
    await seedBatch(id, 1, [entry("/A", "double")])

    const r1 = await SELF.fetch(`${BASE}/api/sessions/${id}/tree`, {
      headers: { Cookie: a.cookie },
    })
    const b1 = (await r1.json()) as KeyTreeResponse
    expect(b1.totalKeys).toBe(1)

    // Second call with no new batches — identical generatedAt proves the
    // cache was written and served (no rebuild happened).
    const r2 = await SELF.fetch(`${BASE}/api/sessions/${id}/tree`, {
      headers: { Cookie: a.cookie },
    })
    const b2 = (await r2.json()) as KeyTreeResponse
    expect(b2.generatedAt).toBe(b1.generatedAt)

    // Seed a newer batch + force lastBatchAt past the cached generatedAt.
    await seedBatch(id, 2, [entry("/B", "string")])
    const db = createDb(env)
    await db
      .update(telemetrySessions)
      .set({ lastBatchAt: new Date(Date.parse(b1.generatedAt) + 5_000) })
      .where(eq(telemetrySessions.id, id))

    const r3 = await SELF.fetch(`${BASE}/api/sessions/${id}/tree`, {
      headers: { Cookie: a.cookie },
    })
    const b3 = (await r3.json()) as KeyTreeResponse
    expect(b3.totalKeys).toBe(2)
    expect(Date.parse(b3.generatedAt)).toBeGreaterThan(Date.parse(b1.generatedAt))
  })

  it("404 across workspaces", async () => {
    const a = await signInAs("aa@test.local")
    const b = await signInAs("bb@test.local")
    const id = await seedSession(b.workspaceId, { sessionId: "b-secret" })
    const res = await SELF.fetch(`${BASE}/api/sessions/${id}/tree`, {
      headers: { Cookie: a.cookie },
    })
    expect(res.status).toBe(404)
  })
})

/* --- End-to-end integration: ingest → tree reflects keys ----------- */

describe("integration: ingest → tree", () => {
  it("tree returned by /tree matches what was ingested via /api/telemetry", async () => {
    // Sign in as the workspace owner and mint an API key via the /api/keys
    // route — mirrors the real user flow.
    const a = await signInAs("int@test.local")
    const createKey = await SELF.fetch(`${BASE}/api/keys`, {
      method: "POST",
      headers: { Cookie: a.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "integration" }),
    })
    const { plaintext } = (await createKey.json()) as { plaintext: string }
    const bearer = `Bearer ${plaintext}`

    // Create session + post two batches.
    const createSession = await SELF.fetch(`${BASE}/api/telemetry/session`, {
      method: "POST",
      headers: { Authorization: bearer, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "e2e",
        teamNumber: 1310,
        robotIp: "10.13.10.2",
        startedAt: "2026-04-22T17:00:00Z",
      }),
    })
    const session = (await createSession.json()) as { id: string }
    await SELF.fetch(`${BASE}/api/telemetry/session/e2e/data`, {
      method: "POST",
      headers: { Authorization: bearer, "Content-Type": "application/json" },
      body: JSON.stringify([
        entry("/Drive/LeftPos", "double", "2026-04-22T17:00:00.100Z"),
        entry("/Drive/LeftPos", "double", "2026-04-22T17:00:00.200Z"),
        entry("/Drive/RightPos", "double", "2026-04-22T17:00:00.150Z"),
      ]),
    })
    await SELF.fetch(`${BASE}/api/telemetry/session/e2e/data`, {
      method: "POST",
      headers: { Authorization: bearer, "Content-Type": "application/json" },
      body: JSON.stringify([entry("/Arm/Angle", "double")]),
    })

    // Now read the tree via the cookie-authed web route.
    const tree = await SELF.fetch(`${BASE}/api/sessions/${session.id}/tree`, {
      headers: { Cookie: a.cookie },
    })
    const body = (await tree.json()) as KeyTreeResponse
    expect(body.totalKeys).toBe(3)
    const arm = body.nodes.find((n) => n.name === "Arm")!
    expect(arm.children[0]!.name).toBe("Angle")
    const drive = body.nodes.find((n) => n.name === "Drive")!
    expect(drive.children.map((c) => c.name)).toEqual(["LeftPos", "RightPos"])
    const left = drive.children.find((c) => c.name === "LeftPos")!
    expect(left.sampleCount).toBe(2)
  })
})

// Silence unused-import warning for `and` — drizzle barrel re-exports it
// even when a test only uses one helper.
void and
