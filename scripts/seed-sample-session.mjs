#!/usr/bin/env node
/**
 * One-shot seeder that drives the live HTTP ingest pipeline with the
 * sample JSONL fixture, so a local `wrangler dev` instance has a
 * non-empty session to exercise the sessions list, tree view, and
 * WPILog download.
 *
 * Usage:
 *   node scripts/seed-sample-session.mjs <rsk_live_key>
 *   BASE_URL=http://127.0.0.1:8787 node scripts/seed-sample-session.mjs <key>
 *
 * The sample fixture is raw ntlogger JSONL (per-line
 * {ts, server_ts, key, type, value, ...}). This script transforms each
 * line into a RavenScope `TelemetryEntryRequest` before POSTing:
 *   - ts: Unix seconds float → ISO-8601 string
 *   - key → ntKey, type → ntType
 *   - value → ntValue (JSON-stringified)
 *   - session_start is consumed for teamNumber / robotIp / sessionId /
 *     startedAt — it is not sent as an entry (the server doesn't
 *     accept session_start as a TelemetryEntryRequest).
 *   - match_start / match_end / session_end become marker entries with
 *     entryType = <marker type>.
 *
 * The sessionId is suffixed with the timestamp so each run creates a
 * fresh row instead of idempotent-returning the same one.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const apiKey = process.argv[2]
if (!apiKey) {
  console.error("usage: node scripts/seed-sample-session.mjs <rsk_live_key>")
  console.error("       (mint one at http://127.0.0.1:8787/keys)")
  process.exit(1)
}
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:8787"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = path.join(
  __dirname,
  "..",
  "packages/worker/src/wpilog/fixtures/sample-session.jsonl",
)

const text = readFileSync(fixturePath, "utf-8")
const lines = text.split("\n").filter((l) => l.trim())

let sessionId = `sample-${Date.now().toString(36)}`
let teamNumber = 1310
let robotIp = "10.13.10.2"
let startedAt = new Date().toISOString()

const entries = []
for (const line of lines) {
  let raw
  try {
    raw = JSON.parse(line)
  } catch {
    continue
  }
  if (raw.type === "session_start") {
    if (typeof raw.session_id === "string") sessionId = `${raw.session_id}-${Date.now().toString(36)}`
    if (typeof raw.team === "number") teamNumber = raw.team
    if (typeof raw.robot_ip === "string") robotIp = raw.robot_ip
    if (typeof raw.ts === "number") startedAt = new Date(raw.ts * 1000).toISOString()
    continue
  }
  const tsIso = typeof raw.ts === "number" ? new Date(raw.ts * 1000).toISOString() : null
  if (!tsIso) continue

  if (raw.type === "match_start" || raw.type === "match_end" || raw.type === "session_end") {
    entries.push({
      ts: tsIso,
      entryType: raw.type,
      ...(typeof raw.fms_raw === "number" ? { fmsRaw: raw.fms_raw } : {}),
    })
    continue
  }

  if (typeof raw.key === "string" && typeof raw.type === "string") {
    entries.push({
      ts: tsIso,
      entryType: "data",
      ntKey: raw.key,
      ntType: raw.type,
      ntValue: JSON.stringify(raw.value),
    })
  }
}

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${method} ${path} → ${res.status}: ${text}`)
  }
  if (res.status === 204) return null
  if ((res.headers.get("Content-Type") ?? "").includes("application/json")) {
    return res.json()
  }
  return res.text()
}

console.log(`[seed] ${lines.length} source lines → ${entries.length} entries to send`)
console.log(`[seed] sessionId: ${sessionId}`)
console.log(`[seed] teamNumber: ${teamNumber}, robotIp: ${robotIp}`)
console.log(`[seed] startedAt: ${startedAt}`)

const created = await call("/api/telemetry/session", {
  method: "POST",
  body: { sessionId, teamNumber, robotIp, startedAt },
})
console.log(`[seed] created session ${created.id}`)

const BATCH = 500
let sent = 0
while (sent < entries.length) {
  const batch = entries.slice(sent, sent + BATCH)
  const res = await call(`/api/telemetry/session/${sessionId}/data`, {
    method: "POST",
    body: batch,
  })
  sent += batch.length
  process.stdout.write(`\r[seed] uploaded ${sent}/${entries.length} (${res.count} in last batch)`)
}
process.stdout.write("\n")

const lastEntryTs = entries.at(-1)?.ts ?? new Date().toISOString()
await call(`/api/telemetry/session/${sessionId}/complete`, {
  method: "POST",
  body: { endedAt: lastEntryTs, entryCount: entries.length },
})
console.log(`[seed] completed session — entries: ${entries.length}`)

console.log(`[seed] done. Open ${baseUrl}/sessions/${created.id} to view.`)
