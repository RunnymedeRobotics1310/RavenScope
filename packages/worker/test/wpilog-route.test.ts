import { env, fetchMock, SELF } from "cloudflare:test"
import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createDb } from "../src/db/client"
import {
  apiKeys,
  loginTokens,
  sessionBatches,
  telemetrySessions,
  users,
  workspaces,
} from "../src/db/schema"
import type { TelemetryEntryRequest, TelemetrySessionResponse } from "../src/dto"

const BASE = "https://ravenscope.test"

async function wipeAll() {
  const db = createDb(env)
  await db.delete(sessionBatches)
  await db.delete(telemetrySessions)
  await db.delete(apiKeys)
  await db.delete(loginTokens)
  await db.delete(workspaces)
  await db.delete(users)
  const list = await env.BLOBS.list()
  for (const o of list.objects) await env.BLOBS.delete(o.key)
}

async function signInAs(email: string): Promise<{ cookie: string; workspaceId: string }> {
  const captured = new Promise<URL>((resolve) => {
    fetchMock
      .get("https://api.resend.com")
      .intercept({ path: "/emails", method: "POST" })
      .reply((req) => {
        const body = JSON.parse(String(req.body)) as { text: string }
        const m = body.text.match(/https?:\/\/\S+/)
        if (!m) throw new Error("no link")
        resolve(new URL(m[0]))
        return { statusCode: 200, data: { id: "ok" } }
      })
  })
  const r1 = await SELF.fetch(`${BASE}/api/auth/request-link`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": `203.0.113.${Math.floor(Math.random() * 200) + 1}`,
    },
    body: JSON.stringify({ email }),
  })
  expect(r1.status).toBe(204)
  const link = await captured
  const r2 = await SELF.fetch(link.toString(), { redirect: "manual" })
  const setCookie = r2.headers.get("Set-Cookie")!
  const match = setCookie.match(/rs_session=([^;]+)/)!
  const cookie = `rs_session=${match[1]}`
  const me = await SELF.fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })
  const meBody = (await me.json()) as { workspaceId: string }
  return { cookie, workspaceId: meBody.workspaceId }
}

async function createApiKey(cookie: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/keys`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "wpilog test" }),
  })
  const body = (await res.json()) as { plaintext: string }
  return body.plaintext
}

async function ingestSession(
  bearer: string,
  sessionId: string,
  entries: TelemetryEntryRequest[],
): Promise<TelemetrySessionResponse> {
  const created = await SELF.fetch(`${BASE}/api/telemetry/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      teamNumber: 1310,
      robotIp: "10.13.10.2",
      startedAt: "2026-04-22T18:00:00.000Z",
    }),
  })
  const session = (await created.json()) as TelemetrySessionResponse
  if (entries.length > 0) {
    await SELF.fetch(`${BASE}/api/telemetry/session/${sessionId}/data`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(entries),
    })
  }
  return session
}

function entry(
  ntKey: string,
  ntType: string,
  ntValue: string,
  tsISO: string,
): TelemetryEntryRequest {
  return { ts: tsISO, entryType: "data", ntKey, ntType, ntValue }
}

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})

beforeEach(async () => {
  await wipeAll()
})

afterEach(() => {
  fetchMock.assertNoPendingInterceptors()
})

afterAll(() => {
  fetchMock.deactivate()
})

describe("GET /api/sessions/:id/wpilog", () => {
  it("generates + caches on first call; serves from cache on second", async () => {
    const a = await signInAs("wp@test.local")
    const bearer = await createApiKey(a.cookie)
    const session = await ingestSession(bearer, "wp-basic", [
      entry("/A", "double", "1.0", "2026-04-22T18:00:00.100Z"),
      entry("/A", "double", "2.0", "2026-04-22T18:00:00.200Z"),
      entry("/B", "string", '"hello"', "2026-04-22T18:00:00.150Z"),
    ])

    const r1 = await SELF.fetch(`${BASE}/api/sessions/${session.id}/wpilog`, {
      headers: { Cookie: a.cookie },
    })
    expect(r1.status).toBe(200)
    expect(r1.headers.get("Content-Type")).toBe("application/octet-stream")
    expect(r1.headers.get("Content-Disposition")).toBe(
      `attachment; filename="wp-basic.wpilog"`,
    )
    const bytes1 = new Uint8Array(await r1.arrayBuffer())
    expect(bytes1.length).toBeGreaterThan(12) // at least a header
    expect(String.fromCharCode(...bytes1.slice(0, 6))).toBe("WPILOG")

    // DB should have wpilogKey + generatedAt set.
    const db = createDb(env)
    const [after1] = await db
      .select()
      .from(telemetrySessions)
      .where(eq(telemetrySessions.id, session.id))
    expect(after1!.wpilogKey).not.toBeNull()
    expect(after1!.wpilogGeneratedAt).not.toBeNull()
    const generatedAt1 = after1!.wpilogGeneratedAt!.getTime()

    // Second call hits cache — byte-identical, generatedAt unchanged.
    const r2 = await SELF.fetch(`${BASE}/api/sessions/${session.id}/wpilog`, {
      headers: { Cookie: a.cookie },
    })
    const bytes2 = new Uint8Array(await r2.arrayBuffer())
    expect(Array.from(bytes2)).toEqual(Array.from(bytes1))
    const [after2] = await db
      .select()
      .from(telemetrySessions)
      .where(eq(telemetrySessions.id, session.id))
    expect(after2!.wpilogGeneratedAt!.getTime()).toBe(generatedAt1)
  })

  it("zero-batch session produces a valid header-only WPILog", async () => {
    const a = await signInAs("zero@test.local")
    const bearer = await createApiKey(a.cookie)
    const session = await ingestSession(bearer, "zero", [])
    const res = await SELF.fetch(`${BASE}/api/sessions/${session.id}/wpilog`, {
      headers: { Cookie: a.cookie },
    })
    expect(res.status).toBe(200)
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(String.fromCharCode(...bytes.slice(0, 6))).toBe("WPILOG")
    // 6 magic + 2 version + 4 extra-header-length + extra-header length
    expect(bytes.length).toBeGreaterThan(12)
  })

  it("late /data batch invalidates the cache (Unit 5 clears wpilog_key)", async () => {
    const a = await signInAs("stale@test.local")
    const bearer = await createApiKey(a.cookie)
    const session = await ingestSession(bearer, "stale", [
      entry("/A", "double", "1.0", "2026-04-22T18:00:00.100Z"),
    ])
    const r1 = await SELF.fetch(`${BASE}/api/sessions/${session.id}/wpilog`, {
      headers: { Cookie: a.cookie },
    })
    const bytes1 = new Uint8Array(await r1.arrayBuffer())

    // Post another batch — this clears wpilog_key via the DO's D1 batch.
    const lateRes = await SELF.fetch(`${BASE}/api/telemetry/session/stale/data`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify([entry("/B", "string", '"new"', "2026-04-22T18:00:00.200Z")]),
    })
    expect(lateRes.status).toBe(200)

    // Sanity: 2 batches on disk, wpilog_key cleared in D1.
    const db = createDb(env)
    const batchRows = await db
      .select()
      .from(sessionBatches)
      .where(eq(sessionBatches.sessionId, session.id))
    expect(batchRows).toHaveLength(2)
    const [sessRow] = await db
      .select()
      .from(telemetrySessions)
      .where(eq(telemetrySessions.id, session.id))
    expect(sessRow!.wpilogKey).toBeNull()

    const r2 = await SELF.fetch(`${BASE}/api/sessions/${session.id}/wpilog`, {
      headers: { Cookie: a.cookie },
    })
    expect(r2.status).toBe(200)
    const bytes2 = new Uint8Array(await r2.arrayBuffer())
    expect(bytes2.length).toBeGreaterThan(bytes1.length)
  })

  it("404 for a session in another workspace (no existence leak)", async () => {
    const a = await signInAs("a@test.local")
    const b = await signInAs("b@test.local")
    const bearerB = await createApiKey(b.cookie)
    const session = await ingestSession(bearerB, "b-private", [
      entry("/X", "double", "1.0", "2026-04-22T18:00:00.100Z"),
    ])
    const res = await SELF.fetch(`${BASE}/api/sessions/${session.id}/wpilog`, {
      headers: { Cookie: a.cookie },
    })
    expect(res.status).toBe(404)
  })

  it("rejects bearer auth on the download route (cookie only)", async () => {
    const a = await signInAs("b@test.local")
    const bearer = await createApiKey(a.cookie)
    const session = await ingestSession(bearer, "bearer-rejected", [
      entry("/A", "double", "1.0", "2026-04-22T18:00:00.100Z"),
    ])
    const res = await SELF.fetch(`${BASE}/api/sessions/${session.id}/wpilog`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    expect(res.status).toBe(401)
  })
})

describe("translateTelemetryLine (adapter)", () => {
  it("converts data entries to raw ntlogger shape", async () => {
    const { translateTelemetryLine } = await import("../src/wpilog/adapter")
    const out = translateTelemetryLine(
      JSON.stringify({
        ts: "2026-04-22T18:00:00.100Z",
        entryType: "data",
        ntKey: "/A",
        ntType: "double",
        ntValue: "3.14",
      }),
    )
    expect(out).not.toBeNull()
    const parsed = JSON.parse(out!) as Record<string, unknown>
    expect(parsed.key).toBe("/A")
    expect(parsed.type).toBe("double")
    expect(parsed.value).toBe(3.14)
    expect(typeof parsed.ts).toBe("number")
  })

  it("converts match markers and preserves fmsRaw", async () => {
    const { translateTelemetryLine } = await import("../src/wpilog/adapter")
    const out = translateTelemetryLine(
      JSON.stringify({
        ts: "2026-04-22T18:00:00.000Z",
        entryType: "match_start",
        fmsRaw: 51,
      }),
    )
    const parsed = JSON.parse(out!) as Record<string, unknown>
    expect(parsed.type).toBe("match_start")
    expect(parsed.fms_raw).toBe(51)
  })

  it("returns null on malformed input", async () => {
    const { translateTelemetryLine } = await import("../src/wpilog/adapter")
    expect(translateTelemetryLine("")).toBeNull()
    expect(translateTelemetryLine("not json")).toBeNull()
    expect(translateTelemetryLine(JSON.stringify({ ts: "bad", entryType: "data" }))).toBeNull()
  })
})

describe("convertStreaming parity with convertToBytes", () => {
  it("streamed convert with a single chunk produces identical bytes", async () => {
    const { convertStreaming, convertToBytes } = await import("../src/wpilog/convert")
    const { BufferedWpilogWriter } = await import("../src/wpilog/encoder")
    const jsonl = [
      `{"ts":1000.0,"type":"session_start"}`,
      `{"ts":1001.0,"server_ts":1000,"key":"/A","type":"double","value":1.5}`,
      `{"ts":1001.1,"server_ts":1100,"key":"/A","type":"double","value":2.5}`,
      `{"ts":1001.2,"server_ts":1200,"key":"/B","type":"string","value":"x"}`,
      `{"ts":1001.3,"type":"match_start","fms_raw":51}`,
    ].join("\n")

    const inMem = await convertToBytes(jsonl, 1310, "parity")

    const enc = new TextEncoder().encode(jsonl)
    const mid = Math.floor(enc.length / 2)
    const factory = () => ({
      async *[Symbol.asyncIterator]() {
        yield enc.slice(0, mid)
        yield enc.slice(mid)
      },
    })
    const writer = new BufferedWpilogWriter()
    await convertStreaming(writer, factory, 1310, "parity")
    const streamed = writer.toUint8Array()

    expect(Array.from(streamed)).toEqual(Array.from(inMem.bytes))
  })
})
