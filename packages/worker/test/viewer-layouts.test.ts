import { env, SELF } from "cloudflare:test"
import { and, eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  loadKeySet,
  SESSION_COOKIE_NAME,
  signSession,
} from "../src/auth/cookie"
import { createDb } from "../src/db/client"
import {
  auditLog,
  sessionBatches,
  telemetrySessions,
  userViewerPreferences,
  users,
  workspaceInvites,
  workspaceMembers,
  workspaceViewerLayouts,
  workspaces,
} from "../src/db/schema"
import type {
  ViewerLayoutBootstrap,
  ViewerLayoutDto,
  ViewerLayoutsResponse,
  ViewerPreferencesResponse,
} from "../src/dto"

const BASE = "https://ravenscope.test"

async function wipeDb() {
  const db = createDb(env)
  await db.delete(auditLog)
  await db.delete(sessionBatches)
  await db.delete(telemetrySessions)
  await db.delete(userViewerPreferences)
  await db.delete(workspaceViewerLayouts)
  await db.delete(workspaceInvites)
  await db.delete(workspaceMembers)
  await db.delete(workspaces)
  await db.delete(users)
}

async function mintCookie(uid: string, wsid: string): Promise<string> {
  const keyset = await loadKeySet(env.SESSION_SECRET)
  const token = await signSession(
    { uid, wsid, exp: Date.now() + 3_600_000 },
    keyset,
  )
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function seedWorkspace(ownerEmail: string, wsName: string) {
  const db = createDb(env)
  const [user] = await db.insert(users).values({ email: ownerEmail }).returning()
  const [ws] = await db.insert(workspaces).values({ name: wsName }).returning()
  await db.insert(workspaceMembers).values({
    workspaceId: ws!.id,
    userId: user!.id,
    role: "owner",
  })
  const cookie = await mintCookie(user!.id, ws!.id)
  return { userId: user!.id, workspaceId: ws!.id, cookie }
}

async function addMember(workspaceId: string, email: string) {
  const db = createDb(env)
  const [u] = await db.insert(users).values({ email }).returning()
  await db.insert(workspaceMembers).values({
    workspaceId,
    userId: u!.id,
    role: "member",
  })
  return { userId: u!.id, cookie: await mintCookie(u!.id, workspaceId) }
}

beforeEach(async () => {
  await wipeDb()
})

afterEach(() => {
  vi.restoreAllMocks()
})

/* ===================================================== LAYOUT CRUD */

describe("POST /api/workspaces/:wsid/layouts", () => {
  it("creates a layout and includes it in the listing", async () => {
    const { workspaceId, cookie } = await seedWorkspace("a@t.local", "ws-a")
    const state = { sidebar: { width: 300, expanded: [] }, tabs: { selected: 0, tabs: [] } }

    const createRes = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts`,
      {
        method: "POST",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Coach view", state }),
      },
    )
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as ViewerLayoutDto
    expect(created.name).toBe("Coach view")
    expect(created.state).toEqual(state)

    const listRes = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts`,
      { headers: { Cookie: cookie } },
    )
    const listBody = (await listRes.json()) as ViewerLayoutsResponse
    expect(listBody.layouts).toHaveLength(1)
    expect(listBody.layouts[0]!.name).toBe("Coach view")
    // summary excludes state
    expect(listBody.layouts[0]).not.toHaveProperty("state")
  })

  it("returns 409 on duplicate (workspace, name)", async () => {
    const { workspaceId, cookie } = await seedWorkspace("b@t.local", "ws-b")
    const body = {
      name: "Same",
      state: { sidebar: { width: 200, expanded: [] }, tabs: { selected: 0, tabs: [] } },
    }
    const first = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts`,
      {
        method: "POST",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    )
    expect(first.status).toBe(201)
    const second = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts`,
      {
        method: "POST",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    )
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ error: "name_in_use" })
  })

  it("returns 413 when state payload exceeds 256 KiB", async () => {
    const { workspaceId, cookie } = await seedWorkspace("bigp@t.local", "ws-big")
    const state = { junk: "x".repeat(300_000) }
    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts`,
      {
        method: "POST",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Huge", state }),
      },
    )
    expect(res.status).toBe(413)
  })

  it("returns 400 when name is missing or empty", async () => {
    const { workspaceId, cookie } = await seedWorkspace("noname@t.local", "ws-noname")
    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts`,
      {
        method: "POST",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "   ", state: {} }),
      },
    )
    expect(res.status).toBe(400)
  })

  it("any workspace member can create a layout (not owner-only)", async () => {
    // R2: permission model is "any member".
    const { workspaceId } = await seedWorkspace("o@t.local", "ws-any")
    const m = await addMember(workspaceId, "mem@t.local")
    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts`,
      {
        method: "POST",
        headers: { Cookie: m.cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Member's layout", state: {} }),
      },
    )
    expect(res.status).toBe(201)
    const created = (await res.json()) as ViewerLayoutDto
    expect(created.createdByUserId).toBe(m.userId)
  })
})

describe("GET /api/workspaces/:wsid/layouts (cross-tenancy)", () => {
  it("returns 403 forbidden for a wsid the user does not belong to", async () => {
    const a = await seedWorkspace("ca@t.local", "ca")
    const b = await seedWorkspace("cb@t.local", "cb")
    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${b.workspaceId}/layouts`,
      { headers: { Cookie: a.cookie } },
    )
    expect(res.status).toBe(403)
  })

  it("returns 401 for unauthenticated requests", async () => {
    const a = await seedWorkspace("unauth@t.local", "unauth")
    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${a.workspaceId}/layouts`,
    )
    expect(res.status).toBe(401)
  })
})

describe("GET /api/workspaces/:wsid/layouts/:id", () => {
  it("returns the full layout including state", async () => {
    const { workspaceId, cookie } = await seedWorkspace("get@t.local", "get-ws")
    const state = { sidebar: { width: 250, expanded: ["a", "b"] }, tabs: { selected: 1, tabs: [] } }
    const createRes = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts`,
      {
        method: "POST",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Fetch me", state }),
      },
    )
    const created = (await createRes.json()) as ViewerLayoutDto

    const getRes = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts/${created.id}`,
      { headers: { Cookie: cookie } },
    )
    expect(getRes.status).toBe(200)
    const body = (await getRes.json()) as ViewerLayoutDto
    expect(body.id).toBe(created.id)
    expect(body.state).toEqual(state)
  })

  it("returns 404 when the layout belongs to a different workspace", async () => {
    // R6: cross-tenancy — even with the correct wsid, the layout id's
    // workspace must match. We check against the caller's workspace.
    const a = await seedWorkspace("x1@t.local", "wsx1")
    const b = await seedWorkspace("x2@t.local", "wsx2")
    const db = createDb(env)
    const [row] = await db
      .insert(workspaceViewerLayouts)
      .values({
        workspaceId: b.workspaceId,
        name: "In ws B",
        stateJson: "{}",
      })
      .returning()
    // Request through caller A's own wsid — should 404 because `row!.id`
    // doesn't live in A's workspace.
    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${a.workspaceId}/layouts/${row!.id}`,
      { headers: { Cookie: a.cookie } },
    )
    expect(res.status).toBe(404)
  })
})

describe("PATCH /api/workspaces/:wsid/layouts/:id", () => {
  it("renames a layout", async () => {
    const { workspaceId, cookie } = await seedWorkspace("ren@t.local", "renws")
    const cr = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts`,
      {
        method: "POST",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Old", state: {} }),
      },
    )
    const created = (await cr.json()) as ViewerLayoutDto

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts/${created.id}`,
      {
        method: "PATCH",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "New" }),
      },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ViewerLayoutDto
    expect(body.name).toBe("New")
  })

  it("updates state on overwrite", async () => {
    const { workspaceId, cookie } = await seedWorkspace("ov@t.local", "ovws")
    const cr = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts`,
      {
        method: "POST",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Over", state: { v: 1 } }),
      },
    )
    const created = (await cr.json()) as ViewerLayoutDto
    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts/${created.id}`,
      {
        method: "PATCH",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({ state: { v: 2 } }),
      },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ViewerLayoutDto
    expect(body.state).toEqual({ v: 2 })
  })

  it("returns 400 for empty body (no_fields)", async () => {
    const { workspaceId, cookie } = await seedWorkspace("nof@t.local", "nofws")
    const cr = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts`,
      {
        method: "POST",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "L", state: {} }),
      },
    )
    const created = (await cr.json()) as ViewerLayoutDto
    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts/${created.id}`,
      {
        method: "PATCH",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: "{}",
      },
    )
    expect(res.status).toBe(400)
  })

  it("returns 409 on rename to a taken name", async () => {
    const { workspaceId, cookie } = await seedWorkspace("pc@t.local", "pcws")
    await SELF.fetch(`${BASE}/api/workspaces/${workspaceId}/layouts`, {
      method: "POST",
      headers: { Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Taken", state: {} }),
    })
    const b = await SELF.fetch(`${BASE}/api/workspaces/${workspaceId}/layouts`, {
      method: "POST",
      headers: { Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Other", state: {} }),
    })
    const otherLayout = (await b.json()) as ViewerLayoutDto
    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts/${otherLayout.id}`,
      {
        method: "PATCH",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Taken" }),
      },
    )
    expect(res.status).toBe(409)
  })
})

describe("DELETE /api/workspaces/:wsid/layouts/:id", () => {
  it("deletes and returns 204; a second DELETE returns 404", async () => {
    const { workspaceId, cookie } = await seedWorkspace("del@t.local", "delws")
    const cr = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts`,
      {
        method: "POST",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Gone", state: {} }),
      },
    )
    const created = (await cr.json()) as ViewerLayoutDto
    const first = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts/${created.id}`,
      { method: "DELETE", headers: { Cookie: cookie } },
    )
    expect(first.status).toBe(204)
    const second = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts/${created.id}`,
      { method: "DELETE", headers: { Cookie: cookie } },
    )
    expect(second.status).toBe(404)
  })
})

/* ================================================== /api/me/viewer-* */

describe("GET /api/me/viewer-layout bootstrap", () => {
  it("returns {source: 'none', state: null} for a fresh user", async () => {
    const { cookie } = await seedWorkspace("fresh@t.local", "freshws")
    const res = await SELF.fetch(`${BASE}/api/me/viewer-layout`, {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as ViewerLayoutBootstrap
    expect(body).toEqual({ state: null, source: "none" })
  })

  it("returns last-used when set and no default", async () => {
    const { userId, workspaceId, cookie } = await seedWorkspace("lu@t.local", "luws")
    const state = { sidebar: { width: 200, expanded: [] }, tabs: { selected: 0, tabs: [] } }
    await SELF.fetch(`${BASE}/api/me/viewer-layout/last-used`, {
      method: "PUT",
      headers: { Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify({ state }),
    })
    const res = await SELF.fetch(`${BASE}/api/me/viewer-layout`, {
      headers: { Cookie: cookie },
    })
    const body = (await res.json()) as ViewerLayoutBootstrap
    expect(body.source).toBe("last-used")
    expect(body.state).toEqual(state)
    // Side-effect check: a prefs row exists for this user.
    const db = createDb(env)
    const [row] = await db
      .select()
      .from(userViewerPreferences)
      .where(
        and(
          eq(userViewerPreferences.userId, userId),
          eq(userViewerPreferences.workspaceId, workspaceId),
        ),
      )
    expect(row).toBeDefined()
  })

  it("returns the default layout when set, taking priority over last-used", async () => {
    const { workspaceId, cookie } = await seedWorkspace("def@t.local", "defws")
    // Create a named layout
    const createRes = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts`,
      {
        method: "POST",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Default one",
          state: { marker: "named" },
        }),
      },
    )
    const layout = (await createRes.json()) as ViewerLayoutDto
    // Seed last-used (should be shadowed by default)
    await SELF.fetch(`${BASE}/api/me/viewer-layout/last-used`, {
      method: "PUT",
      headers: { Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify({ state: { marker: "last-used" } }),
    })
    // Set default
    await SELF.fetch(`${BASE}/api/me/viewer-preferences`, {
      method: "PUT",
      headers: { Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify({ defaultLayoutId: layout.id }),
    })

    const res = await SELF.fetch(`${BASE}/api/me/viewer-layout`, {
      headers: { Cookie: cookie },
    })
    const body = (await res.json()) as ViewerLayoutBootstrap
    expect(body.source).toBe("default")
    expect(body.defaultLayoutId).toBe(layout.id)
    expect(body.state).toEqual({ marker: "named" })
  })

  it("falls back to last-used after the default layout is deleted (FK set-null)", async () => {
    // R3/R4 interaction: another user deleting your defaulted layout
    // should silently demote the default without losing last-used.
    const { workspaceId, cookie } = await seedWorkspace("fb@t.local", "fbws")
    const cr = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts`,
      {
        method: "POST",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "To delete", state: { marker: "will-die" } }),
      },
    )
    const layout = (await cr.json()) as ViewerLayoutDto
    await SELF.fetch(`${BASE}/api/me/viewer-layout/last-used`, {
      method: "PUT",
      headers: { Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify({ state: { marker: "last-used-survives" } }),
    })
    await SELF.fetch(`${BASE}/api/me/viewer-preferences`, {
      method: "PUT",
      headers: { Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify({ defaultLayoutId: layout.id }),
    })
    await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts/${layout.id}`,
      { method: "DELETE", headers: { Cookie: cookie } },
    )

    const res = await SELF.fetch(`${BASE}/api/me/viewer-layout`, {
      headers: { Cookie: cookie },
    })
    const body = (await res.json()) as ViewerLayoutBootstrap
    expect(body.source).toBe("last-used")
    expect(body.state).toEqual({ marker: "last-used-survives" })

    // And the prefs read endpoint should report defaultLayoutId = null now.
    const prefsRes = await SELF.fetch(
      `${BASE}/api/me/viewer-preferences`,
      { headers: { Cookie: cookie } },
    )
    const prefs = (await prefsRes.json()) as ViewerPreferencesResponse
    expect(prefs.defaultLayoutId).toBeNull()
  })
})

describe("PUT /api/me/viewer-preferences", () => {
  it("clears the default when defaultLayoutId is null", async () => {
    const { workspaceId, cookie } = await seedWorkspace("clr@t.local", "clrws")
    const cr = await SELF.fetch(
      `${BASE}/api/workspaces/${workspaceId}/layouts`,
      {
        method: "POST",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Setme", state: {} }),
      },
    )
    const layout = (await cr.json()) as ViewerLayoutDto
    await SELF.fetch(`${BASE}/api/me/viewer-preferences`, {
      method: "PUT",
      headers: { Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify({ defaultLayoutId: layout.id }),
    })
    await SELF.fetch(`${BASE}/api/me/viewer-preferences`, {
      method: "PUT",
      headers: { Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify({ defaultLayoutId: null }),
    })
    const res = await SELF.fetch(`${BASE}/api/me/viewer-preferences`, {
      headers: { Cookie: cookie },
    })
    const prefs = (await res.json()) as ViewerPreferencesResponse
    expect(prefs.defaultLayoutId).toBeNull()
  })

  it("returns 404 when setting default to a layout id in another workspace", async () => {
    const a = await seedWorkspace("pxa@t.local", "pxa")
    const b = await seedWorkspace("pxb@t.local", "pxb")
    // Create a layout in B
    const cr = await SELF.fetch(
      `${BASE}/api/workspaces/${b.workspaceId}/layouts`,
      {
        method: "POST",
        headers: { Cookie: b.cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "In B", state: {} }),
      },
    )
    const bLayout = (await cr.json()) as ViewerLayoutDto
    // User A tries to default to B's layout id
    const res = await SELF.fetch(`${BASE}/api/me/viewer-preferences`, {
      method: "PUT",
      headers: { Cookie: a.cookie, "content-type": "application/json" },
      body: JSON.stringify({ defaultLayoutId: bLayout.id }),
    })
    expect(res.status).toBe(404)
  })
})

describe("PUT /api/me/viewer-layout/last-used payload limits", () => {
  it("returns 413 for oversized state", async () => {
    const { cookie } = await seedWorkspace("big@t.local", "bigws")
    const state = { blob: "z".repeat(300_000) }
    const res = await SELF.fetch(`${BASE}/api/me/viewer-layout/last-used`, {
      method: "PUT",
      headers: { Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify({ state }),
    })
    expect(res.status).toBe(413)
  })

  it("returns 400 when body is missing state", async () => {
    const { cookie } = await seedWorkspace("ms@t.local", "msws")
    const res = await SELF.fetch(`${BASE}/api/me/viewer-layout/last-used`, {
      method: "PUT",
      headers: { Cookie: cookie, "content-type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(400)
  })
})

describe("auth matrix on /api/me/viewer-*", () => {
  it("unauthenticated GET /api/me/viewer-layout -> 401", async () => {
    const res = await SELF.fetch(`${BASE}/api/me/viewer-layout`)
    expect(res.status).toBe(401)
  })
})
