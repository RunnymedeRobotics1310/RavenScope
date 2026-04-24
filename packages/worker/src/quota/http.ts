import { sql } from "drizzle-orm"
import type { Context } from "hono"
import { logAudit } from "../audit/log"
import { sendOperatorAlert } from "../auth/email"
import { createDb } from "../db/client"
import { dailyQuota } from "../db/schema"
import type { Env } from "../env"
import { caps, QuotaExceededError, toUtcDateString } from "./daily-quota"

/**
 * 429 Too Many Requests with Retry-After + a plain-text body naming the
 * cap that was hit. Internal to this module; routes go through
 * `handleQuotaExceeded`.
 */
function cappedResponse(err: QuotaExceededError): Response {
  return new Response(`quota_cap_hit: ${err.metric}`, {
    status: 429,
    headers: {
      "Retry-After": String(err.retryAfter),
      "Content-Type": "text/plain; charset=utf-8",
    },
  })
}

/**
 * Single entry point for routes that catch QuotaExceededError:
 *   - Returns a 429 via cappedResponse
 *   - On firstBreach, schedules the audit_log quota_cap_hit row and (if
 *     OPERATOR_EMAIL is set) the Resend alert via ctx.waitUntil so the
 *     429 response isn't delayed by the email send.
 *
 * Callers pass `workspaceId` when an authenticated workspace is known;
 * DO-path 429s (where the DO ran the charge) re-enter here via
 * `firstBreachFromHeader` below.
 */
export function handleQuotaExceeded(
  c: Context<{ Bindings: Env }>,
  err: QuotaExceededError,
  workspaceId?: string,
): Response {
  scheduleAlertAndAudit(c, err, workspaceId)
  return cappedResponse(err)
}

/**
 * Parse the `X-Quota-First-Breach: <metric>` header the SessionIngestDO
 * sets when its chargeOrThrow fires for the first time today. Returns
 * the metric, or null if absent / unrecognised.
 */
function firstBreachFromHeader(
  res: Response,
): QuotaExceededError["metric"] | null {
  const raw = res.headers.get("X-Quota-First-Breach")
  if (raw === "bytes" || raw === "classA" || raw === "classB") return raw
  return null
}

/**
 * Called by Worker routes when the DO-returned 429 carries the
 * X-Quota-First-Breach header. Reconstructs the metric + retryAfter
 * from the response headers and reads the counter row from D1 keyed on
 * the DO-emitted `X-Quota-Breach-Date` (not `new Date()` — the worker's
 * waitUntil can fire after UTC midnight while the breach row stays
 * keyed to the prior day).
 */
export function scheduleDoAlert(
  c: Context<{ Bindings: Env }>,
  res: Response,
  workspaceId: string | undefined,
): void {
  const metric = firstBreachFromHeader(res)
  if (!metric) return
  const retryAfter = Number(res.headers.get("Retry-After")) || 60
  const breachDate = res.headers.get("X-Quota-Breach-Date") || toUtcDateString(new Date())
  c.executionCtx.waitUntil(
    guardWaitUntil("scheduleDoAlert", async () => {
      const db = createDb(c.env)
      const [row] = await db
        .select()
        .from(dailyQuota)
        .where(sql`${dailyQuota.date} = ${breachDate}`)
        .limit(1)
      const err = new QuotaExceededError(metric, retryAfter, true, {
        date: breachDate,
        bytesUploaded: row?.bytesUploaded ?? 0,
        classAOps: row?.classAOps ?? 0,
        classBOps: row?.classBOps ?? 0,
        alertedBytes: (row?.alertedBytes ?? 0) !== 0,
        alertedClassA: (row?.alertedClassA ?? 0) !== 0,
        alertedClassB: (row?.alertedClassB ?? 0) !== 0,
      })
      await runAlertAndAudit(c, err, workspaceId)
    }),
  )
}

function scheduleAlertAndAudit(
  c: Context<{ Bindings: Env }>,
  err: QuotaExceededError,
  workspaceId?: string,
): void {
  if (!err.firstBreach) return
  c.executionCtx.waitUntil(
    guardWaitUntil("scheduleAlertAndAudit", () => runAlertAndAudit(c, err, workspaceId)),
  )
}

/**
 * Wraps a waitUntil promise with a top-level try/catch so a thrown
 * closure — D1 transient, Resend outage, unexpected bug — surfaces in
 * Wrangler tail via console.error instead of being swallowed silently.
 *
 * The `alerted_*` latch is flipped in the main UPSERT (see
 * `daily-quota.ts`), BEFORE this closure runs. Without this guard a
 * post-latch throw loses the operator email AND the audit_log row for
 * the entire UTC day, with no observability path.
 */
async function guardWaitUntil(
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn()
  } catch (err) {
    console.error(`[quota/${label}] waitUntil task threw:`, err)
  }
}

async function runAlertAndAudit(
  c: Context<{ Bindings: Env }>,
  err: QuotaExceededError,
  workspaceId: string | undefined,
): Promise<void> {
  const env = c.env
  const baseUrl = new URL(c.req.url).origin
  const operatorEmail = env.OPERATOR_EMAIL ?? ""
  const db = createDb(env)
  const emailResult = operatorEmail
    ? await sendOperatorAlert(
        { apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM },
        operatorEmail,
        {
          metric: err.metric,
          cap: caps[err.metric],
          counter: counterFor(err),
          dateUtc: err.row.date,
          retryAfterSeconds: err.retryAfter,
          baseUrl,
        },
      )
    : { ok: false, error: "no_operator_email" as const }
  await logAudit(db, {
    eventType: "quota_cap_hit",
    workspaceId,
    metadata: {
      metric: err.metric,
      cap: caps[err.metric],
      counter: counterFor(err),
      retryAfter: err.retryAfter,
      date: err.row.date,
      alertEmailed: emailResult.ok,
      ...(emailResult.ok ? {} : { alertSkipped: emailResult.error ?? "unknown" }),
    },
  })
}

function counterFor(err: QuotaExceededError): number {
  switch (err.metric) {
    case "bytes":
      return err.row.bytesUploaded
    case "classA":
      return err.row.classAOps
    case "classB":
      return err.row.classBOps
  }
}
