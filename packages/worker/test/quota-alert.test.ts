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
  auditLog,
  dailyQuota,
  sessionBatches,
  telemetrySessions,
  users,
  workspaceMembers,
  workspaces,
} from "../src/db/schema"
import type { CreateSessionRequest, TelemetryEntryRequest } from "../src/dto"
import { CAP_BYTES, toUtcDateString } from "../src/quota/daily-quota"

const BASE = "https://ravenscope.test"
// Must match vitest.config.ts bindings.OPERATOR_EMAIL — miniflare resolves
// bindings at isolate init, so we can't override per-test.
const OPERATOR_ADDR = "operator@test.local"

async function wipeAll() {
  const db = createDb(env)
  await db.delete(auditLog)
  await db.delete(sessionBatches)
  await db.delete(telemetrySessions)
  await db.delete(apiKeys)
  await db.delete(workspaceMembers)
  await db.delete(workspaces)
  await db.delete(users)
  await db.delete(dailyQuota)
  const list = await env.BLOBS.list()
  for (const o of list.objects) await env.BLOBS.delete(o.key)
}

async function seedBearer(): Promise<{ bearer: string; workspaceId: string }> {
  const db = createDb(env)
  const [user] = await db
    .insert(users)
    .values({ email: `alert-${crypto.randomUUID()}@test.local` })
    .returning()
  const [workspace] = await db.insert(workspaces).values({ name: "alert-ws" }).returning()
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: workspace!.id, userId: user!.id, role: "owner" })
  const generated = await generateApiKey()
  await db.insert(apiKeys).values({
    workspaceId: workspace!.id,
    name: "test",
    prefix: generated.prefix,
    last4: generated.last4,
    hash: generated.hash,
  })
  return { bearer: `Bearer ${generated.plaintext}`, workspaceId: workspace!.id }
}

async function createSession(bearer: string, sessionId: string): Promise<void> {
  const body: CreateSessionRequest = {
    sessionId,
    teamNumber: 1310,
    robotIp: "10.13.10.2",
    startedAt: new Date().toISOString(),
  }
  const r = await SELF.fetch(`${BASE}/api/telemetry/session`, {
    method: "POST",
    headers: { Authorization: bearer, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  expect(r.status).toBe(200)
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

async function seedQuota(counts: {
  bytes?: number
  classA?: number
  classB?: number
  alertedBytes?: boolean
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
      alertedBytes: counts.alertedBytes ? 1 : 0,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: dailyQuota.date,
      set: {
        bytesUploaded: counts.bytes ?? 0,
        classAOps: counts.classA ?? 0,
        classBOps: counts.classB ?? 0,
        alertedBytes: counts.alertedBytes ? 1 : 0,
        updatedAt: new Date(),
      },
    })
}

interface CapturedEmail {
  to: string[]
  subject: string
  text: string
}

function captureAlert(): Promise<CapturedEmail> {
  return new Promise((resolve) => {
    fetchMock
      .get("https://api.resend.com")
      .intercept({ path: "/emails", method: "POST" })
      .reply((req) => {
        const body = JSON.parse(String(req.body)) as CapturedEmail
        resolve(body)
        return { statusCode: 200, data: { id: "captured" } }
      })
  })
}

async function waitForAuditLog(
  predicate: (meta: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const db = createDb(env)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.eventType} = 'quota_cap_hit'`)
    for (const r of rows) {
      if (r.metadataJson) {
        const meta = JSON.parse(r.metadataJson) as Record<string, unknown>
        if (predicate(meta)) return meta
      }
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error("audit_log quota_cap_hit row never appeared")
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
})

afterEach(() => {
  // Every interceptor should have been consumed.
  fetchMock.assertNoPendingInterceptors()
})

describe("operator alert on first cap breach", () => {
  it("sends one email with the right metric/cap/counter on the 0→1 latch flip", async () => {
    const { bearer } = await seedBearer()
    await createSession(bearer, "alert-once")
    await seedQuota({ bytes: CAP_BYTES })

    const capture = captureAlert()
    const res = await SELF.fetch(`${BASE}/api/telemetry/session/alert-once/data`, {
      method: "POST",
      headers: { Authorization: bearer, "Content-Type": "application/json" },
      body: JSON.stringify([makeEntry(1)]),
    })
    expect(res.status).toBe(429)
    const email = await capture
    expect(email.to).toEqual([OPERATOR_ADDR])
    expect(email.subject).toContain("bytes cap hit")
    expect(email.text).toContain("1.00 GiB")
    expect(email.text).toMatch(/All write paths are returning HTTP 429/)
    // Audit log recorded the alert as emailed.
    const meta = await waitForAuditLog(
      (m) => m.metric === "bytes" && m.alertEmailed === true,
    )
    expect(meta.counter).toBeGreaterThan(CAP_BYTES)
  })

  it("does NOT email on a subsequent breach the same day (latch holds)", async () => {
    const { bearer } = await seedBearer()
    await createSession(bearer, "already-alerted")
    // Pre-seed with the latch already flipped.
    await seedQuota({ bytes: CAP_BYTES, alertedBytes: true })

    // No captureAlert() registration — the test asserts no Resend POST
    // fires. fetchMock.assertNoPendingInterceptors() in afterEach would
    // catch a stray interceptor; conversely, an unexpected outbound
    // fetch would error because net connect is disabled.
    const res = await SELF.fetch(
      `${BASE}/api/telemetry/session/already-alerted/data`,
      {
        method: "POST",
        headers: { Authorization: bearer, "Content-Type": "application/json" },
        body: JSON.stringify([makeEntry(2)]),
      },
    )
    expect(res.status).toBe(429)
    // Give any stray waitUntil a moment to run.
    await new Promise((r) => setTimeout(r, 50))
    // No quota_cap_hit audit row (firstBreach = false → scheduleAlertAndAudit short-circuits).
    const db = createDb(env)
    const rows = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.eventType} = 'quota_cap_hit'`)
    expect(rows.length).toBe(0)
  })

  it("Resend 500 on the alert fires three attempts and audit logs alertEmailed=false", async () => {
    const { bearer } = await seedBearer()
    await createSession(bearer, "resend-fail")
    await seedQuota({ bytes: CAP_BYTES })

    fetchMock
      .get("https://api.resend.com")
      .intercept({ path: "/emails", method: "POST" })
      .reply(500, "server error")
      .times(3)

    const res = await SELF.fetch(`${BASE}/api/telemetry/session/resend-fail/data`, {
      method: "POST",
      headers: { Authorization: bearer, "Content-Type": "application/json" },
      body: JSON.stringify([makeEntry(4)]),
    })
    // 429 fires immediately — the Resend outage is absorbed by ctx.waitUntil.
    expect(res.status).toBe(429)
    const meta = await waitForAuditLog(
      (m) => m.metric === "bytes" && m.alertEmailed === false,
    )
    expect(String(meta.alertSkipped)).toMatch(/^resend-/)
  })
})
