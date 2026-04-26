# RavenScope Development & Self-Hosting

Audience: contributors and teams who want to run their own RavenScope
instance instead of using [ravenscope.team1310.ca](https://ravenscope.team1310.ca).

End users who just want to view match data should start with the
[User Guide](USER-GUIDE.md).

---

## Architecture

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

- **`packages/worker`** — [Hono](https://hono.dev) on Cloudflare
  Workers. Two Durable Object classes (`SessionIngestDO` for
  per-session batch serialisation, `RateLimitDO` for sliding-window
  auth rate limits). [Drizzle ORM](https://orm.drizzle.team) over
  D1. Streaming WPILog encoder.
- **`packages/web`** — [Vite](https://vitejs.dev) + React 19 +
  Tailwind v4 + [Radix](https://www.radix-ui.com) primitives +
  [TanStack Query](https://tanstack.com/query) SPA. Dark-mode Swiss
  Clean visual language (see `docs/design/ravenscope-ui.pen`).

The worker bundles the SPA's static assets via Workers Static Assets,
so a single `wrangler deploy` ships both surfaces. The embedded
AdvantageScope Lite bundle ships under the same static-assets binding
(see [Embedded AdvantageScope](#embedded-advantagescope) below).

### Repository layout

- `packages/worker/` — API, Durable Objects, D1 + R2, WPILog encoder
- `packages/web/` — Vite + React SPA + AdvantageScope bundle
- `scripts/setup.sh` — one-shot Cloudflare bootstrap
- `scripts/seed-sample-session.mjs` — local-dev demo data loader
- `docs/plans/` — historical plan documents
- `docs/brainstorms/` — historical requirements documents
- `docs/design/` — Pencil mockups

---

## Local development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

### Two dev modes — pick one per browser tab

**Worker-only (recommended for end-to-end flows)**

`pnpm dev:worker` builds the SPA, applies local D1 migrations, and
starts wrangler dev. Everything lives at `http://127.0.0.1:8787` —
the API, the built SPA, and the magic-link email URLs. Sign-in,
cookies, and the bearer-ingest path all share one origin.

```bash
pnpm dev:worker
# → http://127.0.0.1:8787
```

**Vite HMR (SPA iteration)**

`pnpm dev:web` runs Vite with hot-module reload at
`http://localhost:5173`. API calls proxy through to the worker.
Useful when you're iterating on the UI and don't want a full rebuild
per change. Caveat: magic-link emails still point at
`127.0.0.1:8787`, so complete the sign-in loop on that origin first
(cookies don't transfer between `127.0.0.1` and `localhost`, which
the browser treats as distinct hosts).

```bash
pnpm dev:worker   # terminal 1
pnpm dev:web      # terminal 2 — then visit http://localhost:5173
```

### Seeding demo data

Once signed in locally, you can populate a non-empty session from the
committed sample fixture:

```bash
# Mint an API key in the UI at /keys, copy the plaintext, then:
node scripts/seed-sample-session.mjs rsk_live_PASTED_KEY
```

The script converts a ~2000-line real match JSONL into
`TelemetryEntryRequest` batches and drives the live ingest pipeline.

---

## Deploying your own instance

### Prerequisites

- A Cloudflare account with Workers, D1, and R2 enabled (all on free
  tier)
- A [Resend](https://resend.com) account with a verified sender
  domain
- `pnpm install` run at the repo root (installs wrangler locally
  into `packages/worker/node_modules`; no global install needed)
- A one-time `pnpm -F @ravenscope/worker exec wrangler login`
- `jq` on your shell path (`brew install jq` / `apt install jq`)

### One-shot bootstrap

```bash
scripts/setup.sh
```

The script is idempotent. It:

1. Verifies `wrangler` is logged in and `jq` is available.
2. Creates (or reuses) a D1 database named `ravenscope` and writes
   its id into `packages/worker/wrangler.toml`.
3. Creates (or reuses) the `ravenscope-blobs` R2 bucket and **verifies
   the bucket has no public access** — no `r2.dev` subdomain, no
   custom public domain. If either is enabled the script refuses to
   continue.
4. Applies D1 migrations to remote.
5. Generates a 32-byte `SESSION_SECRET` as `{"v1": "<base64>"}` and
   sets it as a Worker secret.
6. Prompts for your Resend API key and sets it as `RESEND_API_KEY`.
7. Prompts for a from-address (e.g.
   `no-reply@ravenscope.yourdomain.com`) and writes it into
   `wrangler.toml` under `[vars] EMAIL_FROM`.

When it's done, deploy:

```bash
pnpm build
pnpm -F @ravenscope/worker exec wrangler deploy
```

All deployment commands route through the worker package's local
wrangler install. If you prefer, `cd packages/worker && pnpm exec
wrangler <cmd>` is equivalent.

### Continuous deploy (GitHub Actions)

`.github/workflows/deploy.yml` runs typecheck, test, lint, build,
applies pending D1 migrations, and deploys on every push to `main`.
It needs one repository secret:

- `CLOUDFLARE_API_TOKEN` — a token scoped to **Workers Scripts (Edit)**,
  **D1 (Edit)**, and **R2 (Edit)** for your account. Nothing else.

Commits whose message contains `[skip deploy]` skip the job.

### Pointing RavenLink at your own RavenScope

If you're running RavenLink against your self-hosted RavenScope, set
the `ravenscope.url` config field to your worker URL (e.g.
`https://scope.your-domain.workers.dev`) along with `api_key`. See
RavenLink's documentation for full details.

---

## Security model

### Auth

- **Magic-link email sign-in, no passwords.** Tokens are 32-byte
  random nonces, SHA-256 hashed at rest, 15-minute expiry,
  single-use.
- **Session cookies** are HMAC-SHA256 signed with a versioned key
  (`SESSION_SECRET = {"v1": "…"}`). The cookie payload includes a
  `kid`; verification tries the named key, and on successful
  verification under an older key the cookie is re-signed with the
  current key.
- **API keys** are 32-byte random tokens (`rsk_live_…`) stored as
  SHA-256 hashes. The full plaintext is returned exactly once at
  creation. SHA-256 without salt is appropriate because the secret
  has ≥256 bits of entropy — preimage/rainbow attacks are infeasible.
- **Middleware split.** `requireCookieUser` gates web-UI routes;
  `requireApiKeyUser` gates telemetry ingest. The two never mix — a
  cookie on a telemetry route is 401, a bearer on a web route is
  401.
- **HTTPS-only.** `localhost`/`127.0.0.1` are exempted for `wrangler
  dev`. Every non-HTTPS request in production is rejected with 400.

### Rate limiting

Two caps on `/api/auth/request-link`, enforced by a sliding-window
`RateLimitDO`:

- **5 per IP per minute** — generic abuse mitigation.
- **3 per email per 10 minutes** — specifically prevents an attacker
  from exhausting Resend's 3000/month quota by spamming magic-link
  requests with fabricated addresses.

For defense in depth, optionally configure a Cloudflare WAF
rate-limit rule targeting `/api/auth/request-link` at the zone
level.

### Rotating SESSION_SECRET

Rotation is safe and can be done without signing existing users out:

1. Generate a new 32-byte value:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

2. Add it to the JSON map as a new kid. Example: bump `v1` → `v2`:

   ```bash
   # Existing SESSION_SECRET = {"v1":"<old>"}
   # New value:               {"v1":"<old>","v2":"<new>"}
   pnpm -F @ravenscope/worker exec wrangler secret put SESSION_SECRET
   # Paste: {"v1":"<old>","v2":"<new>"}
   ```

3. Deploy. Newly-issued cookies now carry `kid: "v2"`. Existing
   cookies still validate under `v1` and get re-signed with `v2` on
   the next authenticated request.

4. After at least 30 days (the full cookie TTL — no legacy `v1`
   cookie can still be alive), drop `v1` from the secret:

   ```bash
   pnpm -F @ravenscope/worker exec wrangler secret put SESSION_SECRET
   # Paste: {"v2":"<new>"}
   ```

**Nuclear sign-out.** Want to invalidate every active session
immediately? Remove all existing kids. Every cookie now verifies
under an unknown-kid key and is rejected with `Max-Age=0`, forcing a
fresh sign-in.

---

## Embedded AdvantageScope

RavenScope embeds [AdvantageScope](https://github.com/Mechanical-Advantage/AdvantageScope)
Lite as a static bundle served at `/v/:id/*`. The bundle is built
from a pinned AdvantageScope tag by a local developer ritual (not in
CI — the full build needs Emscripten 4.0.12). To bump the version
or add extra field assets:

```bash
# one-time per machine: install emsdk 4.0.12
git clone https://github.com/emscripten-core/emsdk.git ~/src/emsdk
cd ~/src/emsdk && ./emsdk install 4.0.12 && ./emsdk activate 4.0.12
source ~/src/emsdk/emsdk_env.sh

# edit packages/web/advantagescope/version.txt:
#   - `as=` is the AdvantageScope tag to build against
#   - `bundle=` is the RavenScope-local artifact tag; bump or suffix
#     with -rsN when the AS pin is unchanged but the bundle contents
#     differ (e.g. new extra assets or main.ts.patch changes)

# optionally edit packages/web/advantagescope/extra-assets.txt to add
# asset names from the AdvantageScopeAssets archive-v1 release that
# aren't in AS's own bundleLiteAssets.mjs list (e.g. new seasons)

# build + tar + update checksums.txt
AS_PATH=~/src/1310/AdvantageScope pnpm publish:advantagescope-bundle

# sanity: re-fetch from local cache and verify
pnpm fetch:advantagescope
pnpm -F @ravenscope/web build

# publish the tarball to a RavenScope GitHub release and set
# release-url in version.txt so CI / fresh clones can download it
gh release create <bundle-tag> packages/web/.advantagescope-cache/<bundle-tag>.tar.gz \
  --title "<bundle-tag>" \
  --notes "Bundle update notes…"
```

The embedded viewer pins AdvantageScope `v27.x` (2027-targeted) Lite
build. Inherited omissions (matching the upstream Lite distribution):
video tab, Phoenix Diagnostics, Hoot log format, XR, pop-out
windows, tab-layout JSON export.

`main.ts.patch` is RavenScope's local patch against AdvantageScope's
outer shell (`src/main/lite/main.ts`). It enables the `?log=`
URL-param auto-open feature, the server-authoritative viewer-layout
bootstrap, debounced last-used state PUTs, the `pagehide` beacon
flush, and the cross-frame postMessage bridge for the Layouts
dropdown. Each addition is scoped to existing AdvantageScope message
ports and storage seams — no AS hub or feature code is touched —
so the patch stays compatible across AdvantageScope version bumps.
See [`ATTRIBUTION.md`](../ATTRIBUTION.md) for the full per-feature
description.

---

## Known v1 limitations

- **No FRC-API enrichment.** Session metadata is whatever RavenLink
  sends, verbatim. No tournament/match/playoff joins.
- **No realtime / live-session view.** Ingest-only.
- **Desktop-only UI.** Targets ≥1024 px viewports.
- **No password reset.** There's no password. Lost access to the
  email address = lost access to the workspace until you can receive
  email at that address again. An operator with D1 access can
  manually delete the user/workspace on request, then the address
  signs up fresh.
- **30-day cookie TTL, no server-side revocation.** A stolen cookie
  is valid until it expires, or until `SESSION_SECRET` is rotated.

---

## License

[BSD-3-Clause](../LICENSE). Embeds AdvantageScope (also BSD-3-Clause)
and AdvantageScopeAssets bundles; see [`ATTRIBUTION.md`](../ATTRIBUTION.md)
for the full notices.
