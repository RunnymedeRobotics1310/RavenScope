import { env, SELF } from "cloudflare:test"
import { and, eq } from "drizzle-orm"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import {
  loadKeySet,
  SESSION_COOKIE_NAME,
  signSession,
} from "../src/auth/cookie"
import { generateInviteToken } from "../src/auth/invite-token"
import { createDb } from "../src/db/client"
import {
  apiKeys,
  auditLog,
  loginTokens,
  sessionBatches,
  telemetrySessions,
  users,
  workspaceInvites,
  workspaceMembers,
  workspaces,
} from "../src/db/schema"
import type { MembersResponse, UserMeResponse } from "../src/dto"
import { batchPrefix } from "../src/storage/keys"

const BASE = "https://ravenscope.test"

/* ------------------------------------------------------------- helpers */

async function wipeDb() {
  const db = createDb(env)
  await db.delete(auditLog)
  await db.delete(sessionBatches)
  await db.delete(telemetrySessions)
  await db.delete(apiKeys)
  await db.delete(loginTokens)
  await db.delete(workspaceInvites)
  await db.delete(workspaceMembers)
  await db.delete(workspaces)
  await db.delete(users)
}

async function wipeR2() {
  const list = await env.BLOBS.list()
  for (const obj of list.objects) await env.BLOBS.delete(obj.key)
}

async function mintCookie(uid: string, wsid: string, expMs: number): Promise<string> {
  const keyset = await loadKeySet(env.SESSION_SECRET)
  const token = await signSession({ uid, wsid, exp: expMs }, keyset)
  return `${SESSION_COOKIE_NAME}=${token}`
}

/**
 * Create a fresh workspace with an owner membership. Returns signed cookie for
 * that owner.
 */
async function seedWorkspace(ownerEmail: string, wsName: string, opts?: {
  joinedAt?: Date
}) {
  const db = createDb(env)
  const [user] = await db.insert(users).values({ email: ownerEmail }).returning()
  const [ws] = await db.insert(workspaces).values({ name: wsName }).returning()
  await db.insert(workspaceMembers).values({
    workspaceId: ws!.id,
    userId: user!.id,
    role: "owner",
    joinedAt: opts?.joinedAt ?? new Date(),
  })
  const cookie = await mintCookie(user!.id, ws!.id, Date.now() + 3_600_000)
  return { userId: user!.id, workspaceId: ws!.id, workspaceName: ws!.name, cookie }
}

async function addMember(
  workspaceId: string,
  email: string,
  role: "owner" | "member" = "member",
  joinedAt: Date = new Date(),
  invitedByUserId: string | null = null,
) {
  const db = createDb(env)
  const [u] = await db.insert(users).values({ email }).returning()
  await db.insert(workspaceMembers).values({
    workspaceId,
    userId: u!.id,
    role,
    joinedAt,
    invitedByUserId,
  })
  const cookie = await mintCookie(u!.id, workspaceId, Date.now() + 3_600_000)
  return { userId: u!.id, cookie }
}

/* ------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await wipeDb()
  await wipeR2()
})

afterEach(() => {
  vi.restoreAllMocks()
})

/* ========================================================= GET members */

describe("GET /api/workspaces/:wsid/members", () => {
  it("owner sees owner + 3 members, ordered by joinedAt ASC, user_id ASC", async () => {
    const t0 = new Date("2026-04-01T00:00:00Z")
    const owner = await seedWorkspace("owner@t.local", "ws-members", {
      joinedAt: t0,
    })
    const m1 = await addMember(
      owner.workspaceId,
      "m1@t.local",
      "member",
      new Date("2026-04-02T00:00:00Z"),
      owner.userId,
    )
    const m2 = await addMember(
      owner.workspaceId,
      "m2@t.local",
      "member",
      new Date("2026-04-03T00:00:00Z"),
      owner.userId,
    )
    const m3 = await addMember(
      owner.workspaceId,
      "m3@t.local",
      "member",
      new Date("2026-04-04T00:00:00Z"),
      owner.userId,
    )

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/members`,
      { headers: { Cookie: owner.cookie } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as MembersResponse
    expect(body.members).toHaveLength(4)

    expect(body.members[0]!.userId).toBe(owner.userId)
    expect(body.members[0]!.role).toBe("owner")
    expect(body.members[0]!.email).toBe("owner@t.local")
    expect(body.members[0]!.joinedAt).toBe(t0.getTime())
    expect(body.members[0]!.invitedByUserId).toBeNull()

    expect(body.members[1]!.userId).toBe(m1.userId)
    expect(body.members[1]!.role).toBe("member")
    expect(body.members[1]!.invitedByUserId).toBe(owner.userId)
    expect(body.members[2]!.userId).toBe(m2.userId)
    expect(body.members[3]!.userId).toBe(m3.userId)
  })

  it("member caller → 403 forbidden", async () => {
    const owner = await seedWorkspace("owner2@t.local", "ws-403")
    const m = await addMember(owner.workspaceId, "mm@t.local", "member")

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/members`,
      { headers: { Cookie: m.cookie } },
    )
    expect(res.status).toBe(403)
  })
})

/* ===================================================== DELETE /members/:userId */

describe("DELETE /api/workspaces/:wsid/members/:userId", () => {
  it("happy path: owner removes member → 204, row deleted, audit logged", async () => {
    const owner = await seedWorkspace("owner@rm.local", "ws-rm")
    const m = await addMember(owner.workspaceId, "victim@rm.local", "member")

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/members/${m.userId}`,
      { method: "DELETE", headers: { Cookie: owner.cookie } },
    )
    expect(res.status).toBe(204)

    const db = createDb(env)
    const rows = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, owner.workspaceId),
          eq(workspaceMembers.userId, m.userId),
        ),
      )
    expect(rows).toHaveLength(0)

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "workspace.member_removed"))
    expect(audits).toHaveLength(1)
    const meta = JSON.parse(audits[0]!.metadataJson!) as Record<string, string>
    expect(meta.removed_user_id).toBe(m.userId)
    expect(meta.removed_email).toBe("victim@rm.local")
  })

  it("refuse removing self → 409 cannot_remove_self", async () => {
    const owner = await seedWorkspace("owner@rm2.local", "ws-rm2")

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/members/${owner.userId}`,
      { method: "DELETE", headers: { Cookie: owner.cookie } },
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; hint: string }
    expect(body.error).toBe("cannot_remove_self")
    expect(body.hint).toBe("use_leave_or_transfer")
  })

  it("member caller → 403 forbidden", async () => {
    const owner = await seedWorkspace("owner@rm3.local", "ws-rm3")
    const m1 = await addMember(owner.workspaceId, "m1@rm3.local", "member")
    const m2 = await addMember(owner.workspaceId, "m2@rm3.local", "member")

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/members/${m2.userId}`,
      { method: "DELETE", headers: { Cookie: m1.cookie } },
    )
    expect(res.status).toBe(403)
  })

  it("unknown target → 404", async () => {
    const owner = await seedWorkspace("owner@rm4.local", "ws-rm4")

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/members/unknown-user-id`,
      { method: "DELETE", headers: { Cookie: owner.cookie } },
    )
    expect(res.status).toBe(404)
  })
})

/* ======================================================== POST /leave */

describe("POST /api/workspaces/:wsid/leave", () => {
  it("member leaves → 204, row deleted, audit logged", async () => {
    const owner = await seedWorkspace("owner@leave.local", "ws-leave")
    const m = await addMember(owner.workspaceId, "m@leave.local", "member")

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/leave`,
      { method: "POST", headers: { Cookie: m.cookie } },
    )
    expect(res.status).toBe(204)

    const db = createDb(env)
    const rows = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, owner.workspaceId),
          eq(workspaceMembers.userId, m.userId),
        ),
      )
    expect(rows).toHaveLength(0)

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "workspace.member_left"))
    expect(audits).toHaveLength(1)
    expect(audits[0]!.actorUserId).toBe(m.userId)
  })

  it("sole owner leaves → 409 sole_owner_cannot_leave", async () => {
    const owner = await seedWorkspace("sole@leave.local", "ws-sole")

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/leave`,
      { method: "POST", headers: { Cookie: owner.cookie } },
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; hint: string }
    expect(body.error).toBe("sole_owner_cannot_leave")
    expect(body.hint).toBe("transfer_or_delete")

    const db = createDb(env)
    const rows = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, owner.workspaceId),
          eq(workspaceMembers.userId, owner.userId),
        ),
      )
    expect(rows).toHaveLength(1) // still there
  })

  it("owner with another owner row also present → 204 (other-owner branch)", async () => {
    const owner = await seedWorkspace("o1@leave.local", "ws-coowner")
    // Fabricate a second owner row directly (impossible in v1 API, but we
    // verify the sole-owner check is "any OTHER owner exists", not "count=1".)
    const db = createDb(env)
    const [u2] = await db
      .insert(users)
      .values({ email: "o2@leave.local" })
      .returning()
    await db.insert(workspaceMembers).values({
      workspaceId: owner.workspaceId,
      userId: u2!.id,
      role: "owner",
    })

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/leave`,
      { method: "POST", headers: { Cookie: owner.cookie } },
    )
    expect(res.status).toBe(204)
  })
})

/* ===================================================== POST /transfer */

describe("POST /api/workspaces/:wsid/transfer", () => {
  it("happy path: owner transfers to member → 204, roles flipped, audit logged", async () => {
    const owner = await seedWorkspace("o@xfer.local", "ws-xfer")
    const m = await addMember(owner.workspaceId, "target@xfer.local", "member")

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/transfer`,
      {
        method: "POST",
        headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ newOwnerUserId: m.userId }),
      },
    )
    expect(res.status).toBe(204)

    const db = createDb(env)
    const rows = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, owner.workspaceId))
    const byUser = new Map(rows.map((r) => [r.userId, r.role]))
    expect(byUser.get(owner.userId)).toBe("member")
    expect(byUser.get(m.userId)).toBe("owner")

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "workspace.ownership_transferred"))
    expect(audits).toHaveLength(1)
    const meta = JSON.parse(audits[0]!.metadataJson!) as Record<string, string>
    expect(meta.from_user_id).toBe(owner.userId)
    expect(meta.to_user_id).toBe(m.userId)

    // Subsequent /me for the new owner reflects role='owner'.
    const me = await SELF.fetch(`${BASE}/api/auth/me`, {
      headers: { Cookie: m.cookie },
    })
    expect(me.status).toBe(200)
    const meBody = (await me.json()) as UserMeResponse
    expect(meBody.activeWorkspace.role).toBe("owner")

    // And /me for the old owner now reflects role='member'.
    const me2 = await SELF.fetch(`${BASE}/api/auth/me`, {
      headers: { Cookie: owner.cookie },
    })
    const me2Body = (await me2.json()) as UserMeResponse
    expect(me2Body.activeWorkspace.role).toBe("member")
  })

  it("target not a member → 409 target_not_member", async () => {
    const owner = await seedWorkspace("o@xfer2.local", "ws-xfer2")
    // A user who exists but is not a member of this workspace.
    const db = createDb(env)
    const [stranger] = await db
      .insert(users)
      .values({ email: "stranger@xfer.local" })
      .returning()

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/transfer`,
      {
        method: "POST",
        headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ newOwnerUserId: stranger!.id }),
      },
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("target_not_member")
  })

  it("non-owner caller → 403", async () => {
    const owner = await seedWorkspace("o@xfer3.local", "ws-xfer3")
    const m1 = await addMember(owner.workspaceId, "m1@xfer3.local", "member")
    const m2 = await addMember(owner.workspaceId, "m2@xfer3.local", "member")

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/transfer`,
      {
        method: "POST",
        headers: { Cookie: m1.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ newOwnerUserId: m2.userId }),
      },
    )
    expect(res.status).toBe(403)
  })

  it("transfer to self → 400 target_is_self", async () => {
    const owner = await seedWorkspace("o@xfer4.local", "ws-xfer4")

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/transfer`,
      {
        method: "POST",
        headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ newOwnerUserId: owner.userId }),
      },
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("target_is_self")
  })

  it("malformed body → 400", async () => {
    const owner = await seedWorkspace("o@xfer5.local", "ws-xfer5")

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/transfer`,
      {
        method: "POST",
        headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
        body: "not-json",
      },
    )
    expect(res.status).toBe(400)
  })

  it("race: target removed between verify and batch → 409 transfer_race, caller restored to owner", async () => {
    const owner = await seedWorkspace("o@race.local", "ws-race")
    const m = await addMember(owner.workspaceId, "t@race.local", "member")

    // Monkey-patch env.DB.batch to delete the target row just before the
    // predicate-protected UPDATEs run. That makes the promote UPDATE's
    // meta.changes === 0 and triggers the compensating rollback.
    const origBatch = env.DB.batch.bind(env.DB)
    const spy = vi
      .spyOn(env.DB, "batch")
      .mockImplementationOnce(async (stmts) => {
        // Remove the target membership so the promote UPDATE finds no row.
        const db = createDb(env)
        await db
          .delete(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, owner.workspaceId),
              eq(workspaceMembers.userId, m.userId),
            ),
          )
        return origBatch(stmts)
      })

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}/transfer`,
      {
        method: "POST",
        headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ newOwnerUserId: m.userId }),
      },
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("transfer_race")

    // Caller still owner; no phantom role changes.
    const db = createDb(env)
    const [selfRow] = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, owner.workspaceId),
          eq(workspaceMembers.userId, owner.userId),
        ),
      )
    expect(selfRow!.role).toBe("owner")

    spy.mockRestore()
  })
})

/* ====================================================== DELETE /:wsid */

describe("DELETE /api/workspaces/:wsid", () => {
  it("happy path: removes sessions + R2 objects + api_keys + invites + members + workspace; audit has accurate counts", async () => {
    const owner = await seedWorkspace("o@del.local", "ws-del")
    const m1 = await addMember(owner.workspaceId, "m1@del.local", "member")
    const m2 = await addMember(owner.workspaceId, "m2@del.local", "member")

    const db = createDb(env)

    // Seed two sessions with R2 content.
    const [s1] = await db
      .insert(telemetrySessions)
      .values({
        workspaceId: owner.workspaceId,
        sessionId: "sess-1",
        startedAt: new Date(),
      })
      .returning()
    const [s2] = await db
      .insert(telemetrySessions)
      .values({
        workspaceId: owner.workspaceId,
        sessionId: "sess-2",
        startedAt: new Date(),
        wpilogKey: `sessions/${"placeholder"}/session.wpilog`,
      })
      .returning()

    // Seed R2 blobs. For s2 also set wpilogKey within its prefix.
    const s1Prefix = batchPrefix(s1!.id)
    const s2Prefix = batchPrefix(s2!.id)
    await env.BLOBS.put(`${s1Prefix}batch-0001.jsonl`, "{}")
    await env.BLOBS.put(`${s1Prefix}batch-0002.jsonl`, "{}")
    await env.BLOBS.put(`${s1Prefix}tree.json`, "{}")
    await env.BLOBS.put(`${s2Prefix}batch-0001.jsonl`, "{}")
    await env.BLOBS.put(`${s2Prefix}session.wpilog`, "{}")

    // Normalize s2's wpilogKey to a real key under its prefix.
    await db
      .update(telemetrySessions)
      .set({ wpilogKey: `${s2Prefix}session.wpilog` })
      .where(eq(telemetrySessions.id, s2!.id))

    // Seed 3 api keys.
    for (let i = 0; i < 3; i++) {
      await db.insert(apiKeys).values({
        workspaceId: owner.workspaceId,
        name: `k${i}`,
        prefix: `rs_${i}`,
        last4: "abcd",
        hash: `h${i}-${crypto.randomUUID()}`,
      })
    }

    // Seed 1 pending invite.
    const t = await generateInviteToken()
    await db.insert(workspaceInvites).values({
      workspaceId: owner.workspaceId,
      invitedEmail: "inv@del.local",
      invitedByUserId: owner.userId,
      role: "member",
      tokenHash: t.tokenHash,
      expiresAt: t.expiresAt,
    })

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}`,
      { method: "DELETE", headers: { Cookie: owner.cookie } },
    )
    expect(res.status).toBe(204)

    // D1 cascade
    const sessAfter = await db
      .select()
      .from(telemetrySessions)
      .where(eq(telemetrySessions.workspaceId, owner.workspaceId))
    expect(sessAfter).toHaveLength(0)
    const akAfter = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.workspaceId, owner.workspaceId))
    expect(akAfter).toHaveLength(0)
    const memsAfter = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, owner.workspaceId))
    expect(memsAfter).toHaveLength(0)
    const invAfter = await db
      .select()
      .from(workspaceInvites)
      .where(eq(workspaceInvites.workspaceId, owner.workspaceId))
    expect(invAfter).toHaveLength(0)
    const wsAfter = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, owner.workspaceId))
    expect(wsAfter).toHaveLength(0)

    // R2 — no objects prefixed by either session id.
    const r2AfterS1 = await env.BLOBS.list({ prefix: s1Prefix })
    expect(r2AfterS1.objects).toHaveLength(0)
    const r2AfterS2 = await env.BLOBS.list({ prefix: s2Prefix })
    expect(r2AfterS2.objects).toHaveLength(0)

    // Audit with accurate counts.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "workspace.deleted"))
    expect(audits).toHaveLength(1)
    const meta = JSON.parse(audits[0]!.metadataJson!) as Record<string, number>
    expect(meta.session_count).toBe(2)
    expect(meta.api_key_count).toBe(3)
    expect(meta.r2_object_count).toBe(5)

    // Silence unused-var warnings for members (they were fixtures to prove cascade).
    void m1
    void m2
  })

  it("non-owner caller → 403", async () => {
    const owner = await seedWorkspace("o@del2.local", "ws-del2")
    const m = await addMember(owner.workspaceId, "m@del2.local", "member")

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}`,
      { method: "DELETE", headers: { Cookie: m.cookie } },
    )
    expect(res.status).toBe(403)
  })

  it("R2 failure mid-operation: D1 rows intact, returns 500, retry succeeds", async () => {
    const owner = await seedWorkspace("o@del3.local", "ws-del3")
    const db = createDb(env)

    // Two sessions, with R2 blobs.
    const [s1] = await db
      .insert(telemetrySessions)
      .values({
        workspaceId: owner.workspaceId,
        sessionId: "sess-a",
        startedAt: new Date(),
      })
      .returning()
    const [s2] = await db
      .insert(telemetrySessions)
      .values({
        workspaceId: owner.workspaceId,
        sessionId: "sess-b",
        startedAt: new Date(),
      })
      .returning()

    const s1Prefix = batchPrefix(s1!.id)
    const s2Prefix = batchPrefix(s2!.id)
    await env.BLOBS.put(`${s1Prefix}batch-0001.jsonl`, "x")
    await env.BLOBS.put(`${s2Prefix}batch-0001.jsonl`, "x")

    // Fail on the second session's first delete. The first session's blobs
    // get deleted before the throw, but D1 MUST remain intact.
    const origDelete = env.BLOBS.delete.bind(env.BLOBS)
    let call = 0
    const spy = vi
      .spyOn(env.BLOBS, "delete")
      .mockImplementation(async (...args: Parameters<typeof env.BLOBS.delete>) => {
        call += 1
        const key = args[0] as string
        if (call === 2 && key.startsWith(s2Prefix)) {
          throw new Error("injected R2 delete failure")
        }
        return origDelete(...args)
      })

    const res = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}`,
      { method: "DELETE", headers: { Cookie: owner.cookie } },
    )
    expect(res.status).toBe(500)

    // D1 rows still intact.
    const wsAfter = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, owner.workspaceId))
    expect(wsAfter).toHaveLength(1)
    const memsAfter = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, owner.workspaceId))
    expect(memsAfter).toHaveLength(1)
    const sessAfter = await db
      .select()
      .from(telemetrySessions)
      .where(eq(telemetrySessions.workspaceId, owner.workspaceId))
    expect(sessAfter).toHaveLength(2)

    spy.mockRestore()

    // Retry succeeds.
    const retry = await SELF.fetch(
      `${BASE}/api/workspaces/${owner.workspaceId}`,
      { method: "DELETE", headers: { Cookie: owner.cookie } },
    )
    expect(retry.status).toBe(204)
  })
})
