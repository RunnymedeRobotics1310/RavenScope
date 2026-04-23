---
title: "feat: Daily usage caps — bill defense via global quota counter"
type: feat
status: active
date: 2026-04-23
---

# feat: Daily usage caps — bill defense via global quota counter

## Overview

Protects the deployment against runaway Cloudflare bills by tracking total
bytes uploaded + R2 operations per UTC day and refusing further writes once
a cap is hit. Fires a transactional alert email to an operator on the first
cap breach of each day (one email per cap per day, not per request).

Caps are **global per Cloudflare account** (not per workspace) because the
cost meter is per-account at Cloudflare; a per-workspace scheme would
under-protect when multiple workspaces share a deployment.

## Problem Frame

RavenScope lives on Cloudflare free tier (10 GB R2, 1M Class A/mo, 10M
Class B/mo). A stolen API key spamming `POST /data`, or a malfunctioning
robot uploading gigabytes, could rack up charges quickly — every `/data`
batch is one R2 PUT (Class A), and every wpilog generation fires several
more. With no ceiling, a weekend of abuse could push Class A ops past the
1M free tier and into paid territory at $4.50/M.

Observed real-world session sizes are 12–18 MB (not the ~200 KB my earlier
estimate assumed). Even with that correction, normal usage still sits
orders of magnitude below the proposed caps.

## Requirements Trace

- **R1.** Track **compressed bytes stored to R2** per UTC day — this is
  the actual storage-cost driver on Cloudflare's bill. The metric is
  measured at the storage-wrapper layer, AFTER gzip compression (see
  companion plan `2026-04-23-002-feat-compress-r2-blobs-plan`). 1 GiB/day
  of compressed bytes is ~10 GiB/day of real JSONL given empirical ~10×
  ratios.
- **R2.** Track total R2 Class A ops (PUTs, multipart init/part/complete,
  LISTs) per UTC day.
- **R3.** Track total R2 Class B ops (GETs, HEADs) per UTC day.
- **R4.** When any cap is reached, reject further writes with HTTP 429 +
  `Retry-After: <seconds-until-UTC-midnight>`.
- **R5.** On the first cap breach of each day for each metric, send one
  alert email to an operator address configured via the `OPERATOR_EMAIL`
  Worker var. Never send more than one email per metric per day.
- **R6.** Caps reset at UTC midnight automatically (implied by the
  date-keyed counter).

## Scope Boundaries

- **Global caps, not per-workspace.** A per-workspace scheme would add
  future-proofing but would also under-protect today when multiple
  workspaces share the deployment. Revisit if we ever move to a
  multi-tenant billing model.
- **R2 ops only — no D1 or Workers request caps.** D1 writes happen 1:1
  with R2 PUTs on the ingest path, so the Class A cap is an effective
  proxy. Workers free tier is 100k requests/day, which hits R2 caps first
  under any realistic abuse. Adding D1/Workers caps now would be
  premature.
- **Magic-link email send volume is already protected** by the per-IP
  (5/min) and per-email (3/10min) rate limits on `/api/auth/request-link`
  (Unit 3). The daily Resend quota (~100/day free) is reachable only
  through those limits, not the new cap system.
- **No admin UI for current usage.** A future `/admin` or `/usage` page
  would be nice but is out of scope for v1 of this feature. The operator
  email surfaces cap hits; cron logs via Wrangler tail + D1 inspection
  are the fallback for normal monitoring.
- **No exemption mechanism.** When a cap hits, all writes stop until
  midnight UTC. If a legitimate large-session upload needs to proceed
  despite a cap, the operator can either rotate the offending key or
  manually bump the counter in D1 via `wrangler d1 execute`.

### Deferred to Separate Tasks

- Per-workspace caps (requires multi-tenant billing model first).
- In-UI quota meter / admin page.
- Alert channels beyond email (Slack webhook, PagerDuty).

## Context & Research

### Relevant Code and Patterns

- `packages/worker/src/storage/r2.ts` — houses `putBatchJsonl`,
  `streamSessionBatches`, `R2MultipartWpilogWriter`, `deleteObject`.
  These are the exact call sites where Class A/B ops originate.
- `packages/worker/src/routes/telemetry.ts` — ingest routes; the right
  place to enforce the 429 on writes.
- `packages/worker/src/routes/sessions.ts` — the wpilog + tree routes
  trigger Class A/B when regenerating on cache miss. Must participate
  in the check but don't need separate pre-flight guards (the helper
  handles it at the storage layer).
- `packages/worker/src/auth/email.ts` — existing Resend client. Extend
  with `sendOperatorAlert` rather than adding a second email module.
- `packages/worker/src/audit/log.ts` — existing pattern for typed
  audit events. Add a new `quota_cap_hit` event type so cap breaches
  survive in the audit log alongside the email.
- `packages/worker/src/db/schema.ts` — add the new `daily_quota` table
  here.
- `packages/worker/migrations/` — Drizzle emits `0001_*.sql` for this
  change; applied locally via `pnpm db:apply:local` and remotely via
  `wrangler d1 migrations apply DB --remote` (already wired into CI's
  deploy workflow).

### Institutional Learnings

- `docs/plans/2026-04-17-001-feat-ravenscope-greenfield-plan.md` Unit 3
  establishes the pattern for rate-limit DOs + audit-logging breaches.
  The new quota system does not need a DO (see Key Technical Decisions)
  but follows the same "audit-log + email on breach" shape.
- The tree-builder/wire-contract mismatch from Unit 6 taught us to pin
  a canonical field value across producers + consumers. Use the same
  discipline here: "quota cap hit" is a distinct `event_type` with a
  stable enum value, not a free-form string.

### External References

- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- D1 `ON CONFLICT DO UPDATE`: https://www.sqlite.org/lang_upsert.html
  (D1 is SQLite-compatible).

## Key Technical Decisions

- **Counter lives in D1, not a Durable Object.** A single global counter
  keyed by `date` is a cheap D1 UPSERT. A DO would add complexity
  (instance lookup, serialized fetch, multi-counter atomicity) for no
  correctness benefit at this traffic volume. D1's `UPDATE ... SET col
  = col + ?` is atomic at the row level and that's sufficient.
- **Daily UTC partition, not rolling window.** Simpler to reason about,
  matches Cloudflare's own monthly billing boundaries (which are UTC),
  and lets the counter "reset" without any TTL plumbing — old rows stay
  in D1 as a cheap audit trail.
- **Charge at the storage wrapper layer, not route layer.** Every
  `putBatchJsonl` / `env.BLOBS.get` / multipart uploadPart call routes
  through wrapper functions today. Charging inside those wrappers means
  new call sites can't accidentally bypass the quota. Routes only need
  to surface the 429 status when the helper says `ok: false`.
- **Charge BEFORE the R2 call, refund never.** We pre-charge the
  counter, then do the R2 op. On R2 failure, we DON'T decrement — the
  cap is a safety rail, not an accounting ledger. A small number of
  phantom charges is cheaper than a race between refund and concurrent
  writes.
- **Bytes counter charges compressed R2-object size, not request
  Content-Length.** The real bill risk is R2 storage ($/GB-month), not
  wire bytes. Measuring at the storage wrapper means we count what
  actually hit the disk. Consequence: a single-digit-MB compressed
  object can represent tens of MB of raw telemetry — the 1 GiB cap is
  ~10× more generous in wire-byte terms than it looks on paper.
- **One alert email per metric per day.** The counter carries
  `alerted_{bytes,class_a,class_b}` columns that flip from 0 → 1 on the
  first breach. Subsequent breaches log the audit event but don't send
  mail. Rows roll over at UTC midnight so the next day starts fresh.
- **Alerts go via `ctx.waitUntil`.** The email is not on the critical
  path of the 429 response — we send the HTTP error immediately and
  fire the Resend call in the background, so a Resend outage can't
  delay the 429.

## Open Questions

### Resolved During Planning

- Per-workspace or global? → Global, because the Cloudflare cost meter
  is per-account.
- Cap values? → 1 GiB compressed bytes / 5,000 Class A ops / 50,000
  Class B ops, per UTC day. Confirmed by the operator on 2026-04-23.
- "Bytes" means wire bytes or stored bytes? → Stored (compressed) —
  that's what the R2 storage bill is calculated on. Confirmed by the
  operator on 2026-04-23.
- How to communicate cap breach to clients? → HTTP 429 + `Retry-After`
  in seconds until UTC midnight. RavenLink's uploader already backs off
  on 429, so no upstream change needed.
- Counter storage? → D1 table, not DO. See Key Technical Decisions.

### Deferred to Implementation

- Exact column types / indexes on `daily_quota` — Unit 1 finalises the
  Drizzle schema.
- Whether `ctx.waitUntil` should also log a structured event to
  `console.error` for Wrangler tail visibility — Unit 3 decides based
  on what shows up in real alerts.

## Implementation Units

- [x] U1. **daily_quota table + chargeQuota helper**

**Goal:** Add a global per-day counter with atomic UPSERT-and-check
semantics, plus a helper that callers use to pre-charge a specific metric.

**Requirements:** R1, R2, R3, R6.

**Dependencies:** None.

**Files:**
- Create: `packages/worker/src/quota/daily-quota.ts`
- Modify: `packages/worker/src/db/schema.ts` — add `daily_quota` table
- Modify: `packages/worker/migrations/` — regenerate migration
- Test: `packages/worker/src/quota/daily-quota.test.ts`

**Approach:**
- Schema:
  ```
  daily_quota(
    date TEXT PRIMARY KEY,              -- UTC "YYYY-MM-DD"
    bytes_uploaded INTEGER NOT NULL DEFAULT 0,
    class_a_ops INTEGER NOT NULL DEFAULT 0,
    class_b_ops INTEGER NOT NULL DEFAULT 0,
    alerted_bytes INTEGER NOT NULL DEFAULT 0,
    alerted_class_a INTEGER NOT NULL DEFAULT 0,
    alerted_class_b INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )
  ```
- Helper signature:
  ```ts
  type QuotaMetric = "bytes" | "classA" | "classB"
  interface ChargeResult {
    ok: boolean                    // false if any cap is hit AFTER this charge
    hitCap?: QuotaMetric           // which metric hit, if any
    retryAfter?: number            // seconds until next UTC midnight
    firstBreach?: boolean          // true only on the 0 → 1 transition of alerted_*
    row: DailyQuotaRow
  }
  async function chargeQuota(
    env: Env,
    charges: { bytes?: number; classA?: number; classB?: number },
  ): Promise<ChargeResult>
  ```
- Caps exposed as exported constants (not env vars) for v1 — simple,
  changeable via code review + redeploy. Can be lifted to env later.
  ```ts
  export const CAP_BYTES = 1024 * 1024 * 1024      // 1 GiB
  export const CAP_CLASS_A = 5000
  export const CAP_CLASS_B = 50_000
  ```
- Implementation:
  1. Compute `today = YYYY-MM-DD` in UTC.
  2. UPSERT into `daily_quota` incrementing each requested metric by the
     charge amount. D1's `ON CONFLICT DO UPDATE SET col = col + excluded.col`
     is atomic at the row level.
  3. SELECT the row back (same db.batch to ensure consistency). Compare
     each counter against the cap.
  4. If any cap is now exceeded AND the matching `alerted_*` is 0, set
     it to 1 in an additional UPDATE and mark `firstBreach: true`. Return
     `{ok: false, hitCap, retryAfter, firstBreach: true, row}`.
  5. If a cap is already exceeded but `alerted_*` is already 1, return
     `{ok: false, firstBreach: false}`.
  6. `retryAfter` = `Math.ceil((nextUtcMidnight - now) / 1000)`.

**Patterns to follow:**
- `packages/worker/src/auth/rate-limit.ts` for the atomic-increment +
  check pattern, though this one uses D1 not a DO.
- `packages/worker/src/db/schema.ts` Drizzle table definitions + UTC-ms
  timestamp columns.

**Test scenarios:**
- Happy path — empty table, charge 100 bytes + 1 Class A → row exists
  with those counters, `ok: true`, `firstBreach: undefined`.
- Happy path — existing row, charge adds atomically. Two concurrent
  charges produce the sum.
- Edge case — charge that crosses the bytes cap returns `ok: false,
  hitCap: "bytes", firstBreach: true`, sets `alerted_bytes = 1`.
- Edge case — subsequent charge on a cap that's already alerted returns
  `ok: false, firstBreach: false` and does not flip alerted_* again.
- Edge case — charge crossing multiple caps simultaneously returns the
  highest-priority metric (bytes > classA > classB — document the
  ordering in the helper).
- Edge case — charge of 0 across all metrics is a no-op (short-circuits
  without a DB write).
- Edge case — retryAfter for a call at 23:59:30 UTC returns 30 (not
  86400).
- Edge case — UTC rollover: a row dated 2026-04-23 exists; a charge
  on 2026-04-24 creates a new row without reading the prior day's
  values. Both rows coexist.

**Verification:** daily-quota test suite green; inserting rows via
`wrangler d1 execute --local` matches what the helper produced.

---

- [x] U2. **Wire chargeQuota into storage + ingest paths; surface 429**

**Goal:** Every R2 op that writes data (Class A) or reads data (Class B)
routes through the quota helper; the ingest route translates a cap miss
into an HTTP 429 with `Retry-After`.

**Requirements:** R1, R2, R3, R4.

**Dependencies:** U1.

**Files:**
- Modify: `packages/worker/src/storage/r2.ts` — instrument every call
  site (put, list, multipart init/uploadPart/complete, delete), plus
  the stream-through-R2-GETs path
- Modify: `packages/worker/src/routes/telemetry.ts` — check charge on
  `/data`, return 429 with `Retry-After` when `ok: false`
- Modify: `packages/worker/src/routes/sessions.ts` — same for wpilog
  regen + tree rebuild
- Modify: `packages/worker/src/ingest-do/session-ingest-do.ts` — the DO
  fires charges on R2 ops it performs
- Modify: `packages/worker/src/audit/log.ts` — add `quota_cap_hit`
  event type
- Test: `packages/worker/test/quota-enforcement.test.ts`

**Approach:**
- Counter charges (measured at the storage wrapper layer, after
  compression where applicable):
  - `putBatchJsonl(...)` → `chargeQuota({bytes: compressed.length,
    classA: 1})` — the bytes charge reflects what actually got PUT.
  - `env.BLOBS.get(...)` via `streamSessionBatches` → `chargeQuota(
    {classB: 1})` per object fetched (no bytes charge — reads don't
    grow storage)
  - `env.BLOBS.list(...)` → `chargeQuota({classA: 1})`
  - `env.BLOBS.delete(...)` → `chargeQuota({classA: 1})`
  - `R2MultipartWpilogWriter.init` → 1 Class A; each `uploadPart`
    → 1 Class A + bytes = part-length (post-compress); `complete`
    → 1 Class A
- Ingest route behaviour on `ok: false`:
  - Return 429 with `Retry-After: <seconds>` header.
  - Do NOT write to R2 (the helper already pre-charged, but the R2 PUT
    is gated on the check).
  - Audit-log one `quota_cap_hit` event via `ctx.waitUntil`, with
    metadata `{metric, cap, counter, retryAfter}`.
- Read-path behaviour on `ok: false`:
  - Tree/wpilog GET also returns 429 when Class A is exhausted AND the
    call would trigger a regeneration (not on cache-hit reads).
  - When Class B is exhausted, even cache-hit reads return 429 — this
    is the only defense against a compromised cookie replaying GETs.
- Short-circuit the charge on zero-value ops (empty body, empty list).

**Execution note:** Test-first on the helper signature; write the
ingest-returns-429 test before wiring it into the route so red-then-
green is clean.

**Test scenarios:**
- Happy path — `/data` with normal batch still returns 200; counters
  increment; sessionBatches row exists.
- Happy path — several calls within cap all succeed; final counter
  matches sum of bodies + ops.
- Error path — `/data` when bytes cap is exhausted returns 429 with
  a sane `Retry-After` header.
- Error path — `/wpilog` regen when Class A is exhausted returns 429;
  the stale cached wpilog from a prior day is NOT served (the cache
  gate already handles freshness; the 429 fires BEFORE that check so
  the user learns they're rate-limited rather than getting confusingly
  stale data).
- Error path — `/wpilog` cache-hit read when Class B is exhausted
  returns 429 (reads are capped too).
- Integration — `/data` that crosses the cap mid-batch: the PRE-charge
  happens first, so either the whole batch is accepted or it's 429'd;
  no partial writes. Idempotent retry after cap resets at midnight.
- Integration — an audit_log row is written for each distinct cap breach,
  with `event_type: "quota_cap_hit"` and the metric in metadata.
- Edge case — zero-byte empty array POST to `/data` returns 200 and
  does NOT charge the counter (entries.length === 0).
- Edge case — `Retry-After` is always > 0 and ≤ 86400.

**Verification:** test suite green; manual check with a temporarily
lowered cap (e.g. `CAP_BYTES = 100`) reproduces the 429 flow end-to-end.

---

- [x] U3. **OPERATOR_EMAIL var + alert email on first breach**

**Goal:** On the 0 → 1 transition of any `alerted_*` flag, send one
transactional email to `OPERATOR_EMAIL` with the metric, cap value,
current counter, and guidance on what to do.

**Requirements:** R5.

**Dependencies:** U1, U2.

**Files:**
- Modify: `packages/worker/src/auth/email.ts` — add `sendOperatorAlert`
- Modify: `packages/worker/src/env.ts` — add `OPERATOR_EMAIL: string`
- Modify: `packages/worker/wrangler.toml` — `[vars] OPERATOR_EMAIL =
  "jeff@zakr.ca"`
- Modify: `packages/worker/src/quota/daily-quota.ts` — fire alert via
  `ctx.waitUntil` when `firstBreach: true`
- Modify: `packages/worker/.dev.vars.example` — add `OPERATOR_EMAIL=`
  with a comment
- Test: `packages/worker/src/quota/alert.test.ts`

**Approach:**
- Email template (plain text, no HTML — matches the magic-link email
  style for Gmail deliverability):
  ```
  Subject: RavenScope: daily {metric} cap hit

  The {metric} cap was reached on {date} UTC.

    Cap:     {cap_formatted}
    Used:    {counter_formatted}
    Reset:   {next_midnight_utc}

  All write paths are returning HTTP 429 until UTC midnight.

  If this was a legitimate spike, no action needed — the counter resets
  automatically. If you suspect abuse, check audit_log for recent
  key_use events and revoke any suspicious API keys at
  {base_url}/keys.

  — RavenScope
  ```
- `{base_url}` comes from the request's `c.req.url` origin, passed
  into the quota helper via the env.
- `sendOperatorAlert(env, alert)` reuses the existing Resend client
  infrastructure (same 3-attempt backoff, same error mapping).
- Alert is fired via `ctx.waitUntil` so the 429 response doesn't wait
  on Resend. A Resend outage does NOT prevent the 429.
- The `alerted_*` flag is set BEFORE the email is queued, atomically
  with the charge. If the email send fails, the flag stays set; the
  audit_log captures the attempted send. Operator can grep logs.

**Test scenarios:**
- Happy path — first cap breach sends one email with the right metric
  + counter + cap in the body (test via fetchMock against Resend).
- Edge case — second cap breach on the same day does NOT send an email
  (alerted_* already 1).
- Edge case — breach on day N+1 sends a new email (new row, fresh
  alerted_* = 0).
- Edge case — breach on two metrics on the same day sends TWO emails
  (one per metric).
- Error path — Resend API 500 on the alert doesn't block the 429
  response or the chargeQuota return value. audit_log records the
  failure with `metadata: {email_send_failed: true}`.
- Edge case — `OPERATOR_EMAIL` unset (empty string): alert is skipped
  silently, audit_log records `alert_skipped: no_operator_email`.
  429 still fires normally.

**Verification:** test suite green; with a temporarily lowered cap and
a real Resend key, sending an email to a test inbox reproduces the
template exactly.

---

## System-Wide Impact

- **Interaction graph:** Every R2 op now flows through `chargeQuota`.
  Wrapper functions in `storage/r2.ts` become the single source of
  truth for charging; new call sites can't bypass them.
- **Error propagation:** 429 travels back through the same path as
  the existing 503 on R2/D1 failures (Worker → DO-fetch → ingest route
  → HTTP). RavenLink's backoff already handles both.
- **State lifecycle:** Quota rows accumulate one per UTC day and are
  never deleted. At 5 bytes counters + 3 flag bytes per row, 365
  rows/year = trivial storage. No cleanup job needed.
- **API surface parity:** No change to public wire contracts.
  RavenLink sees 429 instead of 200 when caps hit; existing behaviour
  (JSON body, `Retry-After` header) already works.
- **Unchanged invariants:** The atomic-D1-batch semantics of the
  `/data` path (session_batches insert + telemetry_sessions update)
  remain; charges happen BEFORE this batch and are separate writes.
  A charge that succeeds followed by a db.batch failure leaves the
  counter slightly over the real op count — acceptable because the
  cap is a safety ceiling, not a ledger.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Pre-charge without matching R2 success drifts the counter over reality | Acceptable: the cap is a ceiling, not accounting. Drift can only cause us to hit 429 slightly earlier than strictly needed. |
| Operator ignores the email, counter resets, abuse resumes next day | One email per metric per day is a tradeoff against spam. If an operator is non-responsive, the cap itself prevents unbounded spend — worst case is one day's worth of the cap pinned at $≤5. Document in README. |
| `chargeQuota` itself becomes a hot path and saturates D1 writes | D1 writes are cheap (100k free/day). One charge per /data or /wpilog call is well below the ceiling. If it ever becomes an issue, collapse multiple charges within a single request into one UPSERT. |
| Resend outage prevents the alert email but the 429 still fires | Accepted. The 429 is the hard protection; the email is a courtesy notification. audit_log captures the send failure. |
| Per-row UPSERT contention under concurrent requests | D1 serializes at the row level. At the volumes we're talking about (hundreds of /data calls/day normal, low thousands even under abuse), contention is not a concern. |

## Documentation / Operational Notes

- README — add a new section "Bill defense" describing the caps, the
  email alert, and what to do when an alert fires (check audit_log,
  revoke keys).
- `.dev.vars.example` — document `OPERATOR_EMAIL`.
- `scripts/setup.sh` — prompt for `OPERATOR_EMAIL` during bootstrap
  (follows the same pattern as `EMAIL_FROM`).

## Sources & References

- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Resend send API: https://resend.com/docs/api-reference/emails/send-email
- Related code: `packages/worker/src/storage/r2.ts`,
  `packages/worker/src/routes/telemetry.ts`,
  `packages/worker/src/audit/log.ts`.
