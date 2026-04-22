/**
 * Translates RavenScope's R2-stored `TelemetryEntryRequest` JSONL format
 * into the raw ntlogger JSONL format that `convertStreaming` expects.
 *
 * Key differences absorbed here:
 *   - `ts` (ISO-8601 string) → Unix seconds float
 *   - `ntKey` → `key`, `ntType` → `type`, `entryType: "data"` dropped
 *   - `ntValue` (JSON-encoded string) → `value` (parsed)
 *   - `fmsRaw` → `fms_raw`
 *   - A synthetic `session_start` line is prepended using the session's
 *     `startedAt` from D1 so convert() has a base wall-clock timestamp.
 *     `server_ts` is absent from the wire format, so timestamps fall
 *     through to wall-clock resolution (ms precision — acceptable for
 *     AdvantageScope viewing).
 */

import type { TelemetryEntryRequest } from "../dto"
import type { JsonlSourceFactory } from "./convert"

const UTF8 = new TextEncoder()

/** Wrap a raw R2-batches source so it emits synthetic-session_start +
 *  translated lines instead of the verbatim TelemetryEntryRequest JSONL. */
export function adaptedR2Source(
  rawFactory: () => AsyncIterable<Uint8Array>,
  sessionStartedAt: Date,
): JsonlSourceFactory {
  return () => ({
    async *[Symbol.asyncIterator]() {
      yield UTF8.encode(
        JSON.stringify({
          ts: sessionStartedAt.getTime() / 1000,
          type: "session_start",
          session_id: "r2-session",
        }) + "\n",
      )
      for await (const line of lineStream(rawFactory())) {
        const translated = translateTelemetryLine(line)
        if (translated) yield UTF8.encode(translated + "\n")
      }
    },
  })
}

/**
 * Converts one TelemetryEntryRequest JSON string into a raw-ntlogger
 * JSON string. Returns null for empty, malformed, or unrecognized input.
 */
export function translateTelemetryLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let parsed: TelemetryEntryRequest
  try {
    parsed = JSON.parse(trimmed) as TelemetryEntryRequest
  } catch {
    return null
  }
  if (typeof parsed.entryType !== "string" || typeof parsed.ts !== "string") {
    return null
  }
  const tsSecs = Date.parse(parsed.ts) / 1000
  if (Number.isNaN(tsSecs)) return null

  if (parsed.entryType === "data") {
    if (!parsed.ntKey || !parsed.ntType) return null
    let value: unknown = null
    if (parsed.ntValue != null) {
      try {
        value = JSON.parse(parsed.ntValue)
      } catch {
        return null
      }
    }
    return JSON.stringify({
      ts: tsSecs,
      key: parsed.ntKey,
      type: parsed.ntType,
      value,
    })
  }

  // Marker (match_start, match_end, session_end, etc.)
  const out: Record<string, unknown> = {
    ts: tsSecs,
    type: parsed.entryType,
  }
  if (parsed.fmsRaw != null) out.fms_raw = parsed.fmsRaw
  return JSON.stringify(out)
}

async function* lineStream(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf("\n")) !== -1) {
      yield buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
    }
  }
  buffer += decoder.decode()
  if (buffer) yield buffer
}
