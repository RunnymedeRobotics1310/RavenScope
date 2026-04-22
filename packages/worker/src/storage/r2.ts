import type { WpilogWriter } from "../wpilog/encoder"
import type { Env } from "../env"
import { batchKey, batchPrefix } from "./keys"

/**
 * Writes a batch of JSON entries as a JSONL blob at the canonical key.
 * Returns the stored byte length for `session_batches.byte_length`.
 */
export async function putBatchJsonl(
  env: Env,
  sessionDbId: string,
  seq: number,
  entries: unknown[],
): Promise<{ key: string; byteLength: number }> {
  // Trailing newline is load-bearing: when streamSessionBatches
  // concatenates successive batches for the wpilog converter, the newline
  // is what separates the last line of batch-N from the first of batch-N+1.
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
  const bytes = new TextEncoder().encode(body)
  const key = batchKey(sessionDbId, seq)
  await env.BLOBS.put(key, bytes)
  return { key, byteLength: bytes.length }
}

/** Deletes a single object. Used to clean up orphans on retry paths. */
export async function deleteObject(env: Env, key: string): Promise<void> {
  await env.BLOBS.delete(key)
}

/**
 * Streams every `sessions/<id>/batch-*.jsonl` object from R2 in sequence
 * order, yielding raw byte chunks. Does not buffer full objects — each
 * object's body is read with a streaming reader so memory stays O(chunk).
 */
export async function* streamSessionBatches(
  env: Env,
  sessionDbId: string,
): AsyncGenerator<Uint8Array> {
  const listed = await env.BLOBS.list({ prefix: batchPrefix(sessionDbId) + "batch-" })
  const keys = listed.objects
    .map((o) => o.key)
    .filter((k) => k.endsWith(".jsonl"))
    .sort()
  for (const key of keys) {
    const obj = await env.BLOBS.get(key)
    if (!obj) continue
    const reader = obj.body.getReader()
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

/**
 * WpilogWriter implementation that multipart-uploads to R2. Accumulates
 * pending bytes until a 5 MiB threshold is met (R2's minimum non-final
 * part size), then uploads a part. The final (possibly-smaller) part is
 * flushed in `finalize()`. Call `abort()` on failure to avoid leaving a
 * paid incomplete multipart upload.
 */
export class R2MultipartWpilogWriter implements WpilogWriter {
  private readonly partThreshold = 5 * 1024 * 1024
  private upload: R2MultipartUpload | null = null
  private parts: R2UploadedPart[] = []
  private pending: Uint8Array[] = []
  private pendingSize = 0

  constructor(
    private readonly bucket: R2Bucket,
    private readonly key: string,
  ) {}

  async init(): Promise<void> {
    this.upload = await this.bucket.createMultipartUpload(this.key, {
      httpMetadata: { contentType: "application/octet-stream" },
    })
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return
    this.pending.push(bytes)
    this.pendingSize += bytes.length
    if (this.pendingSize >= this.partThreshold) {
      await this.flushPart()
    }
  }

  async finalize(): Promise<R2Object> {
    if (!this.upload) throw new Error("R2MultipartWpilogWriter: init() not called")
    // R2 requires at least one part. For tiny outputs we still produce
    // one final part with whatever's pending (can be < 5 MiB as the last).
    await this.flushPart()
    if (this.parts.length === 0) {
      // Empty input — upload a single zero-byte part so complete() succeeds.
      const emptyPart = await this.upload.uploadPart(1, new Uint8Array(0))
      this.parts.push(emptyPart)
    }
    return this.upload.complete(this.parts)
  }

  async abort(): Promise<void> {
    if (this.upload) await this.upload.abort()
  }

  private async flushPart(): Promise<void> {
    if (this.pendingSize === 0) return
    if (!this.upload) throw new Error("R2MultipartWpilogWriter: init() not called")
    const merged = new Uint8Array(this.pendingSize)
    let off = 0
    for (const chunk of this.pending) {
      merged.set(chunk, off)
      off += chunk.length
    }
    const partNumber = this.parts.length + 1
    const part = await this.upload.uploadPart(partNumber, merged)
    this.parts.push(part)
    this.pending = []
    this.pendingSize = 0
  }
}
