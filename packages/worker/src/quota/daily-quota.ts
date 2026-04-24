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

// Guard against a misconfigured deploy (e.g. CAP_* accidentally set to 0)
// silently locking every write path behind a 429. A positive-value cap is
// a precondition of the module, checked once at load time.
if (CAP_BYTES <= 0 || CAP_CLASS_A <= 0 || CAP_CLASS_B <= 0) {
  throw new Error(
    `daily-quota: all CAP_* must be > 0 (bytes=${CAP_BYTES}, classA=${CAP_CLASS_A}, classB=${CAP_CLASS_B})`,
  )
}

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
 * Atomically UPSERT today's counters, conditionally flip the
 * `alerted_*` latches in-place, and return whether this call was the
 * first breach per metric.
 *
 * Concurrency model: the whole operation is a single D1 `batch` so the
 * pre-UPDATE snapshot and the UPSERT run in one transaction. D1
 * serializes writes at the database level, so two concurrent racers
 * produce exactly one `firstBreach: true` result — the second racer's
 * pre-snapshot already sees `alerted_* = 1`. This replaces an earlier
 * three-statement pattern (UPSERT, SELECT, UPDATE-where-0) that was
 * racy at the alert layer (review finding F5).
 *
 * A zero-valued charge short-circuits without hitting the database.
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
    // No-op short-circuit; read the current row for callers who care
    // about `ok`.
    const row = await readRow(env, today)
    return capCheck(row, now)
  }

  const db = createDb(env)

  // The UPSERT's ON CONFLICT branch bumps the counters AND flips each
  // alerted_* latch from 0 → 1 exactly when THIS charge pushes the
  // corresponding counter past the cap for the first time. Folding
  // the conditional flip into the same statement as the increment
  // removes the earlier UPDATE-where-0 round-trip (review finding F6)
  // and closes the 0→1 double-email race (review finding F5) because
  // the pre-snapshot SELECT and the UPSERT run inside one db.batch.
  const selectPrev = db
    .select({
      alertedBytes: dailyQuota.alertedBytes,
      alertedClassA: dailyQuota.alertedClassA,
      alertedClassB: dailyQuota.alertedClassB,
    })
    .from(dailyQuota)
    .where(sql`${dailyQuota.date} = ${today}`)

  const upsertReturning = db
    .insert(dailyQuota)
    .values({
      date: today,
      bytesUploaded: bytes,
      classAOps: classA,
      classBOps: classB,
      // On a fresh row, seed alerted_* correctly if this single charge
      // already crosses a cap (edge case: very first charge of the day
      // exceeds CAP).
      alertedBytes: bytes > CAP_BYTES ? 1 : 0,
      alertedClassA: classA > CAP_CLASS_A ? 1 : 0,
      alertedClassB: classB > CAP_CLASS_B ? 1 : 0,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: dailyQuota.date,
      set: {
        bytesUploaded: sql`${dailyQuota.bytesUploaded} + ${bytes}`,
        classAOps: sql`${dailyQuota.classAOps} + ${classA}`,
        classBOps: sql`${dailyQuota.classBOps} + ${classB}`,
        alertedBytes: sql`CASE WHEN ${dailyQuota.bytesUploaded} + ${bytes} > ${CAP_BYTES} AND ${dailyQuota.alertedBytes} = 0 THEN 1 ELSE ${dailyQuota.alertedBytes} END`,
        alertedClassA: sql`CASE WHEN ${dailyQuota.classAOps} + ${classA} > ${CAP_CLASS_A} AND ${dailyQuota.alertedClassA} = 0 THEN 1 ELSE ${dailyQuota.alertedClassA} END`,
        alertedClassB: sql`CASE WHEN ${dailyQuota.classBOps} + ${classB} > ${CAP_CLASS_B} AND ${dailyQuota.alertedClassB} = 0 THEN 1 ELSE ${dailyQuota.alertedClassB} END`,
        updatedAt: now,
      },
    })
    .returning()

  // db.batch runs both statements in one D1 transaction. selectPrev
  // observes the row AS IT WAS before the UPSERT in the same batch.
  const [prevRows, postRows] = await db.batch([selectPrev, upsertReturning])
  const prev = prevRows?.[0] as
    | { alertedBytes: number; alertedClassA: number; alertedClassB: number }
    | undefined
  const post = postRows?.[0] as typeof dailyQuota.$inferSelect | undefined
  if (!post) {
    throw new Error("daily-quota: UPSERT returned no row")
  }
  const row: DailyQuotaRow = {
    date: post.date,
    bytesUploaded: post.bytesUploaded,
    classAOps: post.classAOps,
    classBOps: post.classBOps,
    alertedBytes: post.alertedBytes !== 0,
    alertedClassA: post.alertedClassA !== 0,
    alertedClassB: post.alertedClassB !== 0,
  }
  const firstBreaches = {
    bytes: post.alertedBytes !== 0 && (prev?.alertedBytes ?? 0) === 0,
    classA: post.alertedClassA !== 0 && (prev?.alertedClassA ?? 0) === 0,
    classB: post.alertedClassB !== 0 && (prev?.alertedClassB ?? 0) === 0,
  }
  return capCheck(row, now, firstBreaches)
}

function capCheck(
  row: DailyQuotaRow,
  now: Date,
  firstBreaches: Record<QuotaMetric, boolean> = {
    bytes: false,
    classA: false,
    classB: false,
  },
): ChargeResult {
  // Priority order: bytes > classA > classB. Bytes is the most
  // expensive metric to exceed and the most useful signal to an
  // operator, so it wins when multiple caps trip simultaneously.
  if (row.bytesUploaded > CAP_BYTES) {
    return cappedResult(row, "bytes", firstBreaches.bytes, now)
  }
  if (row.classAOps > CAP_CLASS_A) {
    return cappedResult(row, "classA", firstBreaches.classA, now)
  }
  if (row.classBOps > CAP_CLASS_B) {
    return cappedResult(row, "classB", firstBreaches.classB, now)
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
    row,
  }
}

async function readRow(env: Env, today: string): Promise<DailyQuotaRow> {
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
