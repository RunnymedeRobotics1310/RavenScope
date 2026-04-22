# RavenScope

Lightweight hosted telemetry bucket for FRC teams, designed as a stripped-down alternative to `RavenBrain`. Runs entirely on Cloudflare (Workers, D1, R2, Durable Objects) with magic-link email auth.

See `docs/plans/2026-04-17-001-feat-ravenscope-greenfield-plan.md` for the v1 plan and `docs/design/ravenscope-ui.pen` for the UI mockups.

## Quickstart

```bash
pnpm install
pnpm -r typecheck
pnpm -r test
pnpm -r build

# Run the Worker locally (requires wrangler dev):
pnpm dev:worker

# Run the SPA against the local Worker:
pnpm dev:web
```

## Repository layout

- `packages/worker` — Hono-on-Workers API, Durable Object per session, D1 + R2 storage, WPILog encoder
- `packages/web` — Vite + React SPA
- `docs/plans/` — plan documents (see Unit 0-C for design-token decisions)
- `docs/design/` — Pencil mockups (`.pen` files)

## Status

Scaffold only — Unit 1 of the greenfield plan. Data model, auth, ingest, and UI land in subsequent units.
