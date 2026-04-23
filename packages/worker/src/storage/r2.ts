import { chargeOrThrow } from "../quota/daily-quota"
import type { WpilogWriter } from "../wpilog/encoder"
import type { Env } from "../env"
import { batchKey, batchPrefix } from "./keys"

/**
 * R2 storage wrappers with transparent gzip compression.
 *
 * Every object RavenScope writes to R2 is gzipped at the wrapper layer
 * and labelled with `httpMetadata.contentEncoding = "gzip"`. Read
 * helpers inspect that metadata and pipe through DecompressionStream
 * when set, passing through otherwise. Pre-change uncompressed objects
 * remain readable during the migration window — the legacy-tolerance
 * path is exercised by seed helpers in tests that bypass the wrapper.
 *
 * Empirical compression on the committed sample-session.jsonl fixture
 * is ~10× (290 KB → ~30 KB). Real match JSONL (12–18 MB) → ~1–2 MB
 * stored.
 */

/* --- gzip helpers -------------------------------------------------- */

/** Gzip a Uint8Array in one shot using the web-standard CompressionStream. */
export async function gzipEncode(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip")
  const writer = cs.writable.getWriter()
  const writePromise = (async () => {
    await writer.write(bytes)
    await writer.close()
  })()
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = cs.readable.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.length
      }
    }
  } finally {
    reader.releaseLock()
  }
  await writePromise
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** Is the fetched object gzipped (label set) or legacy uncompressed? */
function isGzipped(obj: R2ObjectBody): boolean {
  return (obj.httpMetadata?.contentEncoding ?? "") === "gzip"
}

/**
 * Returns a ReadableStream<Uint8Array> of the object's **plain** bytes —
 * transparently pipes through DecompressionStream if the stored object
 * is gzipped. Returns null when the key is missing.
 */
export function readPlainBlobStream(obj: R2ObjectBody): ReadableStream<Uint8Array> {
  if (isGzipped(obj)) {
    return obj.body.pipeThrough(new DecompressionStream("gzip"))
  }
  return obj.body
}

/* --- JSONL batch write (per /data call) ---------------------------- */

/**
 * Writes a batch of JSON entries as a gzipped JSONL blob at the
 * canonical key. Returns:
 *   - `key`: R2 key
 *   - `rawByteLength`: raw JSONL length (used as session_batches.byte_length
 *     so that column keeps reading as "size of real data in this batch").
 *   - `storedByteLength`: compressed size written to R2 (used by the
 *     daily-quota `bytes` metric in plan 2026-04-23-001).
 */
export async function putBatchJsonl(
  env: Env,
  sessionDbId: string,
  seq: number,
  entries: unknown[],
): Promise<{ key: string; rawByteLength: number; storedByteLength: number }> {
  // Trailing newline is load-bearing: when streamSessionBatches
  // concatenates successive batches for the wpilog converter, the newline
  // is what separates the last line of batch-N from the first of batch-N+1.
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
  const rawBytes = new TextEncoder().encode(body)
  const compressed = await gzipEncode(rawBytes)
  // Charge compressed bytes + 1 Class A op BEFORE the PUT. Throws
  // QuotaExceededError on cap hit — caller returns 429.
  await chargeOrThrow(env, { bytes: compressed.length, classA: 1 })
  const key = batchKey(sessionDbId, seq)
  await env.BLOBS.put(key, compressed, {
    httpMetadata: {
      contentType: "application/x-ndjson",
      contentEncoding: "gzip",
    },
  })
  return { key, rawByteLength: rawBytes.length, storedByteLength: compressed.length }
}

/** Deletes a single object. Used to clean up orphans on retry paths. */
export async function deleteObject(env: Env, key: string): Promise<void> {
  await env.BLOBS.delete(key)
}

/* --- streaming read over all session batches ---------------------- */

/**
 * Streams every `sessions/<id>/batch-*.jsonl` object in sequence order,
 * yielding **plain** (decompressed) byte chunks. Handles both gzipped
 * objects (new) and uncompressed ones (legacy test fixtures / pre-
 * compression data).
 */
export async function* streamSessionBatches(
  env: Env,
  sessionDbId: string,
): AsyncGenerator<Uint8Array> {
  // List: 1 Class A op.
  await chargeOrThrow(env, { classA: 1 })
  const listed = await env.BLOBS.list({ prefix: batchPrefix(sessionDbId) + "batch-" })
  const keys = listed.objects
    .map((o) => o.key)
    .filter((k) => k.endsWith(".jsonl"))
    .sort()
  for (const key of keys) {
    // Each GET: 1 Class B op.
    await chargeOrThrow(env, { classB: 1 })
    const obj = await env.BLOBS.get(key)
    if (!obj) continue
    const stream = readPlainBlobStream(obj)
    const reader = stream.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) yield value
      }
    } finally {
      reader.releaseLock()
    }
  }
}

/* --- small-blob text read/write (tree.json) ----------------------- */

/** Reads the object as UTF-8 text, decompressing if gzipped. Null if missing. */
export async function readTextBlob(env: Env, key: string): Promise<string | null> {
  // GET: 1 Class B op.
  await chargeOrThrow(env, { classB: 1 })
  const obj = await env.BLOBS.get(key)
  if (!obj) return null
  if (!isGzipped(obj)) return obj.text()
  // Fully drain the decompressed stream into a string. These blobs are
  // small (tree.json is KB-scale), so buffering is fine.
  const stream = obj.body.pipeThrough(new DecompressionStream("gzip"))
  return new Response(stream).text()
}

/** Writes a UTF-8 text blob gzipped, with the given contentType. */
export async function putTextBlob(
  env: Env,
  key: string,
  text: string,
  contentType: string,
): Promise<{ storedByteLength: number }> {
  const compressed = await gzipEncode(new TextEncoder().encode(text))
  await chargeOrThrow(env, { bytes: compressed.length, classA: 1 })
  await env.BLOBS.put(key, compressed, {
    httpMetadata: {
      contentType,
      contentEncoding: "gzip",
    },
  })
  return { storedByteLength: compressed.length }
}

/* --- streaming multipart writer (wpilog output) -------------------- */

/**
 * WpilogWriter implementation that streams through gzip and uploads
 * compressed parts to R2 multipart. Accumulates compressed output
 * until the 5 MiB part threshold is met.
 *
 * Streaming (not buffer-the-whole-file) matters here because a 20 MB
 * session's WPILog output is too large to comfortably hold in memory
 * alongside the JSONL input we're iterating. Peak heap stays O(part
 * threshold) = ~5 MiB.
 */
export class R2MultipartWpilogWriter implements WpilogWriter {
  private readonly partThreshold = 5 * 1024 * 1024
  private upload: R2MultipartUpload | null = null
  private parts: R2UploadedPart[] = []

  private compressor: CompressionStream | null = null
  private compressWriter: WritableStreamDefaultWriter<Uint8Array> | null = null
  /** Consumer loop that drains the compressor's readable side into parts. */
  private consumer: Promise<void> | null = null
  /** Any error from the consumer loop (e.g. an R2 part upload failure). */
  private consumerError: unknown = null

  private pending: Uint8Array[] = []
  private pendingSize = 0
  private env: Env | null = null

  constructor(
    private readonly bucket: R2Bucket,
    private readonly key: string,
  ) {}

  async init(env: Env): Promise<void> {
    // init: 1 Class A op. Charge before creating the multipart upload
    // so an over-cap state doesn't leave an unfinished upload in R2.
    await chargeOrThrow(env, { classA: 1 })
    this.env = env
    this.upload = await this.bucket.createMultipartUpload(this.key, {
      httpMetadata: {
        contentType: "application/octet-stream",
        contentEncoding: "gzip",
      },
    })
    this.compressor = new CompressionStream("gzip")
    this.compressWriter = this.compressor.writable.getWriter()
    // Kick off the consumer loop — it runs concurrently with write() calls.
    this.consumer = this.runConsumer(this.compressor.readable.getReader())
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.compressWriter) throw new Error("R2MultipartWpilogWriter: init() not called")
    if (this.consumerError) throw this.consumerError
    if (bytes.length === 0) return
    await this.compressWriter.write(bytes)
  }

  async finalize(): Promise<R2Object> {
    if (!this.upload || !this.compressWriter || !this.consumer || !this.env) {
      throw new Error("R2MultipartWpilogWriter: init() not called")
    }
    // Close the compressor; the consumer loop will drain the final
    // chunks and resolve.
    await this.compressWriter.close()
    await this.consumer
    if (this.consumerError) throw this.consumerError
    // Flush whatever compressed bytes remain in the pending buffer.
    await this.flushPart()
    if (this.parts.length === 0) {
      // Empty input — upload a one-byte empty part so complete() succeeds.
      await chargeOrThrow(this.env, { classA: 1 })
      const emptyPart = await this.upload.uploadPart(1, new Uint8Array(0))
      this.parts.push(emptyPart)
    }
    // complete: 1 Class A op.
    await chargeOrThrow(this.env, { classA: 1 })
    return this.upload.complete(this.parts)
  }

  async abort(): Promise<void> {
    try {
      await this.compressWriter?.abort()
    } catch {
      // best-effort
    }
    if (this.upload) await this.upload.abort()
  }

  private async runConsumer(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<void> {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value || value.length === 0) continue
        this.pending.push(value)
        this.pendingSize += value.length
        if (this.pendingSize >= this.partThreshold) {
          await this.flushPart()
        }
      }
    } catch (err) {
      this.consumerError = err
    } finally {
      reader.releaseLock()
    }
  }

  private async flushPart(): Promise<void> {
    if (this.pendingSize === 0) return
    if (!this.upload || !this.env) {
      throw new Error("R2MultipartWpilogWriter: init() not called")
    }
    const merged = new Uint8Array(this.pendingSize)
    let off = 0
    for (const chunk of this.pending) {
      merged.set(chunk, off)
      off += chunk.length
    }
    // Each uploadPart: 1 Class A + compressed bytes toward the bytes cap.
    await chargeOrThrow(this.env, { bytes: merged.length, classA: 1 })
    const partNumber = this.parts.length + 1
    const part = await this.upload.uploadPart(partNumber, merged)
    this.parts.push(part)
    this.pending = []
    this.pendingSize = 0
  }
}
