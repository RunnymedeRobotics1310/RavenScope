# Embed AdvantageScope in RavenScope web UI — requirements

**Date:** 2026-04-23
**Status:** requirements, ready for `/ce-plan`
**Scope classification:** Deep — feature (existing product shape anchors decisions)

## Problem

Today a RavenScope user downloads a session's `.wpilog` and opens it in the
AdvantageScope desktop app. That works, but it requires every teammate who
wants to look at post-match data to install a multi-hundred-MB Electron app.
For casual viewing (mentors on phones, students on a locked-down school
laptop, a quick glance from a scouting tablet) this is a meaningful friction
point and blunts RavenScope's "signup-and-go" positioning.

We want logs to open **inline** in the browser, with the same viewing
experience (timeline, line graphs, 3D field, mechanism views, tables,
console, odometry) that teams already know from desktop AdvantageScope.

## Non-problem / out of scope

- **Building our own log viewer.** AdvantageScope is the reference viewer for
  WPILog; re-implementing even a small subset is a multi-month project and
  drifts behind upstream forever.
- **Replacing the download flow.** `Download .wpilog` stays — users who *do*
  have desktop AdvantageScope and want to mix sessions across logs will keep
  using it. Inline viewing is additive.
- **Live / realtime streaming into the viewer.** Session is already complete
  by the time the user views it; we only need AdvantageScope's historical
  data source path, not NT4 / live server.
- **Video tab, Phoenix Diagnostics, Hoot log format, AdvantageScope XR,
  pop-out windows, tab-layout JSON export.** These are the documented
  omissions of AdvantageScope Lite; we inherit those omissions.

## Users & primary outcome

- **Primary actor:** an FRC team member signed into RavenScope on any device
  with a modern browser (desktop, iPad, Chromebook).
- **Core outcome:** from a session row in RavenScope, click once, land in a
  full-featured AdvantageScope view of that session's data. Zero install,
  zero download, no additional sign-in.

## Solution shape

Embed **AdvantageScope Lite** (the browser-runnable variant shipped under
`lite/` in the AdvantageScope repo, BSD-3-Clause) as a static asset bundle
inside RavenScope's web origin, and re-implement the tiny HTTP contract
Lite expects on the RavenScope Worker so that every iframe instance sees
exactly one log: the session the user is viewing.

### Why this shape works

AdvantageScope Lite was designed to be served from a generic HTTP host
with a `WEBROOT` path prefix. Its frontend uses **only relative-URL
fetches** — two endpoints total:

- `GET /assets` + `GET /assets/<path>` — field / robot / joystick models
- `GET /logs?folder=<p>` + `GET /logs/<file>?folder=<p>` — log directory
  listing and log bytes

Everything else is static files under `lite/static/`. This means we can
mount Lite at a session-scoped path prefix like `/v/<sessionId>/` and the
four endpoints become:

```
/v/<sessionId>/              → serves  lite/static/index.html
/v/<sessionId>/bundles/...   → serves  lite/static/bundles/...
/v/<sessionId>/www/...       → serves  lite/static/www/...
/v/<sessionId>/assets        → RavenScope Worker: returns the default FRC
                               asset manifest (+ any per-team custom assets
                               in a later phase)
/v/<sessionId>/assets/<p>    → RavenScope Worker / R2: returns the asset
                               file bytes
/v/<sessionId>/logs          → RavenScope Worker: returns a single-entry
                               list for this one session: [{ name: "<id>.wpilog",
                               size: N }]
/v/<sessionId>/logs/<name>   → RavenScope Worker: streams the session's
                               cached WPILog bytes from R2 (reusing the
                               existing `/api/sessions/:id/wpilog` logic)
```

Because Lite's fetches are relative to the current page, the `<sessionId>`
acts as both URL scope *and* context for the Worker: the Worker routes
`/v/:id/*` and always knows which session this particular iframe is for.

### Deployment / build pipeline

1. **Pin an AdvantageScope release tag** in `packages/web/advantagescope/version.txt`
   (or equivalent). Start with whatever `v27.x` is current at planning time.
2. **Install-time fetch script** (Node, runs from `packages/web` postinstall
   or an explicit `pnpm fetch:advantagescope`):
   - Downloads the AdvantageScope Systemcore release artifact from GitHub
     releases for the pinned tag.
   - Extracts `lite/static/**` into `packages/web/public/advantagescope/`
     (served as static assets by the Worker's web handler).
   - Separately downloads `AllAssetsDefaultFRC.zip` from
     AdvantageScopeAssets releases (public, stable URL) and extracts into
     a staging dir that gets uploaded to R2 under a versioned prefix
     (`advantagescope-assets/v1/...`). One-time; the Worker's `/assets`
     handler serves from that prefix.
3. **Verifiable upgrade path.** Bumping the version = edit the pinned tag,
   re-run the fetch script, review the diff, commit. No AS source in the
   repo.
4. **License compliance.** BSD-3-Clause requires reproduction of the
   copyright notice and license text. Ship an `ATTRIBUTION.md` (or add to
   existing README) that lists AdvantageScope + all bundled AdvantageScope
   assets and their licenses.

### Auth & origin model

- Lite is served from the **same origin** as RavenScope, so the existing
  signed cookie already protects the `/v/:id/*` routes.
- The Worker enforces that the authenticated user owns (or has access to)
  `:id` for all four dynamic endpoints — same policy as
  `/api/sessions/:id/wpilog` today.
- No cross-origin handshake, no signed URLs, no extra auth token for the
  iframe.

### UX entry point

On the session detail page, add a primary action next to
`Download .wpilog`:

- **"Open viewer"** → full-screen route `/sessions/:id/view` that hosts an
  iframe at `/v/:id/` with a thin RavenScope chrome (session name + close
  button in a small header bar, or simply an unobtrusive overlay close).

### Auto-loading the one log (v1 UX wart)

AdvantageScope Lite today has no URL-param auto-open: the user must go
File → Download Logs → type a folder path → pick the file. For a session
viewer where there is exactly one log that the user already selected by
navigating to this page, that's clearly wrong.

**Recommended v1 approach:** inject a tiny RavenScope bootstrap script
into `lite/static/index.html` during the install-time extraction step.
The script:

- On DOMContentLoaded, uses Lite's existing in-page message plumbing
  (the same postMessage channel the download popup uses to tell the hub
  to open files) to dispatch a synthetic "open-files" message for the
  single known log in this session, using a constant folder path (e.g.
  `"ravenscope"`).
- The Worker's `/v/:id/logs/*` handler ignores the folder parameter and
  always returns the one session log.

This keeps AdvantageScope's source untouched and is the minimum patch
needed to make single-session deep-linking work. If the upstream
maintainers accept a proper `?log=...&folder=...` URL param, we can drop
the bootstrap script in a future upgrade.

**Fallback if injection turns out to be brittle:** upstream a patch, or
carry a tiny diff applied by the install script. Decision deferred to
planning.

## Success criteria

1. From a session detail page, one click lands the user in a fully
   functional AdvantageScope view of that session's data, with no
   additional login, no download, no install.
2. Line graph, 3D field, table, console, odometry, mechanism, and
   joystick tabs all render correctly out of the box for a session whose
   WPILog contains the typical signals RavenLink emits (verified with
   the committed sample session and the RavenScope seed dataset).
3. The AdvantageScope bundle upgrade workflow is a single command
   (`pnpm fetch:advantagescope`) plus a commit, reproducible in CI, with
   no manual file copy.
4. No AdvantageScope source files live in the RavenScope repo. Only the
   pinned tag, the install script, the small bootstrap patch (if used),
   and `ATTRIBUTION.md`.
5. Auth enforcement on `/v/:id/*` is byte-identical to the policy on
   `/api/sessions/:id/wpilog` — a non-owner gets 403/404 on the iframe
   endpoints, which means the embedded AS instance simply shows its
   own "file not found" state.
6. No measurable impact on RavenScope cold-start time (bundle is
   cache-friendly static assets on Workers).

## Scope boundaries

### In v1

- Embed AS Lite pinned to a specific release; serve from Worker static
  assets under `/v/:id/*`.
- Ship default FRC asset bundle (fields, example robots, joysticks) in
  R2 under a versioned prefix. Per-team custom asset upload is **not**
  in v1.
- Auto-open the current session's single log via injected bootstrap
  script (or minimal patch if bootstrap proves unreliable).
- Full-screen viewer route `/sessions/:id/view` linked from session
  detail with an "Open viewer" button.
- `ATTRIBUTION.md` + README mention of AdvantageScope embedding.

### Deferred for later

- **Per-team custom asset upload UI.** Teams with custom fields/robots
  currently need the desktop app or a custom deploy; we can add this
  behind a settings page once v1 lands and usage signals demand it.
- **Multi-session merge.** AS Lite supports merging multiple logs; our
  `/logs` always returns one. Later we could allow selecting 2+ sessions
  from the RavenScope session list and passing them as a merge set.
- **Deep link to a specific tab / field / timestamp.** Would require a
  slightly larger URL contract (upstream change ideal).
- **Upstream contribution** of a proper `?log=&folder=` URL-based
  auto-open to AdvantageScope Lite. Worth opening an issue with the
  Mechanical-Advantage team once v1 ships, but not blocking.

### Outside this product's identity

- **Becoming a general AdvantageScope host.** RavenScope embeds Lite
  *for RavenScope sessions*. We do not expose a generic "upload any
  WPILog and view it" surface — that's a different product and would
  distract from the telemetry-bucket identity.
- **Editing / annotating logs.** Viewing only. Any write path lives in
  the existing RavenScope session model, not in the viewer.

## Dependencies & assumptions

### Hard dependencies

- AdvantageScope Lite ships a stable-enough HTTP contract (`/assets`,
  `/logs`) that we can target. Verified by reading `lite/lite_server.py`
  and the Lite frontend at pinned tag.
- BSD-3-Clause permits redistribution of built artifacts with attribution.
  Verified.
- RavenScope Worker's session-owner authZ check is reusable from the
  existing `/api/sessions/:id/wpilog` route.

### Assumptions worth flagging at plan time

- **AdvantageScope Lite is currently flagged 2027 (v27.x) beta and
  Systemcore-oriented.** We're binding to an actively-moving codebase.
  Risk mitigated by pinning releases and testing the upgrade script
  against a known-good sample session before each version bump.
- **The `AllAssetsDefaultFRC.zip` artifact URL at
  `github.com/Mechanical-Advantage/AdvantageScopeAssets/releases/...`
  is assumed stable.** If that URL pattern changes we update the fetch
  script.
- **The Cloudflare Workers static-asset size budget accommodates
  `lite/static/**`** (a few MB of minified JS + CSS + bundled assets).
  Large asset files (field models, bundledAssets/ images) may be
  better served from R2 rather than Workers static assets — decision
  belongs in planning.
- **Lite's `hub.ts` will happily accept a synthetic `open-files`
  postMessage from our bootstrap script.** Low-risk based on reading
  `src/main/lite/main.ts:219`, but needs a proof-of-concept spike in
  the plan's first step.
- **No user is on a browser that blocks same-origin iframes from
  accessing the enclosing page's cookies under Lax sameSite.** Standard
  assumption for a SPA on one origin.

## Handoff

Next step: `/ce-plan` against this document to produce an implementation
plan with step-by-step tasks, a concrete spike for the bootstrap-script
auto-open, the install script shape, and R2 layout for bundled assets.
