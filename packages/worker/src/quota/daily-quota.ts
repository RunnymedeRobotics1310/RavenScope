/**
 * Daily usage counter + cap enforcement — global across the deployment
 * (per-Cloudflare-account, not per-workspace). See
 * `docs/plans/2026-04-23-001-feat-daily-usage-caps-plan.md`.
 *
 * Caps are expressed as exported constants so they're diffable in code
 * review. Rolling them to env vars is a deliberate future step; hard-
 * coded is the right granularity for v1.
 *
 *   - CAP_BYTES   — gzip-compressed bytes written to R2 per UTC day
 *   - CAP_CLASS_A — R2 PUT/LIST/multipart ops per UTC day
 *   - CAP_CLASS_B — R2 GET/HEAD ops per UTC day
 *
 * Behaviour on cap hit: caller receives {ok: false, hitCap, retryAfter,
 * firstBreach?} and decides how to surface the 429. Audit logging and
 * operator-email alerts live in the callers (Unit 2 / Unit 3); this
 * module only manages the counter and the alert latch.
 */

import { sql } from "drizzle-orm"
import { createDb, type Db } from "../db/client"
import { dailyQuota } from "../db/schema"
import type { Env } from "../env"

export const CAP_BYTES = 1024 * 1024 * 1024 // 1 GiB compressed bytes / UTC day
export const CAP_CLASS_A = 5_000
export const CAP_CLASS_B = 50_000

export type QuotaMetric = "bytes" | "classA" | "classB"

export interface QuotaCharge {
  bytes?: number
  classA?: number
  classB?: number
}

export interface DailyQuotaRow {
  date: string
  bytesUploaded: number
  classAOps: number
  classBOps: number
  alertedBytes: boolean
  alertedClassA: boolean
  alertedClassB: boolean
}

export type ChargeResult =
  | { ok: true; row: DailyQuotaRow }
  | {
      ok: false
      hitCap: QuotaMetric
      retryAfter: number
      firstBreach: boolean
      row: DailyQuotaRow
    }

/**
 * Atomically UPSERT the counters for today, re-read the row, and check
 * against the caps. If any cap is now exceeded AND the matching
 * `alerted_*` flag was 0, flip it to 1 in-place and mark firstBreach.
 *
 * A zero-valued charge (all three metrics omitted or 0) is a no-op.
 */
export async function chargeQuota(
  env: Env,
  charge: QuotaCharge,
  now: Date = new Date(),
): Promise<ChargeResult> {
  const bytes = charge.bytes ?? 0
  const classA = charge.classA ?? 0
  const classB = charge.classB ?? 0
  const today = toUtcDateString(now)

  if (bytes === 0 && classA === 0 && classB === 0) {
    // No-op short-circuit; still need the current row for callers who
    // care about `ok`.
    const row = await readOrZero(env, today)
    return capCheck(row, 0, 0, 0, now)
  }

  const db = createDb(env)

  // Atomic UPSERT + increment. D1 supports SQLite's ON CONFLICT DO
  // UPDATE. `excluded` refers to the row that would have been inserted.
  await db
    .insert(dailyQuota)
    .values({
      date: today,
      bytesUploaded: bytes,
      classAOps: classA,
      classBOps: classB,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: dailyQuota.date,
      set: {
        bytesUploaded: sql`${dailyQuota.bytesUploaded} + ${bytes}`,
        classAOps: sql`${dailyQuota.classAOps} + ${classA}`,
        classBOps: sql`${dailyQuota.classBOps} + ${classB}`,
        updatedAt: now,
      },
    })

  const row = await readOrZero(env, today)
  const result = capCheck(row, bytes, classA, classB, now)
  if (!result.ok) {
    // Flip the matching alerted_* flag 0→1 if this is the first breach.
    if (result.firstBreach) {
      const field = alertedField(result.hitCap)
      await db
        .update(dailyQuota)
        .set({ [field]: 1, updatedAt: now })
        .where(sql`${dailyQuota.date} = ${today} AND ${dailyQuota[field]} = 0`)
    }
  }
  return result
}

function capCheck(
  row: DailyQuotaRow,
  _bytesCharged: number,
  _classACharged: number,
  _classBCharged: number,
  now: Date,
): ChargeResult {
  // Priority order: bytes > classA > classB. Bytes is the most
  // expensive metric to exceed and the most useful signal to an
  // operator, so it wins when multiple caps trip simultaneously.
  if (row.bytesUploaded > CAP_BYTES) {
    return cappedResult(row, "bytes", !row.alertedBytes, now)
  }
  if (row.classAOps > CAP_CLASS_A) {
    return cappedResult(row, "classA", !row.alertedClassA, now)
  }
  if (row.classBOps > CAP_CLASS_B) {
    return cappedResult(row, "classB", !row.alertedClassB, now)
  }
  return { ok: true, row }
}

function cappedResult(
  row: DailyQuotaRow,
  hitCap: QuotaMetric,
  firstBreach: boolean,
  now: Date,
): ChargeResult {
  return {
    ok: false,
    hitCap,
    retryAfter: secondsUntilUtcMidnight(now),
    firstBreach,
    // Reflect the flip in the returned row so the caller doesn't need
    // to re-read D1 just to know about firstBreach.
    row: firstBreach
      ? { ...row, [alertedField(hitCap)]: true }
      : row,
  }
}

function alertedField(metric: QuotaMetric): "alertedBytes" | "alertedClassA" | "alertedClassB" {
  switch (metric) {
    case "bytes":
      return "alertedBytes"
    case "classA":
      return "alertedClassA"
    case "classB":
      return "alertedClassB"
  }
}

async function readOrZero(env: Env, today: string): Promise<DailyQuotaRow> {
  const db: Db = createDb(env)
  const [row] = await db
    .select()
    .from(dailyQuota)
    .where(sql`${dailyQuota.date} = ${today}`)
    .limit(1)
  if (!row) {
    return {
      date: today,
      bytesUploaded: 0,
      classAOps: 0,
      classBOps: 0,
      alertedBytes: false,
      alertedClassA: false,
      alertedClassB: false,
    }
  }
  return {
    date: row.date,
    bytesUploaded: row.bytesUploaded,
    classAOps: row.classAOps,
    classBOps: row.classBOps,
    alertedBytes: row.alertedBytes !== 0,
    alertedClassA: row.alertedClassA !== 0,
    alertedClassB: row.alertedClassB !== 0,
  }
}

export function toUtcDateString(d: Date): string {
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(d.getUTCDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}`
}

export function secondsUntilUtcMidnight(now: Date): number {
  const tomorrow = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    ),
  )
  return Math.max(1, Math.ceil((tomorrow.getTime() - now.getTime()) / 1000))
}

export const caps = {
  bytes: CAP_BYTES,
  classA: CAP_CLASS_A,
  classB: CAP_CLASS_B,
}

/**
 * Thrown by storage wrappers when a charge would exceed a daily cap.
 * Callers (routes, the SessionIngestDO) catch this and return HTTP 429
 * with Retry-After. firstBreach lets them conditionally fire the
 * operator alert email (plan Unit 3) via ctx.waitUntil.
 */
export class QuotaExceededError extends Error {
  constructor(
    public readonly metric: QuotaMetric,
    public readonly retryAfter: number,
    public readonly firstBreach: boolean,
    public readonly row: DailyQuotaRow,
  ) {
    super(`quota_cap_hit:${metric}`)
    this.name = "QuotaExceededError"
  }
}

/** Convenience: charge, and throw QuotaExceededError if the result is not ok. */
export async function chargeOrThrow(
  env: Env,
  charge: QuotaCharge,
  now: Date = new Date(),
): Promise<DailyQuotaRow> {
  const result = await chargeQuota(env, charge, now)
  if (!result.ok) {
    throw new QuotaExceededError(
      result.hitCap,
      result.retryAfter,
      result.firstBreach,
      result.row,
    )
  }
  return result.row
}
