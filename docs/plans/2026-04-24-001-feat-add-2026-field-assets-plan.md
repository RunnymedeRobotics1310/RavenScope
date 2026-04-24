---
title: "feat: Add 2026 FRC field assets to embedded AdvantageScope Lite"
type: feat
status: active
date: 2026-04-24
---

# feat: Add 2026 FRC field assets to embedded AdvantageScope Lite

## Overview

The embedded AdvantageScope Lite viewer (`/v/:id/`) renders the 2D and 3D
field tabs using a bundled asset set that is fully determined by
AdvantageScope's own `bundleLiteAssets.mjs`. That script hardcodes the asset
list it pulls from `Mechanical-Advantage/AdvantageScopeAssets@archive-v1`,
and the hardcoded list stops at 2025 FRC + 2024–2025 FTC. The 2026 FRC
assets (`Field2d_2026FRCFieldV1`, `Field3d_2026FRCFieldV1`) are published
upstream at the same tag but never get baked into our bundle, so RavenScope
users see only 2025 in the field selector.

Fix: extend `packages/web/scripts/publish-advantagescope-bundle.mjs` with a
RavenScope-owned "extra assets" step that downloads additional asset zips
from the same upstream release into `lite/static/bundledAssets/<name>/`
after AS's own postinstall but before the tarball is packed. The list lives
in a new committed file `packages/web/advantagescope/extra-assets.txt`.
Seed it with the two 2026 FRC entries only. Re-run the publish ritual,
update `checksums.txt` + `version.txt`, push the new tarball as a
RavenScope GitHub release.

Nothing changes in the Worker, the web SPA, or `fetch-advantagescope.mjs` —
the manifest generator already walks `bundledAssets/` and picks up whatever
lands there.

---

## Problem Frame

Teams running 2026 FRC code want to see their robot on the correct field
when they open a session. Today the field selector inside the embedded
viewer only offers 2025 (and evergreen). This is a one-line fix in AS
upstream (add `Field2d_2026FRCFieldV1`, `Field3d_2026FRCFieldV1` to
`githubAssetNames` in `bundleLiteAssets.mjs`) that we don't control —
`bundleLiteAssets.mjs` is AS source, not something we vendor. We need
our own injection point.

---

## Requirements Trace

- R1. A RavenScope session opened in the embedded viewer exposes a
  "2026 Field" option in both the 2D Field and 3D Field tab's field
  selector, rendered from the upstream `Field2d_2026FRCFieldV1` and
  `Field3d_2026FRCFieldV1` asset bundles.
- R2. The mechanism for adding more extra assets is a single committed
  text file — adding a future season or custom field does not require
  editing the publish script.
- R3. The existing tarball-SHA integrity contract still holds: the
  extra assets are part of the tarball, pinned by one SHA in
  `checksums.txt`, fetched from a RavenScope-owned GitHub release.
- R4. No AS source files land in the RavenScope repo. Preserves the
  constraint from the embed plan (`docs/plans/2026-04-23-003-feat-embed-advantagescope-plan.md`
  R4).
- R5. No additional GitHub network calls in CI — `fetch:advantagescope`
  still pulls exactly one tarball.

---

## Scope Boundaries

- Not shipping a per-team custom-asset upload UI. Matches the embed
  plan's deferred item (`docs/plans/2026-04-23-003-feat-embed-advantagescope-plan.md`
  Scope Boundaries, first bullet).
- Not switching the asset delivery posture off Workers Static Assets.
- Not adding 2025–2026 FTC assets. Users asked about FRC 2026; FTC
  extras can be added later by appending to `extra-assets.txt`.
- Not upstreaming the 2026 additions to AS (the fix in AS is trivial
  and they will likely add it themselves as the season ramps; if they
  do, we can shrink `extra-assets.txt` back down). Worth noting but
  not blocking.

### Deferred to Follow-Up Work

- **Upstream PR to AS's `bundleLiteAssets.mjs`** adding the 2026 entries.
  Low-stakes, one-line; open once v1 of this plan lands so we're not
  blocked on upstream review timing.

---

## Context & Research

### Relevant Code and Patterns

- `packages/web/scripts/publish-advantagescope-bundle.mjs` — the
  developer ritual. Modification site. Current flow: checkout AS tag →
  `npm ci` → explicit `npm run postinstall` (runs `bundleLiteAssets.mjs`
  → populates `lite/static/bundledAssets/`) → `wasm:compile` →
  `ASCOPE_DISTRIBUTION=LITE npm run compile` → `docs:build-embed` →
  tar `lite/static` → SHA → write `checksums.txt`. The extra-assets
  step slots in between `docs:build-embed` and `tar`.
- `packages/web/scripts/fetch-advantagescope.mjs:87` — `writeAssetsManifest`
  walks `bundledAssets/` and emits `assets-manifest.json` with every
  directory found. No code change needed here.
- `packages/web/advantagescope/version.txt` — current pin:
  `as=v27.0.0-alpha-4`, `bundle=advantagescope-lite-v27.0.0-alpha-4`,
  `release-url=...advantagescope-lite-v27.0.0-alpha-4.tar.gz`. Must
  bump the `bundle` suffix and the `release-url` when republishing.
- `packages/web/advantagescope/checksums.txt` — pinned SHA-256 of the
  tarball. Must be regenerated.
- `packages/web/advantagescope/main.ts.patch` — reference pattern for
  "RavenScope-owned modifications applied during the AS build." The
  new `extra-assets.txt` is the same idea for data instead of code.
- `~/src/1310/AdvantageScope/bundleLiteAssets.mjs:17–28` — the hardcoded
  list we cannot edit without patching AS source. Confirms the miss.
- AdvantageScopeAssets release:
  `https://api.github.com/repos/Mechanical-Advantage/AdvantageScopeAssets/releases/tags/archive-v1`
  — confirmed contains `Field2d_2026FRCFieldV1.zip` and
  `Field3d_2026FRCFieldV1.zip`.

### Institutional Learnings

- None captured yet in `docs/solutions/` (per embed plan, that store
  is still greenfield).

### External References

- AdvantageScopeAssets `archive-v1` release notes + file listing (API
  verified 2026-04-24).

---

## Key Technical Decisions

- **Download via `unzip` CLI shelled out, not a new npm dep.** `unzip`
  is on every macOS/Linux dev machine and CI. The existing publish
  script already shells out to `tar`, `git`, `npm`, `gh` via
  `spawnSync`. One more command matches the style and adds no
  dependency. Alternative considered: add `unzipper` to
  `packages/web/devDependencies` — rejected, adds a real dep for one
  script run by one developer.
- **Fetch via Node native `fetch`, write to disk, then `unzip -q`.**
  Same pattern as `fetch-advantagescope.mjs`'s tarball download.
  Keeps memory use bounded for the 3D field's larger GLBs (the
  2026 3D asset is ~few MB).
- **Download target is `lite/static/bundledAssets/<AssetName>/`,
  named identically to the zip's top-level directory.** AS's asset
  loader and our `writeAssetsManifest` both key off directory name.
  The zips in `archive-v1` are structured so that extracting into
  `bundledAssets/` produces exactly `bundledAssets/<AssetName>/config.json`
  and peers. Verified by inspecting a downloaded zip's layout during
  planning.
- **Ordering: extra assets are added AFTER AS's postinstall and AFTER
  all AS build steps.** Placement matters because AS's
  `bundleLiteAssets.mjs` deletes and repopulates `bundledAssets/`
  whenever the listing doesn't match its hardcoded set. On a repeat
  publish run, our extras from the previous run would otherwise be
  observed, trigger the mismatch branch, and get wiped. Our step
  runs strictly after any AS script that could touch that directory,
  so on each invocation the sequence is: AS wipes and refills with
  its 10 defaults → we add 2026 FRC on top → tar. Idempotent across
  repeat invocations.
- **Bundle tag bump strategy.** Because the extras live in the tarball
  and not in AS, a new RavenScope bundle tag is needed even though
  the AS tag is unchanged. Use a `-rs2` (RavenScope revision 2)
  suffix: `advantagescope-lite-v27.0.0-alpha-4-rs2`. Documented in
  README as part of the version-bump ritual. Keeps AS pin legible
  (`as=v27.0.0-alpha-4` stays) while uniquely identifying each
  RavenScope-published artifact.
- **`extra-assets.txt` format: one asset name per line, `#` comments,
  blank lines ignored.** Matches the shell/config-file convention
  already familiar from `version.txt`. No structured format (YAML/JSON)
  because a plain list is all we need and the shape is stable.

---

## Open Questions

### Resolved During Planning

- **Do the 2026 assets actually exist upstream?** Yes —
  `Field2d_2026FRCFieldV1.zip` and `Field3d_2026FRCFieldV1.zip` are
  present in `Mechanical-Advantage/AdvantageScopeAssets@archive-v1`
  (verified via GitHub API, 2026-04-24).
- **Does the manifest generator need changes?** No — it already walks
  whatever is under `bundledAssets/`.
- **Does AS's viewer auto-discover assets from the manifest?** Yes.
  The manifest shape produced by `writeAssetsManifest` mirrors AS's
  Python reference server's `/assets` response (a map of relative
  path → config.json contents or null). AS's frontend iterates the
  response and builds its field selector from the discovered
  directories — no allow-list on the client side.
- **Will future AS version bumps clobber our mechanism?** Only if AS
  moves its asset staging directory or renames `bundledAssets/`. Our
  step writes into the same path AS's postinstall writes into, so
  as long as AS keeps that layout, we keep working. Documented as a
  risk.

### Deferred to Implementation

- **Exact tarball-size delta** for bundling the 2026 assets. Will
  surface during the first successful publish run; document in the
  PR description for visibility but no blocker unless it crosses the
  Workers Static Assets per-file cap (25 MiB) — unlikely given
  peer 2025 assets fit comfortably.

---

## Implementation Units

- [ ] U1. **Extend publish script with RavenScope extra-assets step**

**Goal:** `publish-advantagescope-bundle.mjs` reads a new
`packages/web/advantagescope/extra-assets.txt`, downloads each listed
asset's `.zip` from `Mechanical-Advantage/AdvantageScopeAssets@archive-v1`,
extracts it into `<asPath>/lite/static/bundledAssets/<AssetName>/`, and
then tars as before.

**Requirements:** R1, R2, R3, R4, R5.

**Dependencies:** None.

**Files:**
- Create: `packages/web/advantagescope/extra-assets.txt`
- Modify: `packages/web/scripts/publish-advantagescope-bundle.mjs`
- Modify: `README.md` — mention `extra-assets.txt` in the version-bump
  ritual section (short, one paragraph).

**Approach:**
- `extra-assets.txt` seeded with:

        # RavenScope-bundled extras on top of AS's default asset set.
        # One asset name per line (matches a zip at
        # https://github.com/Mechanical-Advantage/AdvantageScopeAssets/releases/tag/archive-v1).
        # Extracted into lite/static/bundledAssets/<name>/ by
        # publish-advantagescope-bundle.mjs.
        Field2d_2026FRCFieldV1
        Field3d_2026FRCFieldV1

- Add a `readExtraAssets()` helper that parses the file (skip blank
  lines, strip `# …` comments, trim). Return `string[]`.
- Add a `downloadAndExtractExtras(liteAssetsDir, names)` helper:
  - Build URL: `https://github.com/Mechanical-Advantage/AdvantageScopeAssets/releases/download/archive-v1/<name>.zip`
  - Fetch to a temp path (`.advantagescope-cache/extras/<name>.zip`,
    reused across runs so a rerun without network is possible).
  - `spawnSync("unzip", ["-q", "-o", zipPath, "-d", liteAssetsDir])`
    — `-o` overwrites so reruns are idempotent; `-q` keeps output
    quiet.
- Invoke the extras step in `main()` after the `docs:build-embed`
  call and before the `tar` call. Log each name as it's added.
- Keep all other ordering and behavior identical.

**Execution note:** None. This is a pure additive change to a
developer-only script; no runtime code path is affected until the
new tarball is published and fetched.

**Patterns to follow:**
- Existing `spawnSync` usage in the same file (`git`, `npm`, `tar`,
  `gh`). Match the `sh(cwd, cmd, args)` helper shape and
  `log(msg)` / `fail(msg)` helpers.
- `fetch-advantagescope.mjs`'s `downloadTarball` for the Node native
  `fetch` idiom (error on `!res.ok`, write via
  `Buffer.from(await res.arrayBuffer())`).

**Test scenarios:**
- Test expectation: none — developer ritual, same posture as the
  existing `publish-advantagescope-bundle.mjs` (per
  `docs/plans/2026-04-23-003-feat-embed-advantagescope-plan.md` U2b).
  Correctness is verified end-to-end in U2 (run ritual → run fetch
  → open viewer → see 2026 in the field selector).

**Verification:**
- Dry read: the script parses an `extra-assets.txt` with comments +
  blanks correctly by manual reading of the parser.
- Integration (U2): after running the publish ritual, the produced
  tarball contains
  `static/bundledAssets/Field2d_2026FRCFieldV1/config.json` and
  `static/bundledAssets/Field3d_2026FRCFieldV1/config.json` plus
  model/image files.

---

- [ ] U2. **Republish the bundle, update pins, ship**

**Goal:** Execute the dev ritual with the new publish script against
the already-pinned AS tag (`v27.0.0-alpha-4`), attach the new tarball
to a fresh GitHub release, and commit the updated pins.

**Requirements:** R1, R3, R5.

**Dependencies:** U1.

**Files:**
- Modify: `packages/web/advantagescope/version.txt` — bump `bundle=`
  and `release-url=` to the new tag (e.g.
  `advantagescope-lite-v27.0.0-alpha-4-rs2`). Leave `as=` unchanged.
- Modify: `packages/web/advantagescope/checksums.txt` — regenerated
  by the publish script.

**Approach:**
- `AS_PATH=~/src/1310/AdvantageScope pnpm -F @ravenscope/web publish:advantagescope-bundle`.
- Verify the new tarball at `packages/web/.advantagescope-cache/advantagescope-lite-v27.0.0-alpha-4-rs2.tar.gz`
  inflates to include `static/bundledAssets/Field{2d,3d}_2026FRCFieldV1/`.
- `gh release create advantagescope-lite-v27.0.0-alpha-4-rs2 <tarball>
  --title "advantagescope-lite-v27.0.0-alpha-4-rs2"
  --notes "RavenScope bundle rev 2: adds 2026 FRC field assets (2D + 3D)"`
- Edit `version.txt` to set the new `bundle=` and `release-url=`.
  (Checksums file is auto-written by the publish script.)
- `pnpm -F @ravenscope/web fetch:advantagescope` — sanity-check the
  new tarball round-trips.
- `pnpm -F @ravenscope/web build` — confirm the web bundle builds.
- Commit `version.txt` + `checksums.txt`, open PR.

**Execution note:** Developer ritual. Runs against real GitHub; no
unit tests.

**Patterns to follow:**
- The existing README version-bump section (added by U8 of the
  embed plan).

**Test scenarios:**
- Test expectation: none — executed ritual. Manual verification in
  the Verification list.

**Verification:**
- `pnpm -F @ravenscope/web fetch:advantagescope` populates
  `packages/web/public/advantagescope/bundledAssets/Field2d_2026FRCFieldV1/`
  and `.../Field3d_2026FRCFieldV1/`.
- Generated `assets-manifest.json` contains keys
  `Field2d_2026FRCFieldV1/config.json` and
  `Field3d_2026FRCFieldV1/config.json` with parsed-JSON values (the
  manifest generator inlines `config.json` contents).
- `pnpm -F @ravenscope/web dev`, open a seeded RavenScope session's
  `/sessions/:id/view` route: the 2D Field and 3D Field tabs both
  list "2026 Field" as a selectable option; choosing it renders the
  2026 layout without console errors.
- `packages/web/dist/advantagescope/bundledAssets/` in the production
  build contains the 2026 directories.
- `curl -s https://<worker-preview>/v/<session-id>/assets` returns a
  manifest JSON that includes the 2026 config entries.

---

## System-Wide Impact

- **Interaction graph:** None. The Worker's `/v/:id/*` route group
  already serves whatever is under `packages/web/public/advantagescope/`
  via the static proxy; the `/v/:id/assets` endpoint reads
  `assets-manifest.json` verbatim. No new code path.
- **Error propagation:** If a listed extra asset zip is missing
  upstream or the network fails during the publish ritual, the
  publish script fails loudly (inherited `spawnSync` exit-status
  check + our own error on non-OK `fetch`). No partial tarball is
  shipped because the tar + SHA happen at the end.
- **State lifecycle risks:** None — the change is entirely offline/
  asset-pipeline. No R2 or D1 writes introduced.
- **API surface parity:** Unchanged. `/api/*` and `/v/:id/*` contracts
  are identical.
- **Integration coverage:** Covered by U2's end-to-end manual check
  — there's no smaller unit of this change to test in isolation that
  would be more useful.
- **Unchanged invariants:** The four HTTP endpoints AS Lite consumes,
  the Worker-proxy posture, the iframe sandbox attributes, the
  `fetch-advantagescope.mjs` script, and all existing asset bundles
  are untouched. This plan strictly adds two directories to the
  tarball and rolls the pin.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| AS renames or relocates `lite/static/bundledAssets/` in a future tag, causing our extras to land in the wrong place or get wiped after we write them | U1's step runs last in the publish flow, so nothing downstream in AS can touch the directory. A future AS version bump already triggers a publish re-run; if the directory layout moved, the first re-publish surfaces the problem — fix by updating the path in `publish-advantagescope-bundle.mjs` at that time. |
| Upstream adds 2026 to AS's `bundleLiteAssets.mjs` before we cut a new bundle, causing duplicate downloads (theirs + ours into the same dir) | `unzip -o` overwrites silently; the end state is identical bytes either way. On observing the upstream change, delete the matching lines from `extra-assets.txt` to keep the mechanism tidy. |
| 2026 3D asset size pushes the bundle tarball past Workers Static Assets per-file cap (25 MiB) | The tarball itself is served from a GitHub release, not from Workers Static Assets; only the extracted files are served via `env.ASSETS`. Individual files (`model.glb`, etc.) are well below the cap. If a single file is over, `writeAssetsManifest` still works but the file 404s at request time — caught by U2's manual check. |
| `unzip` missing on CI runner (if this ever moves into CI) | Not in scope — publish is a developer ritual. If it ever moves into CI, a one-line `apt install unzip` or Docker base image precondition addresses it. |

---

## Documentation / Operational Notes

- **README.md:** add one paragraph to the AdvantageScope version-bump
  ritual section explaining `extra-assets.txt` and the `-rsN` bundle
  suffix convention.
- **Runbook:** no change. No new production surface.
- **Monitoring:** no change.
- **Rollout:** atomic with the pin-update PR. If the 2026 asset has
  a rendering issue in AS Lite itself, revert the `version.txt` +
  `checksums.txt` change to the prior `-alpha-4` bundle; the previous
  tarball remains attached to its release.

---

## Sources & References

- **Embed plan (parent context):**
  [docs/plans/2026-04-23-003-feat-embed-advantagescope-plan.md](./2026-04-23-003-feat-embed-advantagescope-plan.md)
- **Publish script:** `packages/web/scripts/publish-advantagescope-bundle.mjs`
- **Fetch script (manifest gen):** `packages/web/scripts/fetch-advantagescope.mjs:87`
- **AS asset loader (upstream, reference only):**
  `~/src/1310/AdvantageScope/bundleLiteAssets.mjs:17–28`
- **AdvantageScopeAssets release:**
  `https://github.com/Mechanical-Advantage/AdvantageScopeAssets/releases/tag/archive-v1`
