import { env } from "cloudflare:test"
import { sql } from "drizzle-orm"
import { beforeEach, describe, expect, it } from "vitest"
import { createDb } from "../db/client"
import { dailyQuota } from "../db/schema"
import {
  CAP_BYTES,
  CAP_CLASS_A,
  CAP_CLASS_B,
  chargeQuota,
  secondsUntilUtcMidnight,
  toUtcDateString,
} from "./daily-quota"

async function wipeQuota() {
  const db = createDb(env)
  await db.delete(dailyQuota)
}

async function seedRow(
  date: string,
  patch: Partial<{
    bytesUploaded: number
    classAOps: number
    classBOps: number
    alertedBytes: number
    alertedClassA: number
    alertedClassB: number
  }>,
): Promise<void> {
  const db = createDb(env)
  await db.insert(dailyQuota).values({
    date,
    bytesUploaded: patch.bytesUploaded ?? 0,
    classAOps: patch.classAOps ?? 0,
    classBOps: patch.classBOps ?? 0,
    alertedBytes: patch.alertedBytes ?? 0,
    alertedClassA: patch.alertedClassA ?? 0,
    alertedClassB: patch.alertedClassB ?? 0,
    updatedAt: new Date(),
  })
}

beforeEach(wipeQuota)

describe("toUtcDateString", () => {
  it("formats as YYYY-MM-DD in UTC", () => {
    expect(toUtcDateString(new Date("2026-04-23T17:30:00Z"))).toBe("2026-04-23")
    expect(toUtcDateString(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-31")
    // Pacific-timezone-local 'today' that's 'tomorrow' in UTC:
    expect(toUtcDateString(new Date("2026-04-23T23:30:00-07:00"))).toBe("2026-04-24")
  })
})

describe("secondsUntilUtcMidnight", () => {
  it("returns the number of seconds until the next UTC midnight", () => {
    expect(secondsUntilUtcMidnight(new Date("2026-04-23T23:59:30Z"))).toBe(30)
    expect(secondsUntilUtcMidnight(new Date("2026-04-23T00:00:00Z"))).toBe(86_400)
    expect(secondsUntilUtcMidnight(new Date("2026-04-23T12:00:00Z"))).toBe(43_200)
  })

  it("always returns at least 1", () => {
    // Exactly-at-midnight should give the full next day, not 0.
    expect(secondsUntilUtcMidnight(new Date("2026-04-23T23:59:59.999Z"))).toBeGreaterThanOrEqual(1)
  })
})

describe("chargeQuota — happy path", () => {
  it("inserts a new row when none exists", async () => {
    const result = await chargeQuota(
      env,
      { bytes: 100, classA: 1 },
      new Date("2026-04-23T12:00:00Z"),
    )
    expect(result.ok).toBe(true)
    expect(result.row.date).toBe("2026-04-23")
    expect(result.row.bytesUploaded).toBe(100)
    expect(result.row.classAOps).toBe(1)
  })

  it("increments atomically when the row already exists", async () => {
    const now = new Date("2026-04-23T12:00:00Z")
    await chargeQuota(env, { bytes: 100, classA: 1 }, now)
    await chargeQuota(env, { bytes: 200, classB: 5 }, now)
    const result = await chargeQuota(env, { classA: 2 }, now)
    expect(result.ok).toBe(true)
    expect(result.row.bytesUploaded).toBe(300)
    expect(result.row.classAOps).toBe(3)
    expect(result.row.classBOps).toBe(5)
  })

  it("zero-charge is a no-op (no DB write) but still returns the current row", async () => {
    const db = createDb(env)
    const before = await db.select({ n: sql<number>`COUNT(*)` }).from(dailyQuota)
    await chargeQuota(env, {}, new Date("2026-04-23T12:00:00Z"))
    const after = await db.select({ n: sql<number>`COUNT(*)` }).from(dailyQuota)
    expect(after[0]!.n).toBe(before[0]!.n)
  })

  it("UTC rollover creates a new row without touching the prior day's", async () => {
    const today = new Date("2026-04-23T23:30:00Z")
    const tomorrow = new Date("2026-04-24T00:30:00Z")
    await chargeQuota(env, { bytes: 100 }, today)
    await chargeQuota(env, { bytes: 50 }, tomorrow)
    const db = createDb(env)
    const rows = await db.select().from(dailyQuota)
    expect(rows).toHaveLength(2)
    const t = rows.find((r) => r.date === "2026-04-23")!
    const n = rows.find((r) => r.date === "2026-04-24")!
    expect(t.bytesUploaded).toBe(100)
    expect(n.bytesUploaded).toBe(50)
  })
})

describe("chargeQuota — cap breach", () => {
  const now = new Date("2026-04-23T12:00:00Z")

  it("bytes cap: a charge that crosses returns ok=false, hitCap=bytes, firstBreach=true", async () => {
    await seedRow("2026-04-23", { bytesUploaded: CAP_BYTES - 10 })
    const result = await chargeQuota(env, { bytes: 20 }, now)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.hitCap).toBe("bytes")
    expect(result.firstBreach).toBe(true)
    expect(result.retryAfter).toBeGreaterThan(0)
    expect(result.retryAfter).toBeLessThanOrEqual(86400)
    // alerted_bytes flipped.
    const db = createDb(env)
    const [row] = await db.select().from(dailyQuota)
    expect(row!.alertedBytes).toBe(1)
  })

  it("subsequent breaches don't re-flag firstBreach once alerted_* is set", async () => {
    await seedRow("2026-04-23", {
      bytesUploaded: CAP_BYTES + 500,
      alertedBytes: 1,
    })
    const result = await chargeQuota(env, { bytes: 100 }, now)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.hitCap).toBe("bytes")
    expect(result.firstBreach).toBe(false)
  })

  it("classA priority: bytes hit takes precedence when both are over cap", async () => {
    await seedRow("2026-04-23", {
      bytesUploaded: CAP_BYTES + 500,
      classAOps: CAP_CLASS_A + 100,
    })
    const result = await chargeQuota(env, { bytes: 1, classA: 1 }, now)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.hitCap).toBe("bytes")
  })

  it("classA cap: trips when only classA exceeds", async () => {
    await seedRow("2026-04-23", { classAOps: CAP_CLASS_A })
    const result = await chargeQuota(env, { classA: 1 }, now)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.hitCap).toBe("classA")
    expect(result.firstBreach).toBe(true)
    const db = createDb(env)
    const [row] = await db.select().from(dailyQuota)
    expect(row!.alertedClassA).toBe(1)
    expect(row!.alertedBytes).toBe(0)
  })

  it("classB cap: trips when only classB exceeds", async () => {
    await seedRow("2026-04-23", { classBOps: CAP_CLASS_B })
    const result = await chargeQuota(env, { classB: 1 }, now)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.hitCap).toBe("classB")
    expect(result.firstBreach).toBe(true)
  })

  it("retryAfter near UTC midnight is small and non-zero", async () => {
    await seedRow("2026-04-23", { bytesUploaded: CAP_BYTES + 100 })
    const result = await chargeQuota(
      env,
      { bytes: 10 },
      new Date("2026-04-23T23:59:30Z"),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.retryAfter).toBeLessThanOrEqual(60)
    expect(result.retryAfter).toBeGreaterThan(0)
  })

  it("concurrent racers: only one sees firstBreach=true (F5 regression)", async () => {
    // Pre-seed at cap so the next charge will cross. Fire N concurrent
    // charges through chargeQuota; the UPSERT+SELECT batch must ensure
    // exactly one observes the 0→1 latch flip, even though all of them
    // see 'over cap' in the returned row.
    await seedRow("2026-04-23", { bytesUploaded: CAP_BYTES })
    const N = 10
    const results = await Promise.all(
      Array.from({ length: N }, () => chargeQuota(env, { bytes: 1 }, now)),
    )
    const firstBreaches = results.filter((r) => !r.ok && r.firstBreach)
    const overCap = results.filter((r) => !r.ok)
    expect(overCap.length).toBe(N) // all saw the breach
    expect(firstBreaches.length).toBe(1) // but only one is first
    const db = createDb(env)
    const [row] = await db.select().from(dailyQuota)
    expect(row!.alertedBytes).toBe(1)
    expect(row!.bytesUploaded).toBe(CAP_BYTES + N)
  })
})
