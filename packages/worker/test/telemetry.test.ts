import { env, SELF } from "cloudflare:test"
import { eq } from "drizzle-orm"
import { beforeEach, describe, expect, it } from "vitest"
import { generateApiKey } from "../src/auth/apikey"
import { createDb } from "../src/db/client"
import {
  apiKeys,
  sessionBatches,
  telemetrySessions,
  users,
  workspaceMembers,
  workspaces,
} from "../src/db/schema"
import { batchKey } from "../src/storage/keys"
import type {
  BatchInsertResult,
  CompleteSessionRequest,
  CreateSessionRequest,
  TelemetryEntryRequest,
  TelemetrySessionResponse,
} from "../src/dto"

const BASE = "https://ravenscope.test"

/** Seed a workspace + API key directly, returning the bearer header value. */
async function seedBearer(): Promise<{
  bearer: string
  workspaceId: string
  apiKeyId: string
}> {
  const db = createDb(env)
  const [user] = await db
    .insert(users)
    .values({ email: `seed-${crypto.randomUUID()}@test.local` })
    .returning()
  const [workspace] = await db.insert(workspaces).values({ name: "seed" }).returning()
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: workspace!.id, userId: user!.id, role: "owner" })
  const generated = await generateApiKey()
  const [key] = await db
    .insert(apiKeys)
    .values({
      workspaceId: workspace!.id,
      name: "test",
      prefix: generated.prefix,
      last4: generated.last4,
      hash: generated.hash,
    })
    .returning()
  return {
    bearer: `Bearer ${generated.plaintext}`,
    workspaceId: workspace!.id,
    apiKeyId: key!.id,
  }
}

async function wipeDb() {
  const db = createDb(env)
  await db.delete(sessionBatches)
  await db.delete(telemetrySessions)
  await db.delete(apiKeys)
  await db.delete(workspaceMembers)
  await db.delete(workspaces)
  await db.delete(users)
}

async function wipeR2() {
  const list = await env.BLOBS.list()
  for (const obj of list.objects) {
    await env.BLOBS.delete(obj.key)
  }
}

function makeEntry(overrides: Partial<TelemetryEntryRequest> = {}): TelemetryEntryRequest {
  // entryType: "data" is the canonical wire value — matches RavenLink's
  // uploader and RavenBrain's TelemetryApi.
  return {
    ts: new Date().toISOString(),
    entryType: "data",
    ntKey: "/SmartDashboard/Test",
    ntType: "double",
    ntValue: "42",
    ...overrides,
  }
}

async function createSession(
  bearer: string,
  sessionId = "session-1",
  startedAt = new Date().toISOString(),
): Promise<TelemetrySessionResponse> {
  const body: CreateSessionRequest = {
    sessionId,
    teamNumber: 1310,
    robotIp: "10.13.10.2",
    startedAt,
  }
  const res = await SELF.fetch(`${BASE}/api/telemetry/session`, {
    method: "POST",
    headers: { Authorization: bearer, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as TelemetrySessionResponse
}

beforeEach(async () => {
  await wipeDb()
  await wipeR2()
})

describe("POST /api/telemetry/session", () => {
  it("creates a new session and returns RavenBrain-shaped response", async () => {
    const { bearer } = await seedBearer()
    const session = await createSession(bearer, "sess-new", "2026-04-12T14:32:00.000Z")
    expect(session.sessionId).toBe("sess-new")
    expect(session.teamNumber).toBe(1310)
    expect(session.startedAt).toBe("2026-04-12T14:32:00.000Z")
    expect(session.entryCount).toBe(0)
    expect(session.uploadedCount).toBe(0)
    expect(session.endedAt).toBeNull()
  })

  it("idempotent: second POST with same sessionId returns the existing row", async () => {
    const { bearer } = await seedBearer()
    const first = await createSession(bearer, "dup-session")
    const second = await createSession(bearer, "dup-session")
    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt)
  })

  it("rejects invalid body with 400", async () => {
    const { bearer } = await seedBearer()
    const res = await SELF.fetch(`${BASE}/api/telemetry/session`, {
      method: "POST",
      headers: { Authorization: bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "x" }),
    })
    expect(res.status).toBe(400)
  })

  it("requires a bearer token (no cookie on telemetry routes)", async () => {
    const res = await SELF.fetch(`${BASE}/api/telemetry/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "x",
        teamNumber: 1,
        robotIp: "x",
        startedAt: new Date().toISOString(),
      }),
    })
    expect(res.status).toBe(401)
  })
})

describe("GET /api/telemetry/session/{sessionId}", () => {
  it("returns the session with current uploadedCount", async () => {
    const { bearer } = await seedBearer()
    await createSession(bearer, "resume-test")
    const res = await SELF.fetch(`${BASE}/api/telemetry/session/resume-test`, {
      headers: { Authorization: bearer },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as TelemetrySessionResponse
    expect(body.uploadedCount).toBe(0)
  })

  it("404 for a session not in caller's workspace (no existence leak)", async () => {
    const a = await seedBearer()
    const b = await seedBearer()
    await createSession(a.bearer, "a-only")
    const res = await SELF.fetch(`${BASE}/api/telemetry/session/a-only`, {
      headers: { Authorization: b.bearer },
    })
    expect(res.status).toBe(404)
  })
})

describe("POST /api/telemetry/session/{sessionId}/data", () => {
  async function postBatch(
    bearer: string,
    sessionId: string,
    entries: TelemetryEntryRequest[],
  ): Promise<Response> {
    return SELF.fetch(`${BASE}/api/telemetry/session/${sessionId}/data`, {
      method: "POST",
      headers: { Authorization: bearer, "Content-Type": "application/json" },
      body: JSON.stringify(entries),
    })
  }

  it("happy path: 3 batches of 500 → entry_count + uploaded_count + 3 R2 objects", async () => {
    const { bearer } = await seedBearer()
    const session = await createSession(bearer, "full-lifecycle")

    const batch = Array.from({ length: 500 }, (_, i) => makeEntry({ ntValue: String(i) }))
    for (let i = 0; i < 3; i++) {
      const res = await postBatch(bearer, "full-lifecycle", batch)
      expect(res.status).toBe(200)
      const body = (await res.json()) as BatchInsertResult
      expect(body.count).toBe(500)
    }

    const completeBody: CompleteSessionRequest = {
      endedAt: new Date().toISOString(),
      entryCount: 1500,
    }
    const completeRes = await SELF.fetch(
      `${BASE}/api/telemetry/session/full-lifecycle/complete`,
      {
        method: "POST",
        headers: { Authorization: bearer, "Content-Type": "application/json" },
        body: JSON.stringify(completeBody),
      },
    )
    expect(completeRes.status).toBe(200)
    const completed = (await completeRes.json()) as TelemetrySessionResponse
    expect(completed.entryCount).toBe(1500)
    expect(completed.uploadedCount).toBe(1500)

    // R2 should contain batch-0001 through batch-0003.
    const listed = await env.BLOBS.list({ prefix: `sessions/${session.id}/` })
    const keys = listed.objects.map((o) => o.key).sort()
    expect(keys).toEqual([
      batchKey(session.id, 1),
      batchKey(session.id, 2),
      batchKey(session.id, 3),
    ])

    // session_batches rows.
    const db = createDb(env)
    const rows = await db
      .select()
      .from(sessionBatches)
      .where(eq(sessionBatches.sessionId, session.id))
    expect(rows).toHaveLength(3)
  })

  it("empty batch returns { count: 0 } and writes no R2 object", async () => {
    const { bearer } = await seedBearer()
    const session = await createSession(bearer, "empty")
    const res = await postBatch(bearer, "empty", [])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ count: 0 })
    const listed = await env.BLOBS.list({ prefix: `sessions/${session.id}/` })
    expect(listed.objects).toHaveLength(0)
  })

  it("resume: GET /session returns uploadedCount matching the sum of posted batches", async () => {
    const { bearer } = await seedBearer()
    await createSession(bearer, "resume")
    await postBatch(bearer, "resume", [makeEntry(), makeEntry()])
    await postBatch(bearer, "resume", [makeEntry()])
    const res = await SELF.fetch(`${BASE}/api/telemetry/session/resume`, {
      headers: { Authorization: bearer },
    })
    const body = (await res.json()) as TelemetrySessionResponse
    expect(body.uploadedCount).toBe(3)
  })

  it("late /data after /complete bumps counters and clears wpilog cache", async () => {
    const { bearer } = await seedBearer()
    const session = await createSession(bearer, "late")
    await postBatch(bearer, "late", [makeEntry()])
    await SELF.fetch(`${BASE}/api/telemetry/session/late/complete`, {
      method: "POST",
      headers: { Authorization: bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ endedAt: new Date().toISOString(), entryCount: 1 }),
    })

    // Pretend a wpilog was cached, then post a late batch.
    const db = createDb(env)
    await db
      .update(telemetrySessions)
      .set({ wpilogKey: "fake-key", wpilogGeneratedAt: new Date() })
      .where(eq(telemetrySessions.id, session.id))

    const late = await postBatch(bearer, "late", [makeEntry()])
    expect(late.status).toBe(200)

    const [row] = await db
      .select()
      .from(telemetrySessions)
      .where(eq(telemetrySessions.id, session.id))
    expect(row!.wpilogKey).toBeNull()
    expect(row!.uploadedCount).toBe(2)
  })

  it("404 when session not in caller's workspace", async () => {
    const a = await seedBearer()
    const b = await seedBearer()
    await createSession(a.bearer, "leak-test")
    const res = await postBatch(b.bearer, "leak-test", [makeEntry()])
    expect(res.status).toBe(404)
  })

  it("rejects non-array body with 400", async () => {
    const { bearer } = await seedBearer()
    await createSession(bearer, "badbody")
    const res = await SELF.fetch(`${BASE}/api/telemetry/session/badbody/data`, {
      method: "POST",
      headers: { Authorization: bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ not: "an array" }),
    })
    expect(res.status).toBe(400)
  })
})

describe("POST /api/telemetry/session/{sessionId}/complete", () => {
  it("idempotent: second call with same endedAt is a no-op", async () => {
    const { bearer } = await seedBearer()
    await createSession(bearer, "idem")
    const endedAt = new Date().toISOString()
    const body: CompleteSessionRequest = { endedAt, entryCount: 0 }
    const r1 = await SELF.fetch(`${BASE}/api/telemetry/session/idem/complete`, {
      method: "POST",
      headers: { Authorization: bearer, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const r2 = await SELF.fetch(`${BASE}/api/telemetry/session/idem/complete`, {
      method: "POST",
      headers: { Authorization: bearer, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    const b1 = (await r1.json()) as TelemetrySessionResponse
    const b2 = (await r2.json()) as TelemetrySessionResponse
    expect(b2.endedAt).toBe(b1.endedAt)
  })

  it("different endedAt on second complete updates and clears wpilog cache", async () => {
    const { bearer } = await seedBearer()
    const created = await createSession(bearer, "re-complete")

    const db = createDb(env)
    await db
      .update(telemetrySessions)
      .set({ wpilogKey: "old", wpilogGeneratedAt: new Date() })
      .where(eq(telemetrySessions.id, created.id))

    await SELF.fetch(`${BASE}/api/telemetry/session/re-complete/complete`, {
      method: "POST",
      headers: { Authorization: bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ endedAt: "2026-04-12T15:00:00.000Z", entryCount: 5 }),
    })
    await SELF.fetch(`${BASE}/api/telemetry/session/re-complete/complete`, {
      method: "POST",
      headers: { Authorization: bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ endedAt: "2026-04-12T15:00:30.000Z", entryCount: 10 }),
    })
    const [row] = await db
      .select()
      .from(telemetrySessions)
      .where(eq(telemetrySessions.id, created.id))
    expect(row!.wpilogKey).toBeNull()
    expect(row!.entryCount).toBe(10)
    expect(row!.endedAt!.toISOString()).toBe("2026-04-12T15:00:30.000Z")
  })
})

describe("concurrency", () => {
  it("two simultaneous /data POSTs for the same session resolve cleanly (seq=N, N+1)", async () => {
    const { bearer } = await seedBearer()
    const session = await createSession(bearer, "concurrent")

    const post = (label: string) =>
      SELF.fetch(`${BASE}/api/telemetry/session/concurrent/data`, {
        method: "POST",
        headers: { Authorization: bearer, "Content-Type": "application/json" },
        body: JSON.stringify([makeEntry({ ntValue: label })]),
      })

    const [r1, r2] = await Promise.all([post("a"), post("b")])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)

    const db = createDb(env)
    const rows = await db
      .select()
      .from(sessionBatches)
      .where(eq(sessionBatches.sessionId, session.id))
    const seqs = rows.map((r) => r.seq).sort()
    expect(seqs).toEqual([1, 2])

    const listed = await env.BLOBS.list({ prefix: `sessions/${session.id}/` })
    expect(listed.objects).toHaveLength(2)
  })

  it("two simultaneous POSTs for DIFFERENT sessions don't block each other", async () => {
    const { bearer } = await seedBearer()
    const s1 = await createSession(bearer, "parallel-1")
    const s2 = await createSession(bearer, "parallel-2")

    const post = (sessionId: string) =>
      SELF.fetch(`${BASE}/api/telemetry/session/${sessionId}/data`, {
        method: "POST",
        headers: { Authorization: bearer, "Content-Type": "application/json" },
        body: JSON.stringify([makeEntry()]),
      })

    const [r1, r2] = await Promise.all([post("parallel-1"), post("parallel-2")])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)

    const listed1 = await env.BLOBS.list({ prefix: `sessions/${s1.id}/` })
    const listed2 = await env.BLOBS.list({ prefix: `sessions/${s2.id}/` })
    expect(listed1.objects).toHaveLength(1)
    expect(listed2.objects).toHaveLength(1)
  })
})
