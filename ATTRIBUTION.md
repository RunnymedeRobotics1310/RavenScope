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

RavenScope applies one ~8-line patch to AdvantageScope's source during
the bundle build, committed at
[`packages/web/advantagescope/main.ts.patch`](packages/web/advantagescope/main.ts.patch).
The patch adds a `?log=<name>` URL query parameter to AdvantageScope
Lite's `initHub()` so that the session viewer can deep-link directly
into a single log without the user interacting with the download
popup. Applied at build time by
[`packages/web/scripts/publish-advantagescope-bundle.mjs`](packages/web/scripts/publish-advantagescope-bundle.mjs).

The patch is non-invasive and upstreamable; when AdvantageScope ships
native URL-based auto-open support, the patch will be removed.

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

Licenses for individual asset files are carried per-asset in their
respective `config.json` (field `sourceUrl`) or alongside each asset
in the AdvantageScopeAssets repository. See that repository for the
authoritative notices.
