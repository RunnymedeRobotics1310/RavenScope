# RavenScope

Lightweight hosted telemetry bucket for FRC teams, designed as a stripped-down alternative to `RavenBrain`. Runs entirely on Cloudflare (Workers, D1, R2, Durable Objects) with magic-link email auth.

See `docs/plans/2026-04-17-001-feat-ravenscope-greenfield-plan.md` for the v1 plan and `docs/design/ravenscope-ui.pen` for the UI mockups.

## Quickstart

```bash
pnpm install
pnpm -r typecheck
pnpm -r test
pnpm -r build
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

## Repository layout

- `packages/worker` — Hono-on-Workers API, Durable Object per session, D1 + R2 storage, WPILog encoder
- `packages/web` — Vite + React SPA
- `docs/plans/` — plan documents (see Unit 0-C for design-token decisions)
- `docs/design/` — Pencil mockups (`.pen` files)

## Status

Scaffold only — Unit 1 of the greenfield plan. Data model, auth, ingest, and UI land in subsequent units.
