---
title: "feat: RavenScope greenfield — stripped-down RavenLink companion on Cloudflare"
type: feat
status: active
date: 2026-04-17
deepened: 2026-04-17
reviewed: 2026-04-17
---

# feat: RavenScope greenfield — stripped-down RavenLink companion on Cloudflare

## Overview

RavenScope is a lightweight alternative data sink for `RavenLink` (see `~/src/1310/RavenLink`), targeted at FRC teams who want a simple hosted telemetry bucket for match data without standing up the full `RavenBrain` stack (Micronaut + MySQL). It runs entirely on Cloudflare: a Hono-based Worker for the API, static Vite/React pages for the UI via Workers Static Assets, D1 for metadata, R2 for raw session blobs + streamed WPILog exports, and a Durable Object per session for serialized ingest. Users sign in with a magic-link email (no passwords) under a single-owner workspace, mint workspace-scoped API keys, upload sessions from RavenLink, browse a session list by event/match, drill into the NT key tree for a given session, and download a `.wpilog` for immediate opening in AdvantageScope.

## Problem Frame

- `RavenBrain` is the canonical destination for RavenLink telemetry, but it is heavy: MySQL, Micronaut, a mentor-hosted server, role-based auth, and a fixed team identity model. Teams that just want "a place for the robot to dump match data for post-match review" have nowhere cheap and easy to point RavenLink at.
- RavenLink's upload protocol (`POST /api/telemetry/session` → batched `/data` → `/complete`) is already well-tested in `~/src/1310/RavenLink/internal/uploader/uploader.go`. An alternative backend should mirror that shape on the wire so teams can retarget with minimal friction.
- RavenLink already knows how to turn JSONL into a `.wpilog` (`~/src/1310/RavenLink/internal/wpilog/`), but that only works locally from the DS laptop's saved files. Once data is uploaded, there is no hosted way to fetch a `.wpilog` — RavenScope should fix that.

### Alternatives considered

- **Extend RavenBrain with a SQLite/embedded profile + one-click Docker deploy.** Rejected: RavenBrain is maintained by a different person (Tony) on a different stack (Java/Micronaut) with its own roadmap; threading a lightweight profile through its role model, FRC-API enrichment, and schema is likely more work than greenfield, and even if it lands the hosting surface (Docker + MySQL or SQLite volume) still asks prospective teams for infra they've already declined. RavenScope's hosted "signup-and-go" model is a product bet that the Cloudflare all-in-one surface is strictly easier than any Docker deploy.
- **Reuse RavenLink's Go WPILog encoder via tinygo → WASM.** Rejected: tinygo Go+WASM artifacts for even small packages typically land at ~800 KB–1.5 MB and incur cold-start compile cost on every isolate spin-up. A TypeScript port of `encoder.go` + `convert.go` is ~500 lines of pure binary encoding, adds ~5 KB to the bundle, and pins byte-compat with a golden-file test. Accepted maintenance tax: one encoder per language; CI guard surfaces drift.
- **Build on RavenBrain's wire protocol but deploy as a Durable-Object-only app (no D1, no R2).** Rejected: DOs are great for serialization but expensive for bulk blob storage; R2 is the natural fit for JSONL/WPILog artifacts.

## Requirements Trace

**Authentication & API keys**
- R1. Self-service sign-in via a single-use magic link emailed to the user's address. First-ever sign-in for a given email creates a user row and an auto-owned workspace.
- R2. Workspace-scoped API keys for programmatic data submission and retrieval (multiple keys per workspace, revocable, last-used tracked, prefix+last4 display).

**Ingest & data**
- R3. Telemetry ingestion protocol compatible with RavenLink's existing uploader: create session, batched data POSTs (idempotent/resumable), complete session.

**User interface**
- R4. Session listing UI: event name + match id + started_at + duration + entries, with search-by-event-name and sortable columns (started/event/match), newest-first default, per-workspace scope.
- R5. Session detail UI: searchable collapsible tree view of all NT keys captured in that session (leaf cards show type · N samples · first–last timestamp range).
- R6. Per-session `.wpilog` export: single-click download from the session detail page via `Content-Disposition: attachment`. (AdvantageScope integration — deep-link, signed-URL token, or an embedded web-port viewer — deferred to a future initiative. See Scope Boundaries and Unit 0-A status.)

**Platform**
- R7. Runs on Cloudflare Workers free tier — no always-on VM, no external DB, no password hashing. Auth is via emailed magic links, which keeps every request well inside the 10 ms free-tier CPU budget. A transactional email provider (Resend free tier, 3,000 emails/month) is the one external dependency.
- R8. "Much easier to use" than RavenBrain, with an operational target: **from creating a Cloudflare account, a new user reaches "first session visible in the UI" in under 5 minutes of user-clock time** (assuming RavenLink is already installed and a match has already been recorded). Measured in Unit 10 with a scripted checklist.

## Scope Boundaries

- Not a RavenBrain replacement for Team 1310's internal use — RavenBrain remains the rich/canonical store.
- Single-owner workspaces only in v1 — workspace has one user (the owner) and one set of keys. The "workspace" primitive exists so v2 can add members without a data migration.
- No FRC-API enrichment (tournament/match/playoff joins). We store whatever RavenLink sends in session metadata verbatim.
- No OBS video handling — RavenLink keeps doing that locally.
- No NetworkTables client inside RavenScope — ingestion only.
- No realtime/live session viewing.
- No admin console, per-workspace quotas, or usage dashboards.
- No responsive/mobile layouts in v1 — target desktop laptop viewports (≥1024 px).
- No offline detection or service-worker caching in the SPA.
- No passwords, no password reset — magic links are the only auth; see README for the "lost email address = lost access" caveat.

### Deferred to Separate Tasks

- Team/org multi-member workspaces with roles.
- Public-read toggles or share links for sessions.
- FRC-API match identity enrichment.
- AdvantageScope-compatible realtime NT4 passthrough.
- **AdvantageScope integration** — v1 exposes only a `.wpilog` download button. A future initiative will decide between: (a) `advantagescope://` deep-link with cookie or signed-URL auth, (b) short-lived signed-URL token handoff, or (c) a port of AdvantageScope to the browser embedded directly inside RavenScope. This explicitly does NOT happen in v1 — Unit 0-A was skipped, and Unit 8/9 ship download-only.
- Responsive/mobile layouts.
- Passkey/WebAuthn as a second sign-in factor beyond the magic-link flow.
- A RavenLink upstream patch adding a bearer-token auth mode — see Unit 0-B (prerequisite, not deferred).

## Context & Research

### Relevant Code and Patterns (external repos; reference only, not modified)

- `~/src/1310/RavenLink/internal/uploader/uploader.go`: the upload protocol to mirror. Key shape — `POST /login` for JWT (RavenLink requires this call; see Unit 0 for the contract); `POST /api/telemetry/session` (idempotent create); `GET /api/telemetry/session/{id}` for resume state via `uploadedCount`; `POST /api/telemetry/session/{id}/data` (batch of 500); `POST /api/telemetry/session/{id}/complete`.
- `~/src/1310/RavenLink/internal/uploader/auth.go`: today's mandatory `/login` flow with `{username, password}` → `{access_token: "<JWT-shaped>"}`. Unit 0-B patches this file to add an `api_key` bearer-token path that bypasses `/login`. See Unit 0 and Unit 10.
- `~/src/1310/RavenBrain/src/main/java/ca/team1310/ravenbrain/telemetry/TelemetryApi.java`: canonical request/response record shapes we must match byte-for-byte on the wire.
- `~/src/1310/RavenBrain/.../TelemetrySession.java` and `TelemetryEntry.java`: column-level schema — useful reference for familiarity, but RavenScope does NOT store entries as rows (see Key Technical Decisions).
- `~/src/1310/RavenLink/internal/wpilog/`: reference Go implementation of the JSONL→WPILog v1.0 converter. Ported to TypeScript with identical output; pinned by golden-file tests.
- `~/src/1310/RavenLink/internal/ntlogger/logger.go`: authoritative description of the JSONL entry format RavenScope receives (`session_start`, `session_end`, `match_start`, `match_end`, plus NT topic updates).

### Institutional Learnings

- None applicable (no `docs/solutions/` in this blank repo).
- From RavenLink's shutdown design: the uploader assumes server-side idempotency per `sessionId` and tracks `uploadedCount`. RavenScope must honour both — `uploaded_count` must be incremented atomically and exactly per `/data` batch, BEFORE the HTTP 200 is returned; no deferred or `waitUntil`-based counter updates.

### External References

- Hono on Cloudflare Workers: `https://hono.dev/docs/getting-started/cloudflare-workers`.
- Workers Static Assets (not CF Pages for new full-stack projects): `https://developers.cloudflare.com/workers/static-assets/`.
- Cloudflare D1 + Drizzle ORM: `https://developers.cloudflare.com/d1/tutorials/drizzle-orm/`.
- Cloudflare Durable Objects: `https://developers.cloudflare.com/durable-objects/` — used to serialize per-session ingest.
- Cloudflare R2 API in Workers: `https://developers.cloudflare.com/r2/api/workers/workers-api-reference/` — `put`/`get`/`list`, multipart upload for streaming WPILog generation.
- WPILog v1.0 spec: `https://github.com/wpilibsuite/allwpilib/blob/main/wpiutil/doc/datalog.adoc`.
- AdvantageScope URL launch docs — to be verified empirically in Unit 0-A.
- Resend transactional email API: `https://resend.com/docs/api-reference/emails/send-email` (free tier 3,000 emails/month, ~100/day — generous for hobbyist use).

## Key Technical Decisions

- **Runtime: single Hono Worker + Workers Static Assets + one Durable Object class.** The Worker serves `/api/*` and the Vite-built SPA via the `[assets]` binding with `not_found_handling = "single-page-application"`. A Durable Object class `SessionIngestDO` (one instance per `telemetry_session.id`) serializes all `/data` writes for a given session — see the concurrency decision below. Not CF Pages (maintenance mode as of 2026).
- **Route precedence for `/api/*`:** asset matching runs before the Worker fetch handler by default, but the Vite build emits no files at `/api/*` paths so there is no collision. If a future bundle could shadow an API route, set `run_worker_first = ["/api/*"]`.
- **Entries are NOT stored as SQL rows.** Each `/data` batch is persisted as a raw JSONL blob in R2 under `sessions/{sessionId}/batch-{seq:0000}.jsonl`. D1 holds session metadata + a small `session_batches` table tracking sequence/count/byte-length per batch. D1 row-count and storage are therefore bounded per session; raw bytes live in R2 where they're cheap.
- **Ingest concurrency: Durable Object per session.** A `SessionIngestDO` keyed by `telemetry_sessions.id` owns `seq` allocation, R2 writes, D1 updates, and `wpilog` cache invalidation. Two concurrent `/data` calls for the same session are naturally serialized inside the DO, eliminating the race on `MAX(seq)+1`, the "orphan R2 on retry" case, and the D1-transaction-across-external-I/O problem. This is the cleanest way to get atomic ingest on Workers.
- **Key tree is derived on demand, cached as a JSON blob in R2.** On `GET /api/sessions/{id}/tree`: if `sessions/{id}/tree.json` exists and `generated_at >= last_batch_at`, serve it; otherwise stream each `batch-*.jsonl`, accumulate distinct `(nt_key, nt_type)` tuples with counts + first/last ts, write to `sessions/{id}/tree.json`, and serve. Avoids a materialised D1 table whose read path is rarely hot for hobbyist-scale v1 traffic.
- **Auth model — magic-link email, no passwords.**
  - `POST /api/auth/request-link` accepts `{email}`. Worker generates a 32-byte random `nonce`, computes `tokenHash = SHA-256(nonce)`, inserts `login_tokens(token_hash, email, expires_at = now() + 15 min, used_at NULL)`, and sends an email via Resend (free tier: 3,000/mo) with a URL `GET /api/auth/verify?t=<nonce>`. Response is always 204 regardless of whether the email exists (don't leak existence).
  - `GET /api/auth/verify?t=<nonce>` hashes the nonce, looks up the row, verifies not-used and not-expired, marks `used_at = now()`, upserts a `users` row + auto-owned `workspaces` row on first-ever sign-in for that email, sets the session cookie, 302 to `/`.
  - Sessions for the web UI are stateless signed HTTP-only cookies (no server-side revocation table; logout is best-effort client-side cookie clear + `Max-Age=0`; a stolen cookie is valid until its 30-day TTL).
  - `SESSION_SECRET` stored as a JSON map `{ "v1": "...", "v2": "..." }`. Cookie payload includes a `kid`; verification tries the named key first. Rotation: add `v2`, re-sign on next authenticated request, wait 30 days, remove `v1`. Concrete rotation procedure documented in README.
  - API keys: opaque 32-byte tokens prefixed `rsk_live_`, SHA-256 hashed at rest (Web Crypto), prefix+last4 displayed after creation, plaintext shown once. Scoped to a workspace.
  - Auth middlewares are **split by route class**: `requireCookieUser` for web-UI routes; `requireApiKeyUser` for ingest routes. Telemetry routes never accept cookies; web routes never accept API keys.
  - HTTPS-only middleware rejects any non-HTTPS request with 400 (localhost exempted). README also documents enabling "Always Use HTTPS" + "Minimum TLS 1.2" on the Cloudflare zone.
  - No email verification step — clicking the magic link IS verification.
  - No password reset — there's no password to reset. Lost access = lost access until the user can receive email at that address again. README documents this explicitly.
- **RavenLink compatibility: upstream patch (no `/login` shim).** RavenScope does not implement a `/login` endpoint. Instead, RavenLink gets a small upstream patch (Unit 0-B) that adds an `ravenbrain.api_key` config field; when set, `uploader.go` skips the `/login` call entirely and sends `Authorization: Bearer <api_key>` on every call. This is the clean long-term contract. RavenLink release carrying this patch is a hard prerequisite — a RavenScope deployment is only useful once its RavenLink peers have the patch installed. Rationale: a pseudo-JWT shim ages badly and hides the real contract; a one-file RavenLink change is a few hours of work and leaves both systems honest.
- **WPILog conversion: streaming port, cached in R2.** Port `encoder.go` + `convert.go` to TypeScript, but restructured as a streaming two-pass: first pass streams each `batch-*.jsonl` from R2 to accumulate topic order + `minServerTS`, retaining only the slice-of-topic-keys in memory; second pass streams again to emit records via R2 multipart upload. Peak heap is independent of session size. Cached output at `sessions/{sessionId}/session.wpilog`; invalidated when `/data` arrives for an already-cached session (see below).
- **ORM: Drizzle with D1 driver.** Typed migrations, fits Workers bundle, runs Wrangler CLI for local D1. Keep it — at ~7 tables the types earn their keep.
- **Frontend: Vite + React + TypeScript, react-router v6, TanStack Query, Tailwind.** Dropped TanStack Router — 5 pages don't justify file-system typed routing. TanStack Query kept for mutation/cache coordination.
- **Package layout: 2 packages.** `packages/worker` (Hono + Drizzle + ingest + ported encoder + DTOs) and `packages/web` (Vite SPA). No separate `shared` package — the encoder + DTOs live in `packages/worker/src/` and the web package imports them via the workspace path. Pure TypeScript modules; plain Vitest tests that don't require the Workers pool.

## Open Questions

### Resolved During Planning

- Mirror RavenBrain's API exactly? → Yes, byte-compatible on wire.
- Store entries as SQL rows? → No, JSONL blobs in R2 + on-demand tree JSON cache in R2.
- Multi-tenant model? → Single-owner workspaces in v1; schema supports v2 multi-member without migration.
- WPILog conversion? → Port to TypeScript, streaming two-pass, R2 multipart upload.
- RavenLink auth compat? → Upstream RavenLink patch adds an `api_key` config; no `/login` shim in RavenScope. Patch is a hard prerequisite.
- `seq` race / concurrency? → Durable Object per session.
- sessions_web table? → Deleted. Stateless signed cookies only.
- Tree view storage? → On-demand, cached as R2 JSON object.
- AdvantageScope integration? → v1 is download-only. Unit 0-A spike skipped. Whether the eventual integration is a `advantagescope://` deep-link, a signed-URL token flow, or an AdvantageScope web-port embedded directly in RavenScope is a future initiative — see Scope Boundaries.
- Design tokens + component library? → Tokens (colors, type ramp, spacing) defined in `docs/design/ravenscope-ui.pen` under Swiss Clean, dark-default. Component library is Radix primitives (`@radix-ui/react-dialog` for the create-key modal, `@radix-ui/react-collapsible` for the NT key tree) + hand-rolled Tailwind for everything else. See Unit 0-C.

### Deferred to Implementation

- Exact D1 migration ordering and seed fixtures — resolve during Unit 2.
- Cookie `Domain` attribute — finalise in Unit 3 once the deployed domain is known.
- Exact R2 multipart chunk size for streaming WPILog output — tune in Unit 7/8.

## Output Structure

```
RavenScope/
├── package.json                 # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── README.md
├── .editorconfig
├── .gitignore
├── docs/
│   └── plans/
├── packages/
│   ├── worker/
│   │   ├── package.json
│   │   ├── wrangler.toml
│   │   ├── drizzle.config.ts
│   │   ├── migrations/          # D1 SQL migrations (Drizzle output)
│   │   ├── src/
│   │   │   ├── index.ts         # Hono app entry, route mounting, static assets
│   │   │   ├── env.ts           # typed Env bindings
│   │   │   ├── db/
│   │   │   │   ├── schema.ts
│   │   │   │   └── client.ts
│   │   │   ├── auth/
│   │   │   │   ├── magic-link.ts        # token gen, hash, verify, upsert user+workspace
│   │   │   │   ├── email.ts             # Resend client (POST emails, error mapping)
│   │   │   │   ├── cookie.ts            # signed session cookies + kid rotation
│   │   │   │   ├── apikey.ts
│   │   │   │   ├── require-cookie-user.ts
│   │   │   │   ├── require-apikey-user.ts
│   │   │   │   ├── rate-limit.ts        # per-IP and per-email on magic-link requests
│   │   │   │   └── https-only.ts
│   │   │   ├── audit/
│   │   │   │   └── log.ts               # writes to audit_log
│   │   │   ├── ingest-do/
│   │   │   │   └── session-ingest-do.ts # Durable Object class
│   │   │   ├── routes/
│   │   │   │   ├── auth.ts              # request-link, verify, logout, me
│   │   │   │   ├── api-keys.ts
│   │   │   │   ├── telemetry.ts         # mirror of RavenBrain TelemetryApi
│   │   │   │   ├── sessions.ts          # web-UI session list/detail/tree
│   │   │   │   └── wpilog.ts
│   │   │   ├── storage/
│   │   │   │   ├── r2.ts
│   │   │   │   └── keys.ts
│   │   │   ├── ingest/
│   │   │   │   └── tree-builder.ts      # JSONL → tree JSON, used by /tree route
│   │   │   ├── wpilog/
│   │   │   │   ├── encoder.ts           # port of RavenLink internal/wpilog/encoder.go
│   │   │   │   ├── convert.ts           # streaming two-pass converter
│   │   │   │   ├── types.ts
│   │   │   │   ├── encoder.test.ts
│   │   │   │   ├── convert.test.ts
│   │   │   │   └── fixtures/
│   │   │   │       ├── sample-session.jsonl
│   │   │   │       └── sample-session.wpilog    # golden file from Go encoder
│   │   │   └── dto.ts                   # mirrors TelemetryApi.java records; imported by web
│   │   └── test/
│   │       ├── smoke.test.ts
│   │       ├── auth.test.ts
│   │       ├── api-keys.test.ts
│   │       ├── telemetry.test.ts
│   │       ├── sessions.test.ts
│   │       ├── wpilog-route.test.ts
│   │       └── end-to-end.test.ts       # ingest → tree → wpilog
│   └── web/
│       ├── package.json
│       ├── vite.config.ts
│       ├── tailwind.config.ts
│       ├── postcss.config.js
│       ├── index.html
│       └── src/
│           ├── main.tsx
│           ├── app.tsx
│           ├── index.css
│           ├── lib/
│           │   ├── api.ts               # typed fetch client, uses ../../../worker/src/dto.ts
│           │   └── auth.ts
│           ├── routes/
│           │   ├── sign-in.tsx                  # enter email → request magic link
│           │   ├── check-email.tsx              # "We sent a link to <email>" confirmation
│           │   ├── sessions.tsx
│           │   ├── session-detail.tsx
│           │   └── api-keys.tsx
│           └── components/
│               ├── KeyTree.tsx
│               ├── SessionRow.tsx
│               ├── AuthGate.tsx
│               ├── AuthForm.tsx
│               └── EmptyState.tsx
├── scripts/
│   └── setup.sh                 # creates D1 DB + R2 bucket, applies migrations, sets SESSION_SECRET + RESEND_API_KEY, verifies R2 is private
└── .github/
    └── workflows/
        ├── ci.yml
        └── deploy.yml
```

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

Request flow:

```mermaid
sequenceDiagram
  autonumber
  participant RL as RavenLink uploader
  participant W as RavenScope Worker (Hono)
  participant DO as SessionIngestDO
  participant D1 as D1
  participant R2 as R2
  participant Browser as Browser (SPA)
  participant AS as AdvantageScope

  Note over RL,R2: Ingest (authenticated via API-key Bearer; patched RavenLink only)
  RL->>W: POST /api/telemetry/session
  W->>D1: upsert session by (workspace_id, session_id)
  W-->>RL: TelemetrySession
  loop batches of 500
    RL->>W: POST /api/telemetry/session/{id}/data
    W->>DO: forward (serialized per session id)
    DO->>R2: put sessions/{id}/batch-{seq}.jsonl
    DO->>D1: db.batch([insert session_batches, update telemetry_sessions SET uploaded_count+=N, last_batch_at=now, wpilog_key=NULL])
    DO-->>W: { count: N }
    W-->>RL: { count }
  end
  RL->>W: POST /api/telemetry/session/{id}/complete
  W->>DO: forward
  DO->>D1: update telemetry_sessions set ended_at, entry_count=<client-asserted>, wpilog_key=NULL

  Note over Browser,R2: Browse + WPILog (cookie auth)
  Browser->>W: GET /api/sessions (cookie)
  W->>D1: select sessions WHERE workspace_id=me
  W-->>Browser: list
  Browser->>W: GET /api/sessions/{id}/tree
  alt cached tree fresh
    W->>R2: get sessions/{id}/tree.json
  else stale or missing
    W->>R2: list + get batch-*.jsonl (streaming)
    W->>W: accumulate distinct keys
    W->>R2: put sessions/{id}/tree.json
  end
  W-->>Browser: hierarchical tree
  Browser->>W: GET /api/sessions/{id}/wpilog
  alt cached fresh
    W->>R2: get sessions/{id}/session.wpilog (stream)
  else stale or missing
    W->>R2: streaming two-pass encode over batch-*.jsonl
    W->>R2: multipart upload session.wpilog
    W->>D1: set wpilog_key, wpilog_generated_at
  end
  W-->>Browser: stream .wpilog bytes (Worker-proxied, never a 302 to R2)
  Browser->>AS: open advantagescope://... (exact scheme from Unit 0)
```

Data model sketch (directional, not final DDL):

```
users(id, email UNIQUE, created_at)
workspaces(id, owner_user_id FK, name, created_at)
login_tokens(
  id, token_hash UNIQUE, email, expires_at, used_at NULL, created_at,
  INDEX(email, expires_at)   -- for rate-limiting by email
)
api_keys(
  id, workspace_id FK, name, prefix, last4, hash UNIQUE,
  created_at, last_used_at NULL, revoked_at NULL
)
telemetry_sessions(
  id, workspace_id FK, session_id, team_number, robot_ip,
  started_at, ended_at NULL, entry_count, uploaded_count,
  tournament_id NULL, match_label NULL, match_level NULL, match_number NULL,
  playoff_round NULL, fms_event_name NULL,
  created_at, last_batch_at NULL, wpilog_key NULL, wpilog_generated_at NULL,
  UNIQUE(workspace_id, session_id)
)
session_batches(session_id FK, seq, byte_length, entry_count, r2_key, created_at, PK(session_id, seq))
audit_log(
  id, event_type, actor_user_id NULL, actor_api_key_id NULL,
  workspace_id NULL, ip_hash, created_at, metadata_json
)
-- event_type ∈ {magic_link_requested, magic_link_verified, logout,
--               key_create, key_revoke, key_use,
--               session_create, session_complete}
```

## Implementation Units

- [x] **Unit 0-A: Pre-flight spike — AdvantageScope launch [SKIPPED]**

**Status:** Skipped per 2026-04-22 decision. v1 ships with download-only `.wpilog` export via `Content-Disposition: attachment` (see updated R6 and Unit 8). AdvantageScope integration — whether via `advantagescope://` deep-link, signed-URL token, or a ported web-viewer embedded directly inside RavenScope — is deferred to a future initiative and captured in Scope Boundaries.

**Rationale for deferral:** The download path is unambiguous and requires no browser/AS version dance; the AS web-port initiative (if it lands) would obviate the deep-link mechanism entirely, so investing in deep-link plumbing now would likely be thrown away.

**Downstream effect:**
- Unit 8 implements cookie-authenticated download only; the signed-URL token path and AS-launch branches are cut.
- Unit 9's session-detail page exposes only a `[Download .wpilog]` primary action; the secondary `[Open in AdvantageScope]` button is removed from the v1 design.

---

- [ ] **Unit 0-B: Upstream RavenLink patch — API-key bearer mode**

**Goal:** Ship a small patch to `~/src/1310/RavenLink` that adds a bearer-token auth mode. When `ravenbrain.api_key` is set in RavenLink's config, `uploader.go` skips the `/login` call and sends `Authorization: Bearer <api_key>` on every request. This patch is a hard prerequisite for RavenScope: a RavenScope deployment only accepts ingest from a RavenLink build that has this patch.

**Requirements:** R3.

**Dependencies:** None. Runs in the RavenLink repo, not in RavenScope.

**Files (in `~/src/1310/RavenLink`):**
- Modify: `internal/uploader/auth.go` — add `apiKey` field to `Auth`; `IsConfigured()` returns true when (baseURL AND apiKey) OR the legacy (baseURL AND username AND password) pair is set; `GetAuthHeader()` returns `Authorization: Bearer <apiKey>` when `apiKey` is set and skips the `/login` dance entirely.
- Modify: `internal/config/config.go` — parse `ravenbrain.api_key` from YAML and CLI flag `--ravenbrain-api-key`.
- Modify: `config.yaml.example` — add `api_key: ""` under `ravenbrain:` with a comment explaining the two auth modes.
- Test: `internal/uploader/auth_test.go` — add table-driven tests for the new mode including: apiKey set → Bearer header, apiKey set + username set → apiKey wins, apiKey empty → legacy flow, invalid non-HTTPS URL still refused.

**Approach:**
- Keep the legacy username/password/`/login` flow intact for RavenBrain compatibility. Bearer mode is strictly additive.
- The bearer path has no token caching / renewal since the API key is the credential itself.
- README update in the RavenLink repo: document the new `api_key` config and note that RavenScope uses it exclusively.

**Execution note:** Test-first on the mode-selection logic. Two auth modes in one `Auth` struct is easy to get subtly wrong.

**Test scenarios:**
- Happy path — `api_key` set: `GetAuthHeader()` returns `Authorization: Bearer <key>`; no HTTP call made to `/login`.
- Happy path — only `username/password` set: legacy flow unchanged.
- Edge case — both sets present: `api_key` wins; legacy creds unused.
- Edge case — `api_key` empty string treated as "not set."
- Edge case — non-HTTPS baseURL still rejects regardless of auth mode.
- Error path — RavenScope returns 401 on a bearer call: RavenLink logs and backs off, same as today's 401-on-JWT behaviour.

**Verification:** `go test ./internal/uploader/...` green; a locally built RavenLink binary with `api_key` configured successfully uploads a session against a `wrangler dev` RavenScope instance (integration check, performed during Unit 5).

---

- [x] **Unit 0-C: Frontend design mockups**

**Goal:** Resolve Unit 9's deferred design-token and component-library questions before any web code is written by producing high-fidelity mockups of all five pages plus the create-key modal in a single Pencil `.pen` file. Downstream effect: Unit 9 implements against a settled visual spec instead of inventing one mid-build.

**Requirements:** R4, R5, R6 (visual resolution only; this unit does not advance implementation of these requirements).

**Dependencies:** None.

**Files:**
- Create: `docs/design/ravenscope-ui.pen`

**Approach:**
- Style direction: **Swiss Clean** — zero corner radius, borders-over-fills, single red accent (`#E42313`) reserved for primary CTAs, active-nav underline, destructive actions, and warning callouts. Dark-mode token set is the default for v1.
- Typography: **Space Grotesk** (display, UI labels), **Inter** (body, table content), **JetBrains Mono** (NT keys, session IDs, API key tokens, timing values).
- Layout: top nav with two destinations (Sessions · API Keys) + workspace pill + avatar. No sidebar — two destinations do not justify the chrome.
- Screens delivered: sign-in, check-email, sessions list (with sort/filter controls visible), session detail (stat row + collapsible NT key tree showing type badges and ts ranges), API keys list, create-key modal (plaintext-shown-once state).
- Design tokens defined in the `.pen` file propagate directly to Tailwind v4 `@theme` tokens in Unit 9; the mapping is 1:1 (`bg-page`, `bg-surface`, `text-primary`, `text-secondary`, `text-muted`, `text-placeholder`, `border`, `accent`, `success`, `bg-code`).
- Component library decision: **Radix primitives** (`@radix-ui/react-dialog` for the create-key modal, `@radix-ui/react-collapsible` for the NT key tree branches) plus hand-rolled Tailwind for everything else. No full component library — the design is sparse enough that a kit would add weight without saving code.
- Mockups are the design source of truth for Unit 9; implementation may deviate only where native behavior (focus rings, keyboard affordances, reduced-motion) requires it.

**Execution note:** Already complete — the mockup file is committed at the path above. Retained in the plan as a reference anchor for Unit 9 and for future design iterations.

**Test scenarios:** Test expectation: none — design artifact.

**Verification:** File exists at `docs/design/ravenscope-ui.pen` containing named frames for `Sign in`, `Check email`, `Sessions list`, `Session detail`, `API keys`, and `Create API key modal`, plus a `Components` palette with reusable TopNav, buttons, input, badges, and status pills.

---

- [ ] **Unit 1: Repository scaffold + tooling**

**Goal:** Establish the 2-package pnpm workspace, TypeScript baselines, Hono worker skeleton (with Durable Object class stub), Vite SPA skeleton, Wrangler config, and green `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm build`.

**Requirements:** R7, foundation for R1–R6.

**Dependencies:** Unit 0-A.

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.editorconfig`, `.gitignore`, `README.md`
- Create: `packages/worker/package.json`, `packages/worker/wrangler.toml`, `packages/worker/tsconfig.json`, `packages/worker/src/index.ts`, `packages/worker/src/env.ts`, `packages/worker/src/ingest-do/session-ingest-do.ts` (empty class stub), `packages/worker/src/dto.ts` (empty module)
- Create: `packages/web/package.json`, `packages/web/vite.config.ts`, `packages/web/tailwind.config.ts`, `packages/web/postcss.config.js`, `packages/web/index.html`, `packages/web/src/main.tsx`, `packages/web/src/app.tsx`, `packages/web/src/index.css`, `packages/web/tsconfig.json`
- Create: `.github/workflows/ci.yml`
- Test: `packages/worker/test/smoke.test.ts`

**Approach:**
- pnpm workspace with `worker` + `web`. `web` imports from `worker` via workspace path (Vite handles TS across packages without a build step for sibling packages).
- `wrangler.toml` declares `main = "src/index.ts"`, `compatibility_date` current, placeholders for `D1_DATABASES`, `R2_BUCKETS`, `SESSION_SECRET` (secret), `RESEND_API_KEY` (secret), `EMAIL_FROM` (var), a `[[durable_objects.bindings]]` entry for `SESSION_INGEST_DO`, and an `[assets]` block with `directory = "../web/dist"`, `binding = "ASSETS"`, `not_found_handling = "single-page-application"`.
- Vite `base: '/'`, `build.outDir: '../web/dist'`. Tailwind configured with the standard `@tailwind base/components/utilities` in `src/index.css`; `content` points at `./src/**/*.{ts,tsx,html}`.
- `pnpm build` builds the web first, then `wrangler build` packages the worker with `web/dist` as its asset directory.
- CI: Node 20, pnpm 9; `pnpm install --frozen-lockfile` → `pnpm -r typecheck` → `pnpm -r test` → `pnpm -r lint` → `pnpm -r build`.

**Test scenarios:**
- Happy path — `GET /api/health` returns `{ ok: true }` in `@cloudflare/vitest-pool-workers`.
- Happy path — `pnpm -r build` completes in a clean clone; the Worker bundle includes the DO class and static-assets metadata.

**Verification:** `pnpm install && pnpm -r build && pnpm -r test && pnpm -r lint` all green; CI workflow green on a throwaway branch.

---

- [ ] **Unit 2: D1 schema + Drizzle migrations**

**Goal:** Model the full v1 data model (workspaces, api_keys, telemetry_sessions, session_batches, audit_log, users) and emit the first migration.

**Requirements:** R1, R2, R3, R4, R5.

**Dependencies:** Unit 1.

**Files:**
- Create: `packages/worker/drizzle.config.ts`
- Create: `packages/worker/src/db/schema.ts`
- Create: `packages/worker/src/db/client.ts`
- Create: `packages/worker/migrations/0001_init.sql` (generated)
- Modify: `packages/worker/wrangler.toml` to add `[[d1_databases]]` binding `DB`
- Test: `packages/worker/test/db.test.ts`

**Approach:**
- Columns per the data-model sketch. snake_case DB columns, camelCase TS fields via Drizzle.
- Uniques: `users.email`, `api_keys.hash`, `(telemetry_sessions.workspace_id, telemetry_sessions.session_id)`, `(session_batches.session_id, session_batches.seq)`.
- Indexes: `telemetry_sessions(workspace_id, started_at DESC)`; `api_keys(workspace_id, revoked_at)`; `audit_log(created_at DESC, workspace_id)`; `session_batches(session_id, seq)`.
- Registration creates a row in `users` AND an auto-owned `workspaces` row linking back, in a single `db.batch()`.

**Test scenarios:**
- Happy path — migrations apply idempotently; introspection shows all expected tables/indexes.
- Edge case — inserting two `telemetry_sessions` rows with the same `session_id` under the same workspace fails; under different workspaces both succeed.
- Edge case — deleting a user cascades or fails cleanly (pick explicitly in the migration; recommend RESTRICT and require workspace transfer first).
- Edge case — `api_keys.hash` must be unique across workspaces.

**Verification:** `pnpm -F worker drizzle generate` produces a migration; `wrangler d1 migrations apply DB --local` idempotent; db test suite green.

---

- [ ] **Unit 3: Auth — magic-link email sign-in, cookie sessions, rate limit**

**Goal:** Passwordless self-service sign-in via emailed magic links. Endpoints: `POST /api/auth/request-link` (sends email), `GET /api/auth/verify` (consumes token, sets cookie), `POST /api/auth/logout`, `GET /api/auth/me`. Versioned session cookies, HTTPS-only middleware, rate-limit middleware on the request-link path, audit-logged events. First-ever verified sign-in for a given email transparently provisions `users` + `workspaces` rows.

**Requirements:** R1, R7, R8.

**Dependencies:** Unit 2.

**Files:**
- Create: `packages/worker/src/auth/magic-link.ts` (token generation, hashing, verification, upsert user+workspace)
- Create: `packages/worker/src/auth/email.ts` (Resend client — POST /emails, error mapping, exponential backoff for transient failures)
- Create: `packages/worker/src/auth/cookie.ts` (signed session cookie with kid rotation)
- Create: `packages/worker/src/auth/require-cookie-user.ts`
- Create: `packages/worker/src/auth/rate-limit.ts` (per-IP and per-email on request-link)
- Create: `packages/worker/src/auth/https-only.ts`
- Create: `packages/worker/src/audit/log.ts`
- Create: `packages/worker/src/routes/auth.ts` (request-link, verify, logout, me)
- Modify: `packages/worker/src/index.ts` to mount HTTPS-only + `/api/auth/*`
- Modify: `packages/worker/wrangler.toml` to declare `SESSION_SECRET` and `RESEND_API_KEY` as secrets, and an `EMAIL_FROM` var (e.g., `no-reply@ravenscope.example.com`)
- Modify: `packages/worker/src/dto.ts` (RequestLinkRequest, UserMeResponse)
- Test: `packages/worker/test/auth.test.ts`

**Approach:**
- **`POST /api/auth/request-link`**: body `{email}`. Validates shape. Runs the rate-limit check (see below). Generates a 32-byte random `nonce` via `crypto.getRandomValues`, base64url-encodes to a 43-char string. Computes `tokenHash = SHA-256(nonce)` via Web Crypto. Inserts `login_tokens(token_hash, email, expires_at = now() + 15 min)`. Calls `email.ts` to send a Resend email with subject "Your RavenScope sign-in link" and a body containing a single link: `https://<base>/api/auth/verify?t=<nonce>` plus a line saying the link expires in 15 minutes. **Response is always 204 regardless of whether the email maps to a user** — prevents email enumeration. Resend failures log to audit_log but don't leak to the caller.
- **`GET /api/auth/verify?t=<nonce>`**: hashes the nonce, SELECTs `login_tokens` by hash. Reject if: row absent, `used_at IS NOT NULL`, or `expires_at < now()`. On success: `UPDATE login_tokens SET used_at = now()`. Upsert `users(email)` — on first sign-in, also insert `workspaces(owner_user_id = users.id, name = email.split('@')[0] + "'s workspace")` in the same `db.batch()`. Issue session cookie. 302 to `/`.
- **Session cookie**: payload `{ uid: users.id, wsid: workspaces.id, kid: "v1", exp: now + 30d }`, signed HMAC-SHA256 using `SESSION_SECRET[kid]`. Verification tries the named key first; unknown `kid` → 401 + Set-Cookie Max-Age=0. Rotation procedure in README.
- **`POST /api/auth/logout`**: clears cookie (`Set-Cookie rs_session=; Max-Age=0`). Audit-logs `logout`.
- **`GET /api/auth/me`**: returns `{userId, email, workspaceId, workspaceName}` or 401.
- **HTTPS-only middleware**: reject any non-HTTPS request with 400; localhost/`wrangler dev` exempted.
- **Rate limiting** (via a `RateLimitDO`): per-IP on `/api/auth/request-link` at 5 req/min; **also per-email** at 3 req/10-min. Per-email limit specifically prevents an attacker from exhausting Resend's 3,000/mo quota by spamming `request-link` with many fabricated emails.
- **Audit log**: `magic_link_requested` (regardless of whether email exists), `magic_link_verified` (with userId/workspaceId), `logout`.
- **Email template** (`email.ts`): plain text, no HTML tracking, single link, subject is deterministic. Avoids Gmail clipping / promo-tab routing.

**Execution note:** Test-first on token generation + hash equality + the rate-limit-respects-per-email rule. Easy to accidentally leak side channels (e.g., different response latency for existing-vs-new emails) — write a test that asserts constant-time-ish response timing for both cases.

**Test scenarios:**
- Happy path — `POST /api/auth/request-link` with a new email returns 204, inserts a row in `login_tokens`, sends an email (mocked Resend in tests).
- Happy path — click the verification link → 302 to /, cookie set, `users` + `workspaces` rows created.
- Happy path — repeat sign-in with existing email: users/workspaces rows NOT duplicated; cookie set.
- Happy path — `GET /api/auth/me` returns the user after verify.
- Edge case — using the same magic link twice: second call returns 410 Gone (used_at not null).
- Edge case — expired magic link (> 15 min): 410 Gone.
- Edge case — verify with a random fake nonce: 410 (no row matches the hash).
- Edge case — cookie with unknown `kid` → 401 + Max-Age=0 clear.
- Edge case — cookie with rotated `kid` verified by old key while both present; response re-signs with new key.
- Edge case — response time for `request-link` with existing-vs-new email differs by < 50 ms (no enumeration timing channel).
- Error path — non-HTTPS request → 400.
- Error path — 6th request-link POST from same IP within 1 min → 429.
- Error path — 4th request-link for the same email within 10 min → 429.
- Error path — Resend API 500s: the request-link route STILL returns 204 to the caller, logs `magic_link_requested` with `metadata_json = {email_send_failed: true}` so operators can see it.
- Integration — full flow: request-link → verify → me → logout → me returns 401.
- Integration — audit_log has `magic_link_requested`, `magic_link_verified`, `logout` after full run.

**Verification:** auth test suite green; manual flow works against `wrangler dev` with a real Resend API key into a test inbox.

---

- [ ] **Unit 4: API keys + bearer auth middleware**

**Goal:** Workspace-scoped API keys: mint / list / revoke. Separate `requireApiKeyUser` middleware used by ingest routes.

**Requirements:** R2.

**Dependencies:** Unit 3.

**Files:**
- Create: `packages/worker/src/auth/apikey.ts`
- Create: `packages/worker/src/auth/require-apikey-user.ts`
- Create: `packages/worker/src/routes/api-keys.ts`
- Modify: `packages/worker/src/index.ts` to mount `/api/keys/*` (requireCookieUser)
- Modify: `packages/worker/src/dto.ts` (ApiKeyCreateRequest, ApiKeyCreateResponse, ApiKeyListItem)
- Test: `packages/worker/test/api-keys.test.ts`

**Approach:**
- Token: `rsk_live_` + 32 bytes from `crypto.getRandomValues`, base64url, no padding.
- Storage: `prefix`, `last4`, `hash = SHA-256(fullToken)` via Web Crypto. Plaintext returned once on create.
- Verification: parse `Authorization: Bearer rsk_live_...`, hash, SELECT by hash, reject if `revoked_at IS NOT NULL`, then `c.var.user = { workspaceId, apiKeyId }`. Update `last_used_at` via `ctx.waitUntil` after response.
- Name field: required at creation, 1–100 chars, duplicates allowed, not editable post-creation in v1.
- Modal UX handled in Unit 9: warn on close-without-acknowledge.
- Audit log: `key_create`, `key_revoke`, `key_use`.

**Test scenarios:**
- Happy path — `POST /api/keys` returns plaintext once; subsequent `GET /api/keys` returns prefix+last4 only.
- Happy path — valid bearer authenticates an ingest route.
- Edge case — revoked token rejected on next request.
- Edge case — key belonging to workspace A cannot list workspace B's keys.
- Edge case — name > 100 chars rejected; name empty rejected.
- Error path — malformed `Authorization` header returns 401.
- Error path — cookie on an ingest route returns 401 (not accepted).
- Integration — cookie and bearer populate `c.var.user` identically for callers that only care about `workspaceId`.
- Integration — `last_used_at` is updated after the request completes.

**Verification:** API-key test suite green; `curl -H "Authorization: Bearer rsk_live_..."` sanity check.

---

- [ ] **Unit 5: Telemetry ingest API + SessionIngestDO**

**Goal:** The four ingestion endpoints, byte-compatible with RavenBrain's `TelemetryApi`, serialized per session by `SessionIngestDO`. Authenticated via bearer API key (the patched RavenLink sends `Authorization: Bearer rsk_live_...` directly — no `/login` endpoint is exposed).

**Requirements:** R3, R8.

**Dependencies:** Units 2, 4, and the RavenLink patch shipped in Unit 0-B (for end-to-end integration verification only; RavenScope tests can drive the endpoints directly with a bearer header).

**Files:**
- Create: `packages/worker/src/routes/telemetry.ts`
- Create: `packages/worker/src/ingest-do/session-ingest-do.ts` (full DO implementation)
- Create: `packages/worker/src/storage/r2.ts`, `packages/worker/src/storage/keys.ts`
- Modify: `packages/worker/src/index.ts` to mount `/api/telemetry/*` (guarded by `requireApiKeyUser`)
- Modify: `packages/worker/wrangler.toml` to add R2 binding `BLOBS`
- Modify: `packages/worker/src/dto.ts` (CreateSessionRequest, TelemetryEntryRequest, CompleteSessionRequest, BatchInsertResult — matching RavenBrain exactly)
- Test: `packages/worker/test/telemetry.test.ts`

**Approach:**
- No `/login` endpoint. All ingest routes read `Authorization: Bearer rsk_live_...` via the `requireApiKeyUser` middleware from Unit 4.
- `POST /api/telemetry/session` — create-or-return. If `(workspace_id, session_id)` exists, return existing (idempotent). Matches `CreateSessionRequest`.
- `GET /api/telemetry/session/{sessionId}` — 404 if not in caller's workspace; otherwise return row with `uploadedCount`.
- `POST /api/telemetry/session/{sessionId}/data` — Worker validates ownership, then forwards the request body to the DO stub obtained from `env.SESSION_INGEST_DO.idFromName(sessionDbId)`. The DO:
  1. Computes `nextSeq = current_seq + 1` from its in-DO state (loaded from D1 lazily on first call).
  2. Writes the batch as JSONL to R2 at `sessions/{sessionId}/batch-{seq:0000}.jsonl`.
  3. Runs a single `db.batch([INSERT session_batches, UPDATE telemetry_sessions SET uploaded_count = uploaded_count + N, last_batch_at = now(), wpilog_key = NULL, wpilog_generated_at = NULL])`.
  4. Returns `{ count: N }`.
  R2 failure: DO returns 503, no D1 mutation, no seq advance. D1 failure after R2 success: DO keeps its local seq counter so the retry re-uses the same seq (overwriting the orphan R2 object deterministically).
- `POST /api/telemetry/session/{sessionId}/complete` — forwarded to DO. **Idempotent**: if already completed with the same `endedAt`, no-op; different `endedAt` updates and clears wpilog cache. Never rejects late `/data` batches after `/complete` (the `/data` path itself handles cache invalidation). `entry_count` is stored **verbatim from the request body** — RavenBrain semantics. `uploaded_count` is the sum-of-batches counter RavenLink uses for resume.
- **Invariant:** `uploaded_count` is incremented atomically and exactly by `entries.length` per `/data` call, before the HTTP response is returned. No deferred/waitUntil increments on that counter.

**Execution note:** Test-first for the entire wire contract AND the concurrency serialization — this surface is RavenLink's live API.

**Test scenarios:**
- Happy path — full lifecycle: create → 3 batches of 500 → complete → `entry_count = 1500`, `uploaded_count = 1500`, three R2 objects present, `last_batch_at` set.
- Happy path — idempotent create: second `POST /session` with same `sessionId` returns original row, counters unchanged.
- Edge case — resume: upload 2 batches, `GET /session/{id}` returns `uploadedCount = 1000` (caller skips to entry 1000 per RavenLink's existing logic).
- Edge case — late batch after `/complete`: POST /data succeeds, bumps `last_batch_at`, clears `wpilog_key`.
- Edge case — empty batch `[]` returns `{ count: 0 }`, no R2 object.
- Edge case — idempotent `/complete`: second `/complete` with same `endedAt` is a no-op and returns 200.
- Edge case — different `endedAt` on second `/complete` updates `ended_at` and clears wpilog cache.
- Error path — `/data` for a session not in caller's workspace returns 404 (not 403 — no existence leak).
- Error path — request body > Workers body limit returns 413.
- Error path — R2 write failure: DO returns 503, D1 unchanged, next retry succeeds with same seq and overwrites the orphan if any.
- Error path — ingest call with a revoked or unknown bearer token returns 401.
- Error path — ingest call with no `Authorization` header returns 401 (cookie auth is not accepted on telemetry routes).
- Concurrency — two simultaneous `/data` POSTs for the same session resolve to `seq=N` and `seq=N+1` cleanly via DO serialization; no unique-constraint failures, no orphan R2 objects.
- Concurrency — two simultaneous POSTs for DIFFERENT sessions touch different DO instances and don't block each other.

**Verification:** test suite green; live RavenLink `./ravenlink` run end-to-end against `wrangler dev`.

---

- [ ] **Unit 6: Web-UI session routes (list with sort/filter, detail, tree)**

**Goal:** Endpoints that power the SPA's Sessions page and Session detail view, scoped to the caller's workspace. Includes concrete sort/filter query params per R4.

**Requirements:** R4, R5.

**Dependencies:** Units 3, 5.

**Files:**
- Create: `packages/worker/src/routes/sessions.ts`
- Create: `packages/worker/src/ingest/tree-builder.ts`
- Modify: `packages/worker/src/index.ts` to mount `/api/sessions/*`
- Modify: `packages/worker/src/dto.ts` (SessionListItem, SessionDetail, KeyTreeNode, SessionListQuery)
- Test: `packages/worker/test/sessions.test.ts`

**Approach:**
- `GET /api/sessions` — query params: `q` (case-insensitive substring search on `fms_event_name`), `sort` ∈ `{started_at,fms_event_name,match_label}`, `order` ∈ `{asc,desc}` (default `started_at desc`), `cursor` (opaque token for pagination). Returns `{items: SessionListItem[], nextCursor: string|null}`.
- `GET /api/sessions/{id}` — 404 if not in workspace; full detail including `last_batch_at`, `wpilog_generated_at`, batch count.
- `GET /api/sessions/{id}/tree`:
  1. Check `sessions/{id}/tree.json` in R2; if present AND its metadata `generated_at >= telemetry_sessions.last_batch_at`, stream it.
  2. Else: call `buildTree(sessionId)` — streams each `batch-*.jsonl`, parses lines, accumulates a `Map<nt_key, {nt_type, count, firstTs, lastTs}>`. Serializes to a nested `KeyTreeNode[]` by splitting on `/`. Writes `sessions/{id}/tree.json` with `generated_at = now()`. Streams response.
- Tree builder skips non-data entries (`session_start`, `match_start`, etc.). Empty/malformed lines skipped with a counter in metadata.

**Test scenarios:**
- Happy path — list returns only caller's sessions, newest-first, pagination cursor round-trips.
- Happy path — `?q=quals` filters sessions whose `fms_event_name` matches; `?sort=match_label&order=asc` orders correctly.
- Happy path — tree for `/SmartDashboard/foo`, `/SmartDashboard/bar`, `/Shuffleboard/baz/qux` returns 2 top-level nodes with correct children.
- Edge case — `/` or empty key filtered out and counted as malformed, not crashing.
- Edge case — tree with zero keys returns `[]`, not 404.
- Edge case — stale cached tree (`last_batch_at > tree.generated_at`) triggers rebuild.
- Error path — session in another workspace returns 404.
- Integration — after Unit 5 end-to-end ingest, `/tree` reflects uploaded distinct keys exactly.

**Verification:** test suite green; manual check against a real uploaded session.

---

- [ ] **Unit 7: WPILog streaming encoder port**

**Goal:** Port `encoder.go` + `convert.go` to TypeScript as a **streaming** two-pass encoder over R2. Produces byte-identical output for identical input compared to the Go encoder.

**Requirements:** R6.

**Dependencies:** Unit 1.

**Files:**
- Create: `packages/worker/src/wpilog/encoder.ts`
- Create: `packages/worker/src/wpilog/convert.ts`
- Create: `packages/worker/src/wpilog/types.ts`
- Test: `packages/worker/src/wpilog/encoder.test.ts`
- Test: `packages/worker/src/wpilog/convert.test.ts`
- Create: `packages/worker/src/wpilog/fixtures/sample-session.jsonl`
- Create: `packages/worker/src/wpilog/fixtures/sample-session.wpilog` (golden file from Go encoder)

**Approach:**
- **Encoder** (`encoder.ts`): low-level primitives — `writeHeader(buf, extraHeader)`, `writeStartRecord(buf, id, name, type, metadata)`, `writeDataRecord(buf, id, ts, payload)`. Uses `DataView` with `setUint*`/`setBigUint64` for little-endian. Accepts a `WritableStreamDefaultWriter<Uint8Array>` so the same primitives can drive a memory buffer OR an R2 multipart upload.
- **Convert** (`convert.ts`): `streamConvert(async function* batchIterator, { team, sessionId, outputWriter })`. Two passes:
  - Pass 1: consumes `batchIterator` (an async generator yielding `Uint8Array` chunks per batch), splits on newlines, parses each line, accumulates `topicOrder: TopicKey[]`, `sessionStartTS`, `minServerTS`. No entries retained.
  - Pass 2: re-consumes the iterator (caller provides it again); writes header + Start control records in `topicOrder` order + data records streaming directly to `outputWriter`.
- `convert.ts` preserves **insertion order** of topics via an explicit array (not Map iteration). Malformed JSONL lines skipped silently to match Go behavior.
- Golden file generated once by running RavenLink's Go encoder over `sample-session.jsonl` and committed. CI asserts byte-for-byte equality against the golden.

**Execution note:** Characterization-first. Write the golden-file byte-equality test first; iterate until green.

**Test scenarios:**
- Happy path — header-only output matches 14-byte reference.
- Happy path — Start record for `(id=1, name='x', type='int64', metadata='')` matches expected bytes.
- Happy path — `streamConvert(sampleJsonl)` produces bytes byte-equal to the committed golden `.wpilog`.
- Edge case — empty input → valid WPILog with header + no records.
- Edge case — only control markers → output with synthesized `/RavenLink/MatchEvent` entries.
- Edge case — `sessionStartTS < minServerTS` does not underflow uint64.
- Edge case — malformed JSONL lines skipped silently; counter returned in result.
- Error path — unsupported NT type throws typed error with key/type.
- Memory — encoding a 32 MB synthetic JSONL (generated in-test) keeps peak heap under 20 MB (measured via `performance.memory` if available or explicit byte counters).

**Verification:** `pnpm -F worker test:wpilog` green including golden byte-compat and memory ceiling.

---

- [ ] **Unit 8: WPILog download route — streaming convert + R2 cache**

**Goal:** Serve `.wpilog` for a given session, generating + caching on first request using the streaming encoder. Cookie-authenticated only — v1 is download-only per the Unit 0-A decision.

**Requirements:** R6.

**Dependencies:** Units 5, 6, 7.

**Files:**
- Create: `packages/worker/src/routes/wpilog.ts`
- Modify: `packages/worker/src/index.ts` to mount `/api/sessions/{id}/wpilog` (cookie auth, OR bearer for AS deep-link depending on Unit 0)
- Modify: `packages/worker/src/storage/r2.ts` — add `streamSessionBatches(sessionId)` async generator, `multipartPutWpilog(sessionId)`
- Test: `packages/worker/test/wpilog-route.test.ts`

**Approach:**
- `GET /api/sessions/{id}/wpilog`:
  1. Cookie auth; ownership check (404 if not in workspace).
  2. Cache hit: `wpilog_key IS NOT NULL AND wpilog_generated_at >= COALESCE(last_batch_at, ended_at, 0)` → stream R2 object directly with `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="{sessionId}.wpilog"`.
  3. Cache miss: create R2 multipart upload, run `streamConvert` with the `batchIterator` being a generator over `list + get` of `batch-*.jsonl`; each written chunk is a multipart part. Complete upload; `UPDATE telemetry_sessions SET wpilog_key = r2_key, wpilog_generated_at = now()`. Then stream the just-created object back.
- SPA "Download .wpilog" button on the session-detail page fetches this endpoint with cookie auth and triggers a browser download via `Content-Disposition: attachment; filename="{sessionId}.wpilog"`. No AdvantageScope deep-link, no signed-URL token mode — both deferred to the future AS integration initiative (see Unit 0-A status and Scope Boundaries).

**Test scenarios:**
- Happy path — first call generates + caches; second call serves from cache; both byte-identical.
- Happy path — cache invalidated by a late `/data` (Unit 5 clears `wpilog_key`); next call regenerates.
- Happy path — cache invalidated by a different `endedAt` on second `/complete`.
- Edge case — zero-batch session returns minimal-but-valid `.wpilog` (header only).
- Edge case — 32 MB synthetic session encodes without exceeding Worker memory limits (streaming path validated).
- Error path — session not in workspace returns 404.
- Error path — R2 outage reading batches returns 503; `wpilog_generated_at` NOT updated.
- Integration — end-to-end: Unit 5 ingest → Unit 7 encoder → Unit 8 route → bytes byte-equal to Unit 7's golden output for the same fixture.

**Verification:** test suite green; the produced `.wpilog` opens in AdvantageScope against a live fixture session (manual check).

---

- [ ] **Unit 9: SPA pages — layout, tree, sign-in, and empty/loading/error states**

**Goal:** Ship the v1 UI with concrete IA: sign-in page (email only) + check-email confirmation page, sessions list with sort/filter controls, session detail with a sticky action bar + searchable tree, API keys page with the plaintext-shown-once modal.

**Requirements:** R1, R2, R4, R5, R6, R8.

**Dependencies:** Units 0-C, 3, 4, 6, 8.

**Design source of truth:** `docs/design/ravenscope-ui.pen` (Unit 0-C). Implementation matches the mockups' layout, type ramp, spacing, and component choices unless native behaviour (focus rings, keyboard affordances, reduced-motion) requires deviation. The tokens enumerated in Unit 0-C map 1:1 to Tailwind v4 `@theme` entries in `packages/web/src/index.css`.

**Files:**
- Create: `packages/web/src/lib/api.ts`, `packages/web/src/lib/auth.ts`
- Create: `packages/web/src/routes/sign-in.tsx`, `check-email.tsx`, `sessions.tsx`, `session-detail.tsx`, `api-keys.tsx`
- Create: `packages/web/src/components/KeyTree.tsx`, `SessionRow.tsx`, `AuthGate.tsx`, `EmptyState.tsx`, `TopNav.tsx`, `Button.tsx`, `Badge.tsx`
- Modify: `packages/web/src/app.tsx` — react-router v6 routes + TanStack Query provider
- Modify: `packages/web/src/index.css` — Tailwind v4 `@theme` tokens from Unit 0-C
- Modify: `packages/web/package.json` — add `@radix-ui/react-dialog`, `@radix-ui/react-collapsible`
- Test: `packages/web/src/components/KeyTree.test.tsx`

**Approach:**
- Data: TanStack Query over `fetch(..., { credentials: 'include' })`. DTOs imported from the worker package via the workspace path.
- Routing: react-router v6 with a single top-level `<AuthGate>` that reads `/api/auth/me` and either renders `<Outlet/>` or redirects to `/sign-in`.
- **`sign-in.tsx`**:
  - Single form: one email field, one `[Send me a sign-in link]` button.
  - On submit: `POST /api/auth/request-link` → on 204, navigate to `/check-email?email=<encoded>`.
  - Inline email-format validation before submit. Server-error banner copy:
    - 429 → "Too many sign-in requests from this address. Please wait a minute and try again."
    - Network → "Couldn't reach RavenScope. Check your connection and try again."
  - Below the form, a short one-liner: "No password. We'll email you a link to sign in."
- **`check-email.tsx`**:
  - Shows: "We've emailed a sign-in link to **<email>**. It expires in 15 minutes. Check your inbox — and your spam folder if it's not there." Plus a `[Use a different email]` link back to /sign-in.
  - When a user clicks the link in their email they land on `/api/auth/verify?t=...`, which 302s to `/`; they never hit this page again in that flow.
- **No password-reset route** — not applicable. No `forgot-password` link anywhere.
- **Sessions list** (`sessions.tsx`):
  - Sticky header: page title + search input (`?q=`).
  - Table columns: Event · Match · Started · Duration · Entries. Column headers are `<button>`s that toggle sort/order (updating the URL). Default `sort=started_at&order=desc`.
  - Row click navigates to `/sessions/{id}`.
  - Empty state (via `<EmptyState>`): "No sessions yet. Create an API key and point RavenLink at this URL: `<base_url>`" with a link to `/api-keys`.
- **Session detail** (`session-detail.tsx`):
  - Layout: sticky header row with two regions — left: metadata (event, match, started, duration, entry count, wpilog generation state); right-aligned: `[Download .wpilog]` as the single primary action. No AdvantageScope button — deferred per Unit 0-A status.
  - Below: full-width collapsible tree inside a bordered card with its own sub-header containing a search input, `[Expand all]`, `[Collapse all]`. The tree itself fills viewport height minus the stickies.
  - Leaf card format: `<monospace key name> <badge: nt_type> · N samples · HH:MM:SS – HH:MM:SS` (ts formatted relative to session start in mm:ss.sss if the range is under 5 min, otherwise H:MM:SS).
  - Tree search: filters leaves by case-insensitive substring on the full `/a/b/c` path; matching ancestors auto-expand.
  - Keyboard: arrow up/down moves focus; left/right collapses/expands; enter toggles.
  - Empty state ("No keys captured. The session was created but no NT data was posted.").
  - Loading state: tree skeleton (three gray rows). WPILog button disabled + shows "Generating…" while first request is in flight to prevent double-clicks.
- **API keys** (`api-keys.tsx`):
  - Table: Name · Prefix · Last4 · Created · Last Used · Status (Active/Revoked) · `[Revoke]`.
  - Default sort: created_at desc.
  - `[Create key]` button opens a modal that asks for a name (required, 1–100 chars), then POSTs and shows the returned plaintext in a read-only `<pre>` with a `[Copy]` button and a big `[I've saved this key]` confirmation. Closing the modal without confirmation triggers a "Are you sure? You will NOT be able to see this key again." alert. The key is created regardless — the modal only gates dismissal.
  - Empty state: "No API keys yet. Create one to let RavenLink upload to this workspace."
- Responsive: designed for ≥1024 px viewports; below that the app renders at desktop dimensions with horizontal scroll (explicitly not responsive in v1, per Scope Boundaries).

**Test scenarios:**
- Happy path (component) — KeyTree renders a 3-level tree with expand/collapse, keyboard navigation, and search filtering that auto-expands matching ancestors.
- Edge case (component) — KeyTree with `[]` renders the empty-state card, not a blank region.
- Edge case (component) — Key `/SmartDashboard/.schema/foo` lands under `.schema` correctly (no path-segment collapsing).
- Happy path (integration) — Sign-in form shows mapped error copy on 429 and on network failures; 204 success navigates to /check-email.
- Happy path (integration) — API-key create-modal shows plaintext; closing without acknowledgement triggers confirm dialog; copy button writes to clipboard via `navigator.clipboard.writeText`.
- Manual end-to-end — sign-in (receive email, click link) → see empty sessions list → create API key → run `./ravenlink` (with Unit 0-B patch) pointed at wrangler-dev → see session appear → click in → search tree → download `.wpilog` → AdvantageScope launches (per Unit 0-A outcome).

**Verification:** component tests pass; manual end-to-end flow in a real browser against `wrangler dev`.

---

- [ ] **Unit 10: Deployment + secrets + docs + R8 measurement**

**Goal:** Make RavenScope deployable in under 5 minutes from a fresh CF account, validate R8, document the RavenLink-patch option, and harden the deployment with the bucket privacy check and WAF rule.

**Requirements:** R7, R8.

**Dependencies:** all previous units.

**Files:**
- Modify: `README.md` — overview, "why RavenScope vs RavenBrain" (imports the Alternatives section), quickstart, env vars, security model, RavenLink pointing instructions, rotation procedure, R8 measurement script.
- Create: `.github/workflows/deploy.yml` — on push to main: `pnpm -r typecheck && pnpm -r test && pnpm -r lint && pnpm -r build`, then `wrangler deploy` using `cloudflare/wrangler-action@v3` with `CLOUDFLARE_API_TOKEN` (Workers + D1 + R2 scopes only).
- Create: `scripts/setup.sh` — creates D1 DB, R2 bucket, **verifies R2 bucket has no public access / no r2.dev subdomain / no custom public domain** via the CF API, applies migrations, prompts for and sets `SESSION_SECRET = {"v1": "<32-byte-random>"}`, prompts for `RESEND_API_KEY` and sets it as a Worker secret, prompts for `EMAIL_FROM` (e.g., `no-reply@<your-domain>`) and sets it as a `[vars]` entry.
- Create: `scripts/r8-measurement.md` — a checklist that an external tester runs with a stopwatch: signup, create key, run RavenLink, first session visible. Records elapsed time.
- Modify: `packages/worker/wrangler.toml` — final DO, D1, R2, assets bindings with placeholder IDs.

**Approach:**
- README "Point RavenLink here" section: copy-paste config snippet showing `ravenbrain.url: https://<your-subdomain>.workers.dev` and `ravenbrain.api_key: <rsk_live_...>`. Explicit note: **RavenScope requires a RavenLink build with the Unit 0-B patch** (api_key config + bearer-token mode). Legacy RavenLink builds without the patch will not work — they will attempt to POST `/login` against RavenScope and get 404. Link to the RavenLink release/commit that introduced the patch.
- README "Hosting model" section: **Cloudflare Workers free tier** — 100k requests/day, 10 ms CPU per request, more than enough for a small FRC team. Only external dependency is a Resend API key for emailing magic links (free tier 3,000/mo); alternatives documented (Postmark, Mailgun, CF Email Workers for the adventurous).
- README "Security model": magic-link auth (no passwords stored, ever); tokens are 32-byte random nonces with SHA-256 hashed at rest, 15-min expiry, single-use; SHA-256 for API keys with rationale (32-byte entropy makes preimage attacks infeasible — not extendable to low-entropy secrets); SESSION_SECRET rotation procedure with concrete `wrangler secret put` commands; HTTPS-only middleware; CF WAF rate rule instructions for `/api/auth/request-link` (5 req/IP/min) as defense-in-depth over the DO-based limiter.
- README "Known v1 limitations": no responsive layouts, no offline support, 30-day cookie TTL with no server-side revocation (use SESSION_SECRET rotation as nuclear logout).
- README "Lost access": if you lose access to the email address, the operator can delete the user + workspace and let you sign up fresh with a new address (data under the old workspace is lost). Documented procedure included.
- CF WAF rate-limit rule: documented in README with copyable expressions; belt-and-braces over the DO-based limiter in Unit 3.
- R8 measurement: scripts/r8-measurement.md defines the exact checklist. Target: < 5 minutes from CF signup to first session visible.

**Test scenarios:** Test expectation: none — this unit is deployment plumbing, docs, and a measurement checklist.

**Verification:**
- A fresh CF account reaches `wrangler deploy` green in under 15 minutes using only the README (already in plan).
- R8 measurement: a first-time tester with the R8 checklist reports elapsed time under 5 minutes (record the number; if over, identify the blocking friction step).
- setup.sh refuses to complete if the R2 bucket has public access enabled.

## System-Wide Impact

- **Interaction graph:** Ingest writes go through the per-session DO, which in turn writes R2 + D1. Reads for the key tree hit R2 (cached JSON) or derive from R2 JSONL. WPILog export streams R2 → encoder → R2 multipart. Cookie auth on web routes; API-key bearer on ingest; the two never mix.
- **Error propagation:** R2 failures in the DO return 503 with no D1 mutation so RavenLink retries cleanly. D1 failures after a successful R2 write leave an orphan object that gets deterministically overwritten on retry because the DO preserves its local `seq` until D1 confirms. HTTPS-only middleware rejects any plaintext request before any handler runs.
- **State lifecycle:** Late batches after `/complete` are accepted, bump `entry_count`/`last_batch_at`, and clear `wpilog_key` + `wpilog_generated_at` atomically. The `wpilog_generated_at >= COALESCE(last_batch_at, ended_at, 0)` comparison handles both normal and late-batch cases without ambiguity.
- **API surface parity:** Telemetry endpoints must stay byte-compatible with RavenBrain's `TelemetryApi` records; future scope creep that changes shapes will break RavenLink silently.
- **Integration coverage:** The ingest → DO → tree → wpilog pipeline has a dedicated `end-to-end.test.ts` in Unit 5 that drives the whole thing against a miniflare + R2-shim harness.
- **Unchanged invariants:** RavenBrain's `TelemetryApi` wire contracts and RavenLink's `uploader.go` both remain untouched for v1. Users retarget RavenLink via config alone.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| RavenLink's `/login` → JWT flow is mandatory in existing builds; RavenScope exposes no `/login`. | Unit 0-B patches RavenLink to add a bearer-token `api_key` mode. This patch is a hard prerequisite; RavenScope releases note the minimum RavenLink version. No shim in RavenScope. |
| D1 has no multi-statement read-then-write transactions. | SessionIngestDO serializes per-session writes. D1 only sees `db.batch()` atomic groups for dependent multi-row updates. |
| Resend free tier cap (3,000 emails/month) can be exhausted by abusive magic-link requests. | Rate-limit middleware enforces 5/IP/min AND 3/email/10-min on `/api/auth/request-link`. At 3 req/email over 10 min across ~100 distinct emails per day, quota isn't at risk under normal abuse. README documents how to upgrade Resend tier or swap to a different provider (Postmark, Mailgun, CF Email Routing + Email Workers). |
| Resend outage blocks all sign-ins. | Exponential backoff with 3 attempts in the email sender; on ultimate failure, request-link route returns 204 (silent success) and the `audit_log` row records `email_send_failed: true` so operators can see it. Existing cookies continue to work; only new sign-ins are blocked. |
| Magic-link URL captured (e.g., email forwarding rule, shared inbox, browser extension). | 15-minute expiry; single-use; used_at check prevents replay. README calls out the risk. |
| Lost email address = lost account access. | README documents this up front — it's the core tradeoff of passwordless auth. Operator (Jeff) has D1 access and can manually delete a user + workspace on request. |
| A stolen session cookie is valid for its 30-day TTL. | Accepted — no server-side revocation store in v1. SESSION_SECRET rotation is the nuclear option for all-session logout. |
| WPILog export memory for large sessions. | Streaming two-pass encoder + R2 multipart upload keeps peak heap session-size-independent. Memory test in Unit 7 asserts the ceiling. |
| AdvantageScope deep-link support is unverified. | Unit 0-A spike runs before any other Unit; Unit 8 picks cookie / signed-token / manual-download based on the outcome. |
| Go↔TS WPILog encoder drift. | Golden-file byte-compat test in Unit 7; CI guard — when RavenLink's encoder changes, regenerate the golden and re-run the comparison. |
| CF R2 bucket accidentally made public. | scripts/setup.sh verifies privacy via CF API; README calls it out; Unit 10 verification fails if bucket is public. |
| A stolen session cookie is valid for its 30-day TTL. | Accepted — no server-side revocation store in v1. SESSION_SECRET rotation is the nuclear option for all-session logout. |

## Documentation / Operational Notes

- README sections: Overview, Why RavenScope vs RavenBrain (imports Alternatives), Hosting model + cost, Security model, Quickstart, Pointing RavenLink at RavenScope, Known v1 limitations, SESSION_SECRET rotation, CF WAF configuration, R8 measurement.
- Wrangler tail is the primary live observability surface. Audit log in D1 is the durable surface.
- A `scripts/rotate-session-secret.sh` helper is documented in README (but not required — implementers may add it if natural during Unit 10).

## Sources & References

- Related code (external, read-only): `~/src/1310/RavenLink/internal/uploader/uploader.go`, `~/src/1310/RavenLink/internal/uploader/auth.go`, `~/src/1310/RavenLink/internal/wpilog/encoder.go`, `~/src/1310/RavenLink/internal/wpilog/convert.go`, `~/src/1310/RavenLink/internal/ntlogger/logger.go`
- Related contracts (external, read-only): `~/src/1310/RavenBrain/src/main/java/ca/team1310/ravenbrain/telemetry/TelemetryApi.java`, `TelemetrySession.java`, `TelemetryEntry.java`
- External docs: Hono CF Workers guide, Cloudflare Workers Static Assets, Cloudflare Durable Objects, Drizzle D1 tutorial, Cloudflare R2 Workers API, WPILog v1.0 spec, AdvantageScope URL launch docs (TBD Unit 0-A), Resend API reference
