# RavenScope

Lightweight hosted telemetry bucket for FRC teams, built as a stripped-down
alternative to [`RavenBrain`](https://github.com/RunnymedeRobotics1310/RavenBrain).
Runs entirely on Cloudflare (Workers, D1, R2, Durable Objects) with magic-link
email auth. Sign in with an email, mint an API key, point RavenLink at it,
and your match telemetry streams into a hosted session list. Download any
session as a `.wpilog` and open it in AdvantageScope.

- No passwords. No FRC-API calls. No database to host.
- Free-tier friendly: one Worker, one D1, one R2, two Durable Object classes,
  one Resend transactional-email integration.
- Byte-compatible WPILog output — the TypeScript encoder is pinned against
  RavenLink's Go encoder via a golden-file regression test.

## Why RavenScope vs RavenBrain

`RavenBrain` is the canonical destination for RavenLink telemetry — Micronaut
+ MySQL, role-based auth, FRC-API enrichment, mentor-hosted. That's the right
fit for teams who want a rich, queryable, multi-year historical store. It is
not a fit for teams who just want "a place for the robot to dump match data
for post-match review." RavenScope exists for that second bucket of teams.

Alternatives considered and rejected:

- **Extend RavenBrain with a SQLite/Docker profile.** Hosted on a different
  stack, owned by a different maintainer, and even a perfect implementation
  still leaves prospective teams doing Docker-level hosting. RavenScope's
  hosted "signup-and-go" model is a deliberate bet that a free-tier
  Cloudflare surface is strictly easier.
- **Reuse RavenLink's Go WPILog encoder via tinygo → WASM.** tinygo+wasm
  for even small Go packages runs ~800 KB – 1.5 MB and eats isolate
  cold-start. A TypeScript port of `encoder.go` + `convert.go` is ~500
  lines of pure binary encoding, adds ~5 KB, and pins byte-for-byte
  parity with the Go encoder via a golden file. Accepted tax: one
  encoder per language; CI fails if drift appears.
- **Skip R2, persist everything in Durable Objects.** DOs are great for
  serialisation, expensive for bulk blob storage. R2 is the natural fit
  for JSONL and generated WPILogs.

## Architecture at a glance

```
  RavenLink  ─── POST Bearer api_key ───▶  /api/telemetry/*    ───┐
                                                                   ├─▶  SessionIngestDO
                                                                   │     • serialises /data per session
                                                                   │     • R2 write, then D1 batch
                                                                   ▼
  Browser ◀── signed cookie + SPA ────▶  /api/auth/*, /api/sessions/*
                                                                   │
                                                                   ▼
                                              D1  + R2  (batches, tree.json, session.wpilog)
```

- **`packages/worker`** — Hono on Workers, two DO classes (`SessionIngestDO`,
  `RateLimitDO`), Drizzle ORM for D1, streaming WPILog encoder.
- **`packages/web`** — Vite + React + Tailwind v4 + Radix primitives + TanStack
  Query SPA. Dark-mode Swiss Clean visual language (see
  `docs/design/ravenscope-ui.pen`).

## Local development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

### Two dev modes — pick one per browser tab

**Worker-only (recommended for end-to-end flows)**

`pnpm dev:worker` builds the SPA, applies local D1 migrations, and starts
wrangler dev. Everything lives at `http://127.0.0.1:8787` — the API, the
built SPA, and the magic-link email URLs. Sign-in, cookies, and the
bearer-ingest path all share one origin.

```bash
pnpm dev:worker
# → http://127.0.0.1:8787
```

**Vite HMR (SPA iteration)**

`pnpm dev:web` runs Vite with hot-module reload at `http://localhost:5173`.
API calls proxy through to the worker. Useful when you're iterating on
the UI and don't want a full rebuild per change. Caveat: magic-link
emails still point at `127.0.0.1:8787`, so complete the sign-in loop on
that origin first (cookies don't transfer between `127.0.0.1` and
`localhost`, which the browser treats as distinct hosts).

```bash
pnpm dev:worker   # terminal 1
pnpm dev:web      # terminal 2 — then visit http://localhost:5173
```

### Seeding demo data

Once signed in, you can populate a non-empty session from the committed
sample fixture:

```bash
# Mint an API key in the UI at /keys, copy the plaintext, then:
node scripts/seed-sample-session.mjs rsk_live_PASTED_KEY
```

The script converts a ~2000-line real match JSONL into
`TelemetryEntryRequest` batches and drives the live ingest pipeline.

## Deploying to Cloudflare

### Prerequisites

- A Cloudflare account with Workers, D1, and R2 enabled (all on free tier)
- A [Resend](https://resend.com) account with a verified sender domain
- `pnpm install` run at the repo root (installs wrangler locally into
  `packages/worker/node_modules`; no global install needed)
- A one-time `pnpm -F @ravenscope/worker exec wrangler login`
- `jq` on your shell path (`brew install jq` / `apt install jq`)

### One-shot bootstrap

```bash
scripts/setup.sh
```

The script is idempotent. It:

1. Verifies `wrangler` is logged in and `jq` is available.
2. Creates (or reuses) a D1 database named `ravenscope` and writes its
   id into `packages/worker/wrangler.toml`.
3. Creates (or reuses) the `ravenscope-blobs` R2 bucket and **verifies
   the bucket has no public access** — no `r2.dev` subdomain, no custom
   public domain. If either is enabled the script refuses to continue.
4. Applies D1 migrations to remote.
5. Generates a 32-byte `SESSION_SECRET` as `{"v1": "<base64>"}` and sets
   it as a Worker secret.
6. Prompts for your Resend API key and sets it as `RESEND_API_KEY`.
7. Prompts for a from-address (e.g. `no-reply@ravenscope.yourdomain.com`)
   and writes it into `wrangler.toml` under `[vars] EMAIL_FROM`.

When it's done, deploy:

```bash
pnpm build
pnpm -F @ravenscope/worker exec wrangler deploy
```

All deployment commands route through the worker package's local
wrangler install. If you prefer, `cd packages/worker && pnpm exec
wrangler <cmd>` is equivalent.

### Continuous deploy (GitHub Actions)

`.github/workflows/deploy.yml` runs typecheck, test, lint, build, applies
pending D1 migrations, and deploys on every push to `main`. It needs one
repository secret:

- `CLOUDFLARE_API_TOKEN` — a token scoped to **Workers Scripts (Edit)**,
  **D1 (Edit)**, and **R2 (Edit)** for your account. Nothing else.

Commits whose message contains `[skip deploy]` skip the job.

## Pointing RavenLink at RavenScope

**Requires a RavenLink build carrying the bearer-auth patch**
(feat/ravenscope-bearer-auth; see that repo). Legacy RavenLink builds
POST `/login` first and will get 404 from RavenScope — by design, we
don't implement a `/login` shim.

In your RavenLink `config.yaml`:

```yaml
ravenbrain:
  url: https://ravenscope.your-team.workers.dev
  api_key: rsk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

When `api_key` is set, RavenLink's uploader skips `/login` and sends
`Authorization: Bearer <key>` on every telemetry POST. The same API key
works with both wire paths: session create, data batch, and complete.

Alternatives: you can also pass the key via CLI flag
`--ravenbrain-api-key <key>` if you'd rather not put it in
`config.yaml`.

## Security model

### Auth

- **Magic-link email sign-in, no passwords.** Tokens are 32-byte random
  nonces, SHA-256 hashed at rest, 15-minute expiry, single-use.
- **Session cookies** are HMAC-SHA256 signed with a versioned key
  (`SESSION_SECRET = {"v1": "…"}`). The cookie payload includes a `kid`;
  verification tries the named key, and on successful verification
  under an older key the cookie is re-signed with the current key.
- **API keys** are 32-byte random tokens (`rsk_live_…`) stored as
  SHA-256 hashes. The full plaintext is returned exactly once at
  creation. SHA-256 without salt is appropriate because the secret has
  ≥256 bits of entropy — preimage/rainbow attacks are infeasible.
- **Middleware split.** `requireCookieUser` gates web-UI routes;
  `requireApiKeyUser` gates telemetry ingest. The two never mix — a
  cookie on a telemetry route is 401, a bearer on a web route is 401.
- **HTTPS-only.** `localhost`/`127.0.0.1` are exempted for `wrangler
  dev`. Every non-HTTPS request in production is rejected with 400.

### Rate limiting

Two caps on `/api/auth/request-link`, enforced by a sliding-window
`RateLimitDO`:

- **5 per IP per minute** — generic abuse mitigation.
- **3 per email per 10 minutes** — specifically prevents an attacker
  from exhausting Resend's 3000/month quota by spamming magic-link
  requests with fabricated addresses.

For defense in depth, optionally configure a Cloudflare WAF rate-limit
rule targeting `/api/auth/request-link` at the zone level.

### Rotating SESSION_SECRET

Rotation is safe and can be done without signing existing users out.
Procedure:

1. Generate a new 32-byte value:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

2. Add it to the JSON map as a new kid. Example: bump `v1` → `v2`.

   ```bash
   # Existing SESSION_SECRET = {"v1":"<old>"}
   # New value:               {"v1":"<old>","v2":"<new>"}
   pnpm -F @ravenscope/worker exec wrangler secret put SESSION_SECRET
   # Paste: {"v1":"<old>","v2":"<new>"}
   ```

3. Deploy. Newly-issued cookies now carry `kid: "v2"`. Existing cookies
   still validate under `v1` and get re-signed with `v2` on the next
   authenticated request.

4. After at least 30 days (the full cookie TTL — no legacy `v1` cookie
   can still be alive), drop `v1` from the secret:

   ```bash
   pnpm -F @ravenscope/worker exec wrangler secret put SESSION_SECRET
   # Paste: {"v2":"<new>"}
   ```

**Nuclear sign-out.** Want to invalidate every active session
immediately? Remove all existing kids. Every cookie now verifies under
an unknown-kid key and is rejected with `Max-Age=0`, forcing a fresh
sign-in.

## Known v1 limitations

- **Single-owner workspaces.** The schema supports multi-member via an
  `owner_user_id → user_id` shift, but the UI is one-user-per-workspace.
- **No FRC-API enrichment.** Session metadata is whatever RavenLink
  sends, verbatim. No tournament/match/playoff joins.
- **No realtime / live-session view.** Ingest-only.
- **Desktop-only UI.** Targets ≥1024 px viewports.
- **No password reset.** There's no password. Lost access to the email
  address = lost access to the workspace until you can receive email at
  that address again. An operator with D1 access can manually delete
  the user/workspace on request, then the address signs up fresh.
- **30-day cookie TTL, no server-side revocation.** A stolen cookie is
  valid until it expires, or until `SESSION_SECRET` is rotated.
- **No AdvantageScope deep-link.** v1 ships with `.wpilog` download
  only. A future initiative may add an `advantagescope://` launch
  button or an in-browser AdvantageScope port.

## Ergonomic target: R8 measurement

A fresh user should reach "first session visible in the UI" within
**5 minutes** of loading RavenScope for the first time (given a
RavenLink build with the bearer-auth patch and a recorded match
already on disk). See `scripts/r8-measurement.md` for the exact
checklist.

## Repository layout

- `packages/worker` — Hono-on-Workers API, Durable Objects, D1 + R2, WPILog encoder
- `packages/web` — Vite + React SPA
- `scripts/setup.sh` — one-shot Cloudflare bootstrap
- `scripts/seed-sample-session.mjs` — local-dev demo data loader
- `scripts/r8-measurement.md` — ergonomic-target checklist
- `docs/plans/` — plan documents
- `docs/design/` — Pencil mockups

## License

Ask before reusing — this is a team-internal tool for now.
