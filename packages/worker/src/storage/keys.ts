/**
 * Canonical R2 key layout. All per-session artifacts live under
 * `sessions/<sessionDbId>/` so a full session can be listed or deleted by
 * prefix if it ever comes up.
 *
 * sessionDbId is the internal UUID (telemetry_sessions.id), not the
 * client-supplied sessionId — that keeps keys unique even if two workspaces
 * upload the same client session id independently.
 */

export function batchKey(sessionDbId: string, seq: number): string {
  return `sessions/${sessionDbId}/batch-${seq.toString().padStart(4, "0")}.jsonl`
}

export function batchPrefix(sessionDbId: string): string {
  return `sessions/${sessionDbId}/`
}

export function treeKey(sessionDbId: string): string {
  return `sessions/${sessionDbId}/tree.json`
}

export function wpilogKey(sessionDbId: string): string {
  return `sessions/${sessionDbId}/session.wpilog`
}
