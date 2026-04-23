import type { KeyTreeNode, KeyTreeResponse, TelemetryEntryRequest } from "../dto"
import type { Env } from "../env"
import { batchPrefix, treeKey } from "../storage/keys"

interface Aggregate {
  ntType: string
  count: number
  firstTs: string
  lastTs: string
}

/**
 * Streams each `sessions/<id>/batch-*.jsonl` from R2, parses it line by line,
 * and accumulates a `Map<ntKey, {ntType, count, firstTs, lastTs}>` that is
 * then shaped into the tree. Non-data entries (session_start, match_start,
 * etc.) are skipped. Malformed JSON lines and empty keys are counted but do
 * not abort the build.
 */
export async function buildTree(env: Env, sessionDbId: string): Promise<KeyTreeResponse> {
  const prefix = batchPrefix(sessionDbId) + "batch-"
  const listed = await env.BLOBS.list({ prefix })
  const keys = listed.objects
    .map((o) => o.key)
    .filter((k) => k.endsWith(".jsonl"))
    .sort()

  const agg = new Map<string, Aggregate>()
  let malformed = 0

  for (const key of keys) {
    const obj = await env.BLOBS.get(key)
    if (!obj) continue
    const text = await obj.text()
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      let entry: TelemetryEntryRequest
      try {
        entry = JSON.parse(line) as TelemetryEntryRequest
      } catch {
        malformed++
        continue
      }
      // RavenLink's uploader emits `entryType: "data"` for NT data entries
      // (matching RavenBrain's TelemetryApi semantics). Non-data entries
      // (match_start, match_end, session_end) are skipped — they carry no
      // NT key/type.
      if (entry.entryType !== "data") continue
      if (!entry.ntKey || entry.ntKey === "/" || !entry.ntType) {
        malformed++
        continue
      }
      const existing = agg.get(entry.ntKey)
      if (existing) {
        existing.count += 1
        if (entry.ts < existing.firstTs) existing.firstTs = entry.ts
        if (entry.ts > existing.lastTs) existing.lastTs = entry.ts
      } else {
        agg.set(entry.ntKey, {
          ntType: entry.ntType,
          count: 1,
          firstTs: entry.ts,
          lastTs: entry.ts,
        })
      }
    }
  }

  const nodes = shapeTree(agg)
  return {
    nodes,
    totalKeys: agg.size,
    malformedLines: malformed,
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Persists a built tree to R2 at `sessions/<id>/tree.json` so the next
 * request serves from cache. Invalidation on new /data batches is handled
 * in the ingest path (wpilog_generated_at clearing also clears tree
 * relevance via the `last_batch_at` freshness check at read time).
 */
export async function cacheTree(
  env: Env,
  sessionDbId: string,
  tree: KeyTreeResponse,
): Promise<void> {
  await env.BLOBS.put(treeKey(sessionDbId), JSON.stringify(tree))
}

export async function loadCachedTree(
  env: Env,
  sessionDbId: string,
): Promise<KeyTreeResponse | null> {
  const obj = await env.BLOBS.get(treeKey(sessionDbId))
  if (!obj) return null
  try {
    return JSON.parse(await obj.text()) as KeyTreeResponse
  } catch {
    return null
  }
}

function shapeTree(agg: Map<string, Aggregate>): KeyTreeNode[] {
  const root: KeyTreeNode = { path: "", name: "", children: [] }
  for (const [key, info] of agg) {
    const segments = key.split("/").filter(Boolean)
    if (segments.length === 0) continue
    let cursor = root
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!
      const fullPath = "/" + segments.slice(0, i + 1).join("/")
      let child = cursor.children.find((c) => c.name === segment)
      if (!child) {
        child = { path: fullPath, name: segment, children: [] }
        cursor.children.push(child)
      }
      cursor = child
    }
    cursor.ntType = info.ntType
    cursor.sampleCount = info.count
    cursor.firstTs = info.firstTs
    cursor.lastTs = info.lastTs
  }
  // Sort siblings alphabetically for stable output.
  sortTree(root)
  return root.children
}

function sortTree(node: KeyTreeNode): void {
  node.children.sort((a, b) => a.name.localeCompare(b.name))
  for (const child of node.children) sortTree(child)
}
