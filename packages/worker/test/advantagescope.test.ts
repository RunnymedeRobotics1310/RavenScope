import { env, fetchMock, SELF } from "cloudflare:test"
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

/*
 * Integration tests for the embedded AdvantageScope Lite route group at
 * /v/:id/*. These cover the dynamic endpoints (/logs listing, /logs/<name>
 * streaming, /assets manifest, /assets/<path>) plus the auth matrix.
 *
 * The static-proxy catch-all and SPA-fallback guard are NOT covered here
 * because env.ASSETS is not bound in the miniflare test pool. Those paths
 * are verified manually against `wrangler dev` once the AS Lite bundle has
 * been fetched via U2/U2b.
 */

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
    body: JSON.stringify({ name: "ascope test" }),
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

describe("GET /v/:id/logs (listing)", () => {
  it("returns [{name, size}] for an owned session; size=0 when wpilog not yet generated", async () => {
    const a = await signInAs("listing@test.local")
    const bearer = await createApiKey(a.cookie)
    const session = await ingestSession(bearer, "list-empty", [
      entry("/A", "double", "1.0", "2026-04-22T18:00:00.100Z"),
    ])

    const res = await SELF.fetch(`${BASE}/v/${session.id}/logs`, {
      headers: { Cookie: a.cookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ name: string; size: number }>
    expect(body).toHaveLength(1)
    expect(body[0]!.name).toBe("list-empty.wpilog")
    expect(body[0]!.size).toBe(0)
  })

  it("reports a nonzero size once the wpilog has been generated", async () => {
    const a = await signInAs("listing-size@test.local")
    const bearer = await createApiKey(a.cookie)
    const session = await ingestSession(bearer, "list-sized", [
      entry("/A", "double", "1.0", "2026-04-22T18:00:00.100Z"),
    ])
    // Trigger generation via the download route first.
    const gen = await SELF.fetch(`${BASE}/api/sessions/${session.id}/wpilog`, {
      headers: { Cookie: a.cookie },
    })
    expect(gen.status).toBe(200)
    await gen.arrayBuffer()

    const res = await SELF.fetch(`${BASE}/v/${session.id}/logs`, {
      headers: { Cookie: a.cookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ name: string; size: number }>
    expect(body[0]!.size).toBeGreaterThan(0)
  })

  it("returns 404 for a session in another workspace (no existence leak)", async () => {
    const a = await signInAs("a-listing@test.local")
    const b = await signInAs("b-listing@test.local")
    const bearerB = await createApiKey(b.cookie)
    const session = await ingestSession(bearerB, "b-list-private", [
      entry("/A", "double", "1.0", "2026-04-22T18:00:00.100Z"),
    ])
    const res = await SELF.fetch(`${BASE}/v/${session.id}/logs`, {
      headers: { Cookie: a.cookie },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("not_found")
  })

  it("returns 401 when unauthenticated", async () => {
    const res = await SELF.fetch(`${BASE}/v/any-id/logs`)
    expect(res.status).toBe(401)
  })
})

describe("GET /v/:id/logs/<name> (stream)", () => {
  it("streams the session's wpilog regardless of name and folder query params", async () => {
    const a = await signInAs("stream@test.local")
    const bearer = await createApiKey(a.cookie)
    const session = await ingestSession(bearer, "stream-basic", [
      entry("/A", "double", "1.0", "2026-04-22T18:00:00.100Z"),
    ])
    // Made-up filename + made-up folder — both must be ignored.
    const res = await SELF.fetch(
      `${BASE}/v/${session.id}/logs/anything-at-all.wpilog?folder=/tmp/whatever`,
      { headers: { Cookie: a.cookie } },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream")
    expect(res.headers.get("Content-Disposition")).toBeNull() // inline, not download
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=0, must-revalidate")
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(String.fromCharCode(...bytes.slice(0, 6))).toBe("WPILOG")
  })

  it("returns byte-identical bytes as GET /api/sessions/:id/wpilog (R5 golden cross-route)", async () => {
    const a = await signInAs("golden@test.local")
    const bearer = await createApiKey(a.cookie)
    const session = await ingestSession(bearer, "golden", [
      entry("/A", "double", "1.0", "2026-04-22T18:00:00.100Z"),
      entry("/A", "double", "2.0", "2026-04-22T18:00:00.200Z"),
      entry("/B", "string", '"hello"', "2026-04-22T18:00:00.150Z"),
    ])

    const download = await SELF.fetch(`${BASE}/api/sessions/${session.id}/wpilog`, {
      headers: { Cookie: a.cookie },
    })
    const downloadBytes = new Uint8Array(await download.arrayBuffer())

    const viewer = await SELF.fetch(`${BASE}/v/${session.id}/logs/golden.wpilog`, {
      headers: { Cookie: a.cookie },
    })
    const viewerBytes = new Uint8Array(await viewer.arrayBuffer())

    expect(Array.from(viewerBytes)).toEqual(Array.from(downloadBytes))
  })

  it("returns 404 for a session in another workspace", async () => {
    const a = await signInAs("a-stream@test.local")
    const b = await signInAs("b-stream@test.local")
    const bearerB = await createApiKey(b.cookie)
    const session = await ingestSession(bearerB, "b-stream-private", [
      entry("/A", "double", "1.0", "2026-04-22T18:00:00.100Z"),
    ])
    const res = await SELF.fetch(`${BASE}/v/${session.id}/logs/foo.wpilog`, {
      headers: { Cookie: a.cookie },
    })
    expect(res.status).toBe(404)
  })

  it("returns 401 when unauthenticated", async () => {
    const res = await SELF.fetch(`${BASE}/v/any-id/logs/foo.wpilog`)
    expect(res.status).toBe(401)
  })
})

describe("auth matrix on /v/:id/*", () => {
  it("unknown :id returns 404 not_found (NOT the SPA's index.html)", async () => {
    const a = await signInAs("unknown@test.local")
    const res = await SELF.fetch(`${BASE}/v/does-not-exist/logs`, {
      headers: { Cookie: a.cookie },
    })
    expect(res.status).toBe(404)
    // Critical: must be JSON, not the SPA's HTML fallback. This is the
    // run_worker_first wrangler.toml change paying off.
    const contentType = res.headers.get("Content-Type") ?? ""
    expect(contentType).toContain("application/json")
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("not_found")
  })

  it("iframe root with trailing slash (/v/:id/) is authorized (404 when not owner, not the SPA HTML)", async () => {
    // The SessionView iframe src is `/v/${id}/?log=...` -- the trailing
    // slash variant must flow through the same auth gate as /v/:id.
    // Before the catch-all fix, /v/:id/ with empty sub-path served the
    // SPA's index.html (with text/html content-type) and got rejected
    // as 404 instead of serving AS Lite's index.html.
    const a = await signInAs("a-root@test.local")
    const b = await signInAs("b-root@test.local")
    const bearerB = await createApiKey(b.cookie)
    const session = await ingestSession(bearerB, "b-root-private", [
      entry("/A", "double", "1.0", "2026-04-22T18:00:00.100Z"),
    ])
    const res = await SELF.fetch(`${BASE}/v/${session.id}/`, {
      headers: { Cookie: a.cookie },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("not_found")
  })

  it("rejects bearer auth (cookie only)", async () => {
    const a = await signInAs("bearer-rejected@test.local")
    const bearer = await createApiKey(a.cookie)
    const session = await ingestSession(bearer, "bearer-on-v", [
      entry("/A", "double", "1.0", "2026-04-22T18:00:00.100Z"),
    ])
    const res = await SELF.fetch(`${BASE}/v/${session.id}/logs`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    expect(res.status).toBe(401)
  })
})
