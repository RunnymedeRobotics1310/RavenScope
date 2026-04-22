import type { Env } from "../env"
import { batchKey } from "./keys"

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
  const body = entries.map((e) => JSON.stringify(e)).join("\n")
  const bytes = new TextEncoder().encode(body)
  const key = batchKey(sessionDbId, seq)
  await env.BLOBS.put(key, bytes)
  return { key, byteLength: bytes.length }
}

/**
 * Deletes a single object. Used to clean up orphans on retry paths.
 */
export async function deleteObject(env: Env, key: string): Promise<void> {
  await env.BLOBS.delete(key)
}
