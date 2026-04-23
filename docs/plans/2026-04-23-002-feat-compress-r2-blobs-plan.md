---
title: "feat: gzip-compress R2 blobs (JSONL batches, tree.json, wpilog)"
type: feat
status: active
date: 2026-04-23
---

# feat: gzip-compress R2 blobs (JSONL batches, tree.json, wpilog)

## Overview

Compress every object RavenScope writes to R2 with gzip before the PUT,
and decompress transparently on read. JSONL telemetry batches are highly
redundant (repeated NT keys, whitespace, ISO timestamps) and compress at
~8–12×; WPILog output compresses ~3–5×; tree.json ~5×. Expected R2
storage footprint drops by an order of magnitude.

The ingest-wire byte count used by the daily-caps plan
(`2026-04-23-001-feat-daily-usage-caps-plan`) is unchanged — that charge
reflects what crossed the network, not what R2 stores.

## Problem Frame

RavenScope pushes raw JSONL into R2 per `/data` batch. Observed real
session sizes are 12–18 MB of JSONL per match (per the operator's note
on 2026-04-23). A single team season of ~80 matches is ~1 GB raw; a
shared deployment with several teams grows linearly. R2's free-tier
storage is 10 GB before $0.015/GB-month kicks in — we'll blow through
that in a single active season with uncompressed storage even before
any abuse.

JSONL is textbook gzip candidate:

```
{"ts":"2026-04-22T18:00:00.100Z","entryType":"data","ntKey":"/SmartDashboard/Drivetrain/Pose","ntType":"double[]","ntValue":"[0.12,0.34,1.57]"}
{"ts":"2026-04-22T18:00:00.120Z","entryType":"data","ntKey":"/SmartDashboard/Drivetrain/Pose","ntType":"double[]","ntValue":"[0.13,0.35,1.58]"}
```

Lines share a huge common prefix. Empirical compression on the 290 KB
committed `sample-session.jsonl` fixture: **~30 KB gzipped**, ~9.7× ratio.

## Requirements Trace

- **R1.** Every object RavenScope writes to R2 is stored gzipped.
- **R2.** Every read path transparently decompresses, so callers (tree
  builder, wpilog converter, downloaders) don't need to know.
- **R3.** WPILog downloads delivered to the browser are **plain
  uncompressed .wpilog bytes** — the Worker decompresses on the fly
  before sending. No `Content-Encoding: gzip` header on the response.
  AdvantageScope, `curl -O`, and wget all get the same standard WPILog
  regardless of client behaviour around content-encoded downloads.
- **R4.** Byte-for-byte fixtures + golden-file tests still pass — the
  on-disk R2 bytes change, but the observable outputs (tree nodes,
  downloaded `.wpilog` bytes, session detail data) do not.
- **R5.** Compression/decompression runs in streaming mode — a 100 MB
  JSONL batch does not double-buffer into Worker heap.

## Scope Boundaries

- **Only R2 objects — not D1 rows, not HTTP request bodies, not
  response bodies to end users.** D1 doesn't need it (rows are small),
  and the Workers runtime auto-compresses text responses at the edge
  via `Accept-Encoding` handling.
- **gzip only, not brotli or zstd.** gzip is the baseline the browser
  + `CompressionStream` API both support. brotli is slightly better
  but not worth the added complexity in v1.
- **No transcoding of existing R2 objects written before this change.**
  Pre-existing objects stay uncompressed; the read path tolerates both
  (auto-detect via gzip magic bytes) during a short migration window,
  then the legacy code path is removed. Documented as an explicit
  migration step in the unit.
- **No compression level tuning.** `CompressionStream('gzip')` uses
  deflate level 6 (default). Good ratio, fast enough for the Worker
  CPU budget.

### Deferred to Follow-Up Work

- brotli/zstd compression.
- Compression-aware hashing / content-addressed storage.
- Per-object compression-level policy (small objects uncompressed).

## Context & Research

### Relevant Code and Patterns

- `packages/worker/src/storage/r2.ts` — every write (`putBatchJsonl`,
  `R2MultipartWpilogWriter`) and every read (`streamSessionBatches`)
  routes through this file. Single natural extension point.
- `packages/worker/src/ingest/tree-builder.ts` — calls
  `env.BLOBS.get(treeKey(...))` directly. Needs the decompress wrapper.
- `packages/worker/src/routes/wpilog.ts` — streams
  `sessions/<id>/session.wpilog` to the response. With compressed
  storage the response either decompresses in the worker or serves
  with `Content-Encoding: gzip` and lets the browser decompress. See
  Key Technical Decisions.

### External References

- `CompressionStream` / `DecompressionStream` on Workers:
  https://developers.cloudflare.com/workers/runtime-apis/streams/compressionstream/
- R2 `httpMetadata.contentEncoding`:
  https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#object
- gzip magic bytes: `0x1f 0x8b`.

## Key Technical Decisions

- **Store with `contentEncoding: "gzip"` in R2's httpMetadata.** This
  labels the object for the read path — every reader knows whether
  it needs to pipe through DecompressionStream. The metadata is
  informational, not a Worker-runtime content-negotiation trigger,
  so the body we receive from `env.BLOBS.get` is always the raw
  stored bytes (gzipped, in the new world). Decompression is our
  responsibility.
- **Decompress at the wrapper boundary for internal reads.** Tree
  builder + wpilog converter process JSONL line-by-line, so they want
  decompressed bytes. Wrap `env.BLOBS.get()` in a helper that checks
  the object's `contentEncoding`, pipes through
  `DecompressionStream("gzip")` when gzipped, passes through when not.
  This keeps a clean backwards-compat path for any pre-change objects.
- **Legacy-object tolerance is time-limited.** The read path accepts
  both formats for a migration window (one release cycle). After
  that, any remaining uncompressed objects get rewritten on next
  access (opportunistic migration), or we add a one-shot re-gzip
  script if there are many.
- **WPILog downloads decompress in the Worker, serve plain
  uncompressed bytes.** Pipe the stored gzipped body through
  `DecompressionStream("gzip")` and send that as the response body.
  No `Content-Encoding` header. Rationale: uniform behaviour across
  clients (browsers, `curl`, `wget`, AdvantageScope-via-URL when that
  eventually lands), no reliance on user-agent gzip decoding, no
  surprise `.wpilog.gz` filenames on certain browsers. CPU cost of
  streaming decompression on a ~1 MB compressed payload is single-
  digit milliseconds — well inside Worker limits.
- **Multipart writer compresses during the upload, not after.** The
  `R2MultipartWpilogWriter` already accepts streaming writes; we tee
  the stream through `CompressionStream("gzip")` and upload the
  compressed bytes directly. Each 5 MiB part boundary is measured on
  the compressed stream (the 5 MiB R2 minimum applies post-compress).

## Open Questions

### Resolved During Planning

- gzip vs brotli? → gzip for v1 (browser + CompressionStream both
  native).
- Content-Encoding header on wpilog downloads? → yes, lets the browser
  do the decompression on save.
- Legacy (uncompressed) objects? → read path tolerates both during a
  migration window, then legacy support removed.

### Deferred to Implementation

- Exact size threshold below which we skip compression (if any).
  Empirically gzip on a 100-byte payload has ~50 byte overhead; may
  not be worth it. Decide during Unit 1 based on measurement.
- Whether to compress `tree.json` (it's tiny — often < 10 KB). Likely
  yes for consistency, but confirm during Unit 1.

## Implementation Units

- [ ] U1. **Compress-on-write / decompress-on-read in storage/r2.ts**

**Goal:** Wrap every R2 op in gzip + Content-Encoding machinery. Adds
a `readBlobAsStream(key)` helper that checks the stored
`contentEncoding`, pipes through `DecompressionStream("gzip")` when
gzipped, returns a raw `ReadableStream<Uint8Array>` either way.

**Requirements:** R1, R2, R4, R5.

**Dependencies:** None.

**Files:**
- Modify: `packages/worker/src/storage/r2.ts` — compress writes,
  decompress reads, helper functions
- Modify: `packages/worker/src/ingest/tree-builder.ts` — use the
  wrapper when loading + storing tree.json
- Test: `packages/worker/src/storage/r2-compression.test.ts`

**Approach:**
- `putBatchJsonl`: pipe the Uint8Array through CompressionStream,
  collect the compressed chunks, upload with `httpMetadata: {
  contentType: "application/x-ndjson", contentEncoding: "gzip" }`.
- `streamSessionBatches`: on each `env.BLOBS.get`, inspect
  `obj.httpMetadata?.contentEncoding`. If "gzip", pipe
  `obj.body.pipeThrough(new DecompressionStream("gzip"))` before
  yielding chunks. Otherwise yield `obj.body` chunks directly
  (legacy tolerance).
- `R2MultipartWpilogWriter.write`: tee writes through a persistent
  CompressionStream writer initialised in `init()`. finalize()
  flushes the compressor first, then the final multipart part.
- `cacheTree`/`loadCachedTree`: same pattern — compress on put,
  decompress on get.
- The bytes-uploaded charge for the quota system (plan 2026-04-23-001)
  still uses the RAW (uncompressed) input length — the user's mental
  model is "bytes RavenLink sent", not "bytes stored."

**Execution note:** Characterization-first. Write the R2-round-trip
test (put compressed → read back via wrapper → bytes identical) FIRST
so the byte-identity invariant is the gate.

**Test scenarios:**
- Happy path — put 100 KB JSONL, the stored R2 object has
  `contentEncoding: "gzip"` and raw size ~10 KB, and reading back
  through the wrapper returns the original 100 KB.
- Happy path — `convertStreaming` over gzipped batches produces
  byte-identical WPILog to the existing golden fixture (ensures
  round-trip doesn't drift).
- Edge case — legacy uncompressed object (no `contentEncoding`): the
  wrapper returns its body verbatim. tree-builder still parses
  correctly.
- Edge case — corrupted gzip stream (truncated): propagates a
  readable error rather than silently producing garbage.
- Edge case — empty batch (0 bytes input): short-circuits, doesn't
  write an empty R2 object.
- Memory — encoding a 32 MB synthetic JSONL keeps peak heap bounded
  (streaming path verified — no double-buffer of the whole payload).

**Verification:** storage-compression test suite green; manual
`wrangler d1 execute` + `wrangler r2 object get` on a local batch
returns the gzipped bytes with the right Content-Encoding. Re-running
the full Unit 7 golden-file test still passes (byte-compat preserved).

---

- [ ] U2. **WPILog download: decompress in Worker, serve plain bytes**

**Goal:** The `GET /api/sessions/:id/wpilog` response sends plain
uncompressed WPILog bytes regardless of how the object is stored.
The Worker pipes the gzipped R2 body through `DecompressionStream("gzip")`
into the response. No `Content-Encoding` header — clients receive a
standard WPILog file and save it without any decoding quirks.

**Requirements:** R3.

**Dependencies:** U1.

**Files:**
- Modify: `packages/worker/src/routes/wpilog.ts` — pipe the R2 body
  through DecompressionStream when the object is gzipped
- Test: `packages/worker/test/wpilog-download-compression.test.ts`

**Approach:**
- Fetch the R2 object. Read its `httpMetadata.contentEncoding`.
- If `"gzip"`: pipe `obj.body` through `new DecompressionStream("gzip")`
  and hand the resulting stream to the Response constructor.
- If absent / `"identity"` (legacy object): pipe the raw body
  through unchanged.
- Response headers:
  - `Content-Type: application/octet-stream`
  - `Content-Disposition: attachment; filename="<sessionId>.wpilog"`
  - **No** `Content-Encoding`
  - Content-Length omitted (streaming decompression — final size
    isn't known up front). Chunked transfer works for all download
    clients.

**Test scenarios:**
- Happy path — download via `fetch()`: response has NO `Content-Encoding`
  header; `await res.arrayBuffer()` returns plain WPILog bytes
  byte-equal to the convertToBytes golden output.
- Legacy path — pre-compression (uncompressed) R2 object: same
  downloaded bytes.
- Error path — R2 object missing: 404 rather than a decompression
  error.
- Integration — full e2e: ingest → download → bytes byte-equal to
  the golden WPILog fixture from Unit 7 regardless of storage format.
- Edge case — truncated gzip stream: surfaces a readable error, not
  silent data corruption.

**Verification:** download response passes AdvantageScope's file open
(manual check); automated test asserts round-trip byte equality AND
the absence of `Content-Encoding` in the response.

---

## System-Wide Impact

- **Interaction graph:** The storage wrapper layer absorbs all
  compression concerns. Callers (tree-builder, wpilog-converter, the
  download route) see the same ReadableStream<Uint8Array> interface
  they did before.
- **Error propagation:** Decompression errors surface as normal stream
  read errors; existing 503 paths in the ingest DO and the wpilog
  route handle them. Gzip-corrupted objects log + 503 rather than
  silently producing bad output.
- **State lifecycle:** Legacy uncompressed objects written before this
  change remain readable. A future unit can opportunistically re-gzip
  them on next access.
- **API surface parity:** Wire contracts unchanged. RavenLink's POST
  bodies unchanged. Download response adds one header; browsers
  transparently handle it.
- **Quota accounting (plan 2026-04-23-001):** The bytes-stored charge
  is measured AFTER compression at the storage-wrapper layer. The
  1 GiB/day cap therefore tracks actual R2 storage growth — the true
  bill-risk surface. In wire-byte terms the cap is ~10× more generous
  than it looks on paper given typical compression ratios.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Byte-compat golden test in Unit 7 breaks if compression accidentally mutates the payload | Characterization-first in U1: the round-trip test runs before the write path is wired in. |
| Legacy uncompressed objects become unreadable | Read path tolerates both formats during migration window; auto-detect via stored `contentEncoding` metadata. |
| CompressionStream adds Worker CPU time and blows the 10ms/request budget on free tier | gzip level 6 on a 100 KB JSONL batch is ~2–3 ms on Workers. Well inside 10 ms. Measured during Unit 1. |
| Worker CPU budget for per-download decompression | Streaming gzip decompression on a ~1-2 MB compressed payload is ~3-5 ms on Workers. Well inside the 10 ms free-tier CPU budget. Measured during Unit 2. |

## Documentation / Operational Notes

- README — add a sentence to the Architecture section noting that R2
  blobs are gzipped.
- No operational changes required — deploys transparently; existing
  objects remain readable.

## Sources & References

- CompressionStream on Workers:
  https://developers.cloudflare.com/workers/runtime-apis/streams/compressionstream/
- R2 contentEncoding metadata:
  https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#object
- Related plan: `docs/plans/2026-04-23-001-feat-daily-usage-caps-plan.md`
  — the quota plan's bytes-uploaded metric is unaffected by this
  change.
