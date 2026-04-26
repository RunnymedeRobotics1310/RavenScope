# Attribution

RavenScope embeds and redistributes third-party software. Full notices
below.

## AdvantageScope (embedded viewer)

The in-browser session viewer under `/sessions/:id/view` is
**AdvantageScope Lite**, served verbatim as a static bundle at
`/v/:id/*`. Source: <https://github.com/Mechanical-Advantage/AdvantageScope>.

AdvantageScope is distributed under a BSD-3-Clause-style license:

> Copyright (c) 2021-2025 Littleton Robotics. All rights reserved.
>
> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions are met:
>
> - Redistributions of source code must retain the above copyright
>   notice, this list of conditions and the following disclaimer.
> - Redistributions in binary form must reproduce the above copyright
>   notice, this list of conditions and the following disclaimer in the
>   documentation and/or other materials provided with the distribution.
> - Neither the name of Littleton Robotics, FRC 6328 ("Mechanical Advantage"),
>   AdvantageScope, nor the names of other AdvantageScope contributors may be
>   used to endorse or promote products derived from this software without
>   specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY LITTLETON ROBOTICS AND OTHER ADVANTAGESCOPE
> CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT
> NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY NONINFRINGEMENT
> AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL
> LITTLETON ROBOTICS OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
> INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
> NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
> DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY
> OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
> NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
> EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

### Local modifications

RavenScope applies a single patch to AdvantageScope Lite's outer shell
(`src/main/lite/main.ts`) during the bundle build, committed at
[`packages/web/advantagescope/main.ts.patch`](packages/web/advantagescope/main.ts.patch).
Applied at build time by
[`packages/web/scripts/publish-advantagescope-bundle.mjs`](packages/web/scripts/publish-advantagescope-bundle.mjs).

The patch adds RavenScope-specific behavior to the outer AS shell
without modifying AdvantageScope's hub or any tab/feature code:

1. **`?log=<name>` URL auto-open.** Reads the `log` query parameter
   on `initHub()` and dispatches AS Lite's `open-files` message so
   the embedded viewer skips the download popup and lands directly
   on the requested log.
2. **Server-authoritative viewer-layout bootstrap.** Replaces AS
   Lite's `localStorage`-based state restore with a fetch against
   RavenScope's `/api/me/viewer-layout` endpoint. The user's chosen
   default layout (or last-used state) loads on every device,
   browser, and incognito session — surviving Safari ITP eviction
   and storage-quota churn that otherwise reset the layout. Falls
   back to the original `localStorage` path on fetch failure.
3. **Debounced last-used capture.** Hooks the existing `save-state`
   message handler to PUT the captured `HubState` to
   `/api/me/viewer-layout/last-used` after 2 seconds of quiet, plus
   a `pagehide` `sendBeacon` flush so the final state survives a
   tab close.
4. **Cross-frame postMessage bridge.** Installs a same-origin-only
   `ravenscope:viewer` postMessage listener so the RavenScope SPA
   chrome above the iframe can capture the current state ("Save
   layout") or push a new state ("Load layout") without a page
   reload.

The patch hooks AdvantageScope's existing message ports and storage
seams without altering any AdvantageScope feature. Each addition is
independently upstreamable; any of them being adopted by AdvantageScope
upstream would shrink the local patch.

The pinned AdvantageScope release is recorded in
[`packages/web/advantagescope/version.txt`](packages/web/advantagescope/version.txt).

### Bundled third-party dependencies

AdvantageScope in turn redistributes numerous npm packages. The
complete transitive notice file is generated during AdvantageScope's
own build by `getLicenses.mjs` and lands at
`lite/static/docs/build/licenses.html` within the bundle. That file
ships verbatim to `/advantagescope/docs/build/licenses.html` on the
RavenScope origin when the bundle is deployed.

## AdvantageScopeAssets (field and robot 3D models, joystick layouts)

AdvantageScope's bundled default assets (field models, robot models,
joystick layouts) are downloaded from the
[`AdvantageScopeAssets`](https://github.com/Mechanical-Advantage/AdvantageScopeAssets)
`archive-v1` release by AdvantageScope's
[`bundleLiteAssets.mjs`](https://github.com/Mechanical-Advantage/AdvantageScope/blob/main/bundleLiteAssets.mjs)
during AdvantageScope's install step. RavenScope then redistributes
these assets unchanged under
`packages/web/public/advantagescope/bundledAssets/`.

In addition, RavenScope's
[`packages/web/advantagescope/extra-assets.txt`](packages/web/advantagescope/extra-assets.txt)
lists further asset names (e.g. `Field2d_2026FRCFieldV1`,
`Field3d_2026FRCFieldV1`) that the publish script downloads from the
same `archive-v1` release and includes in the bundle. These extras
are redistributed unchanged alongside the upstream defaults.

Licenses for individual asset files are carried per-asset in their
respective `config.json` (field `sourceUrl`) or alongside each asset
in the AdvantageScopeAssets repository. See that repository for the
authoritative notices.
