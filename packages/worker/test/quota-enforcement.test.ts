import { env, fetchMock, SELF } from "cloudflare:test"
import { sql } from "drizzle-orm"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"
import { generateApiKey } from "../src/auth/apikey"
import { createDb } from "../src/db/client"
import {
  apiKeys,
  dailyQuota,
  sessionBatches,
  telemetrySessions,
  users,
  workspaces,
} from "../src/db/schema"
import type { CreateSessionRequest, TelemetryEntryRequest } from "../src/dto"
import { CAP_BYTES, CAP_CLASS_A, toUtcDateString } from "../src/quota/daily-quota"

const BASE = "https://ravenscope.test"

async function wipeAll() {
  const db = createDb(env)
  await db.delete(sessionBatches)
  await db.delete(telemetrySessions)
  await db.delete(apiKeys)
  await db.delete(workspaces)
  await db.delete(users)
  await db.delete(dailyQuota)
  const list = await env.BLOBS.list()
  for (const o of list.objects) await env.BLOBS.delete(o.key)
}

async function seedBearer(): Promise<string> {
  const db = createDb(env)
  const [user] = await db
    .insert(users)
    .values({ email: `quota-${crypto.randomUUID()}@test.local` })
    .returning()
  const [workspace] = await db
    .insert(workspaces)
    .values({ ownerUserId: user!.id, name: "quota-ws" })
    .returning()
  const generated = await generateApiKey()
  await db.insert(apiKeys).values({
    workspaceId: workspace!.id,
    name: "test",
    prefix: generated.prefix,
    last4: generated.last4,
    hash: generated.hash,
  })
  return `Bearer ${generated.plaintext}`
}

async function createSession(bearer: string, sessionId: string): Promise<string> {
  const body: CreateSessionRequest = {
    sessionId,
    teamNumber: 1310,
    robotIp: "10.13.10.2",
    startedAt: new Date().toISOString(),
  }
  const res = await SELF.fetch(`${BASE}/api/telemetry/session`, {
    method: "POST",
    headers: { Authorization: bearer, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  const j = (await res.json()) as { id: string }
  return j.id
}

function makeEntry(i: number): TelemetryEntryRequest {
  return {
    ts: new Date().toISOString(),
    entryType: "data",
    ntKey: "/SmartDashboard/Test",
    ntType: "double",
    ntValue: String(i),
  }
}

/** Pre-seed today's daily_quota row with the given counters. */
async function seedQuota(counts: {
  bytes?: number
  classA?: number
  classB?: number
}): Promise<void> {
  const db = createDb(env)
  const today = toUtcDateString(new Date())
  await db
    .insert(dailyQuota)
    .values({
      date: today,
      bytesUploaded: counts.bytes ?? 0,
      classAOps: counts.classA ?? 0,
      classBOps: counts.classB ?? 0,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: dailyQuota.date,
      set: {
        bytesUploaded: counts.bytes ?? 0,
        classAOps: counts.classA ?? 0,
        classBOps: counts.classB ?? 0,
        updatedAt: new Date(),
      },
    })
}

async function readQuota() {
  const db = createDb(env)
  const today = toUtcDateString(new Date())
  const [row] = await db
    .select()
    .from(dailyQuota)
    .where(sql`${dailyQuota.date} = ${today}`)
    .limit(1)
  return row
}

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})

afterAll(() => {
  fetchMock.deactivate()
})

beforeEach(async () => {
  await wipeAll()
  // Each first-breach 429 fires an operator-alert email via ctx.waitUntil.
  // Consume those with a permissive persistent interceptor so the tests
  // focus on the 429 contract, not the email body (see quota-alert.test.ts
  // for dedicated alert coverage).
  fetchMock
    .get("https://api.resend.com")
    .intercept({ path: "/emails", method: "POST" })
    .reply(200, { id: "silenced" })
    .persist()
})

describe("daily quota enforcement on /api/telemetry/{id}/data", () => {
  it("returns 429 with Retry-After when the bytes cap is exhausted", async () => {
    const bearer = await seedBearer()
    await createSession(bearer, "over-bytes")
    // Pre-seed at cap — the next charge will push us over.
    await seedQuota({ bytes: CAP_BYTES })

    const res = await SELF.fetch(`${BASE}/api/telemetry/session/over-bytes/data`, {
      method: "POST",
      headers: { Authorization: bearer, "Content-Type": "application/json" },
      body: JSON.stringify([makeEntry(1)]),
    })
    expect(res.status).toBe(429)
    const retryAfter = Number(res.headers.get("Retry-After"))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(86400)
    const body = await res.text()
    expect(body).toMatch(/^quota_cap_hit: bytes/)

    // No batch row was written, and the alerted_bytes latch was flipped.
    const db = createDb(env)
    const batches = await db.select().from(sessionBatches)
    expect(batches.length).toBe(0)
    const row = await readQuota()
    expect(row!.alertedBytes).toBe(1)
  })

  it("returns 429 when the Class A ops cap is exhausted", async () => {
    const bearer = await seedBearer()
    await createSession(bearer, "over-classA")
    await seedQuota({ classA: CAP_CLASS_A })

    const res = await SELF.fetch(`${BASE}/api/telemetry/session/over-classA/data`, {
      method: "POST",
      headers: { Authorization: bearer, "Content-Type": "application/json" },
      body: JSON.stringify([makeEntry(1)]),
    })
    expect(res.status).toBe(429)
    expect(await res.text()).toMatch(/^quota_cap_hit: classA/)
    const row = await readQuota()
    expect(row!.alertedClassA).toBe(1)
  })

  it("alert latch is one-shot: subsequent 429s do not re-flip alerted_bytes", async () => {
    const bearer = await seedBearer()
    await createSession(bearer, "latch")
    await seedQuota({ bytes: CAP_BYTES })

    const r1 = await SELF.fetch(`${BASE}/api/telemetry/session/latch/data`, {
      method: "POST",
      headers: { Authorization: bearer, "Content-Type": "application/json" },
      body: JSON.stringify([makeEntry(1)]),
    })
    expect(r1.status).toBe(429)
    const rowAfterFirst = await readQuota()
    expect(rowAfterFirst!.alertedBytes).toBe(1)
    const updatedAtFirst = rowAfterFirst!.updatedAt

    // Second call hits the same cap — still 429, but alertedBytes
    // already-1 means no re-flip, and the row's updatedAt should still
    // advance due to the UPSERT increment, not the latch flip.
    const r2 = await SELF.fetch(`${BASE}/api/telemetry/session/latch/data`, {
      method: "POST",
      headers: { Authorization: bearer, "Content-Type": "application/json" },
      body: JSON.stringify([makeEntry(2)]),
    })
    expect(r2.status).toBe(429)
    const rowAfterSecond = await readQuota()
    expect(rowAfterSecond!.alertedBytes).toBe(1)
    expect(rowAfterSecond!.updatedAt.getTime()).toBeGreaterThanOrEqual(
      updatedAtFirst.getTime(),
    )
  })
})
