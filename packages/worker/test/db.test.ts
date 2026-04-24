import { env } from "cloudflare:test"
import { eq } from "drizzle-orm"
import { beforeEach, describe, expect, it } from "vitest"
import { createDb } from "../src/db/client"
import {
  apiKeys,
  loginTokens,
  sessionBatches,
  telemetrySessions,
  userViewerPreferences,
  users,
  workspaceInvites,
  workspaceMembers,
  workspaceViewerLayouts,
  workspaces,
} from "../src/db/schema"

/**
 * Drizzle wraps the original D1 error as `err.cause`; we assert against the
 * underlying SQLite constraint message, not drizzle's "Failed query:" wrapper.
 */
async function assertRejectsWithMessage(p: Promise<unknown>, pattern: RegExp) {
  let caught: unknown
  try {
    await p
  } catch (e) {
    caught = e
  }
  expect(caught, "expected the promise to reject").toBeDefined()
  const cause = (caught as { cause?: { message?: string } } | undefined)?.cause
  const message = cause?.message ?? (caught as Error | undefined)?.message ?? String(caught)
  expect(message).toMatch(pattern)
}

async function seedUserAndWorkspace(email: string, wsName: string) {
  const db = createDb(env)
  const [user] = await db.insert(users).values({ email }).returning()
  const [workspace] = await db.insert(workspaces).values({ name: wsName }).returning()
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: workspace!.id, userId: user!.id, role: "owner" })
  return { user: user!, workspace: workspace! }
}

// Wipe tables between tests to keep cases independent.
beforeEach(async () => {
  const db = createDb(env)
  await db.delete(sessionBatches)
  await db.delete(telemetrySessions)
  await db.delete(apiKeys)
  await db.delete(loginTokens)
  await db.delete(workspaceInvites)
  await db.delete(workspaceMembers)
  await db.delete(userViewerPreferences)
  await db.delete(workspaceViewerLayouts)
  await db.delete(workspaces)
  await db.delete(users)
})

describe("schema: happy path", () => {
  it("migrations applied cleanly — can insert into every table", async () => {
    const db = createDb(env)
    const { workspace } = await seedUserAndWorkspace("happy@x.test", "happy workspace")

    await db.insert(apiKeys).values({
      workspaceId: workspace.id,
      name: "CI key",
      prefix: "rsk_live_",
      last4: "abcd",
      hash: "hash-happy",
    })
    const [session] = await db
      .insert(telemetrySessions)
      .values({
        workspaceId: workspace.id,
        sessionId: "sess-happy",
        startedAt: new Date(),
      })
      .returning()
    await db.insert(sessionBatches).values({
      sessionId: session!.id,
      seq: 1,
      byteLength: 10,
      entryCount: 1,
      r2Key: `sessions/${session!.id}/batch-0001.jsonl`,
    })

    expect(session!.entryCount).toBe(0)
    expect(session!.uploadedCount).toBe(0)
  })
})

describe("schema: edge cases", () => {
  it("rejects duplicate (workspace_id, session_id) within a workspace", async () => {
    const db = createDb(env)
    const { workspace } = await seedUserAndWorkspace("dup@x.test", "dup workspace")

    await db.insert(telemetrySessions).values({
      workspaceId: workspace.id,
      sessionId: "sess-dup",
      startedAt: new Date(),
    })

    await assertRejectsWithMessage(
      db.insert(telemetrySessions).values({
        workspaceId: workspace.id,
        sessionId: "sess-dup",
        startedAt: new Date(),
      }),
      /UNIQUE/i,
    )
  })

  it("allows the same session_id under different workspaces", async () => {
    const db = createDb(env)
    const a = await seedUserAndWorkspace("a@x.test", "workspace a")
    const b = await seedUserAndWorkspace("b@x.test", "workspace b")

    await db.insert(telemetrySessions).values({
      workspaceId: a.workspace.id,
      sessionId: "sess-shared",
      startedAt: new Date(),
    })
    await db.insert(telemetrySessions).values({
      workspaceId: b.workspace.id,
      sessionId: "sess-shared",
      startedAt: new Date(),
    })

    const rows = await db
      .select()
      .from(telemetrySessions)
      .where(eq(telemetrySessions.sessionId, "sess-shared"))
    expect(rows).toHaveLength(2)
  })

  it("user deletion cascades workspace_members rows (workspace survives, orphaned of members)", async () => {
    // After migration 0002, workspaces no longer hold an owner_user_id FK —
    // ownership flows through `workspace_members`. The membership FK uses
    // onDelete=cascade (both sides), so deleting a user removes their
    // memberships while leaving the workspace row intact. Downstream data
    // (api_keys, telemetry_sessions) is still protected by
    // onDelete=restrict on their workspace FK.
    const db = createDb(env)
    const { user, workspace } = await seedUserAndWorkspace("owner@x.test", "owned workspace")

    await db.delete(users).where(eq(users.id, user.id))

    const usersAfter = await db.select().from(users).where(eq(users.id, user.id))
    expect(usersAfter).toHaveLength(0)

    const membershipsAfter = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspace.id))
    expect(membershipsAfter).toHaveLength(0)

    const workspacesAfter = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspace.id))
    expect(workspacesAfter).toHaveLength(1)
  })

  it("restricts workspace deletion while api_keys still reference the workspace", async () => {
    // The restrict discipline is preserved on business-data FKs. You can't
    // drop a workspace out from under its api_keys without deleting them
    // first (which is what the DELETE workspace route will do in U5).
    const db = createDb(env)
    const { workspace } = await seedUserAndWorkspace("restrict@x.test", "restricted ws")
    await db.insert(apiKeys).values({
      workspaceId: workspace.id,
      name: "blocker",
      prefix: "rsk_live_",
      last4: "zzzz",
      hash: "hash-restrict",
    })

    await assertRejectsWithMessage(
      db.delete(workspaces).where(eq(workspaces.id, workspace.id)),
      /FOREIGN KEY|constraint/i,
    )

    const stillThere = await db.select().from(workspaces).where(eq(workspaces.id, workspace.id))
    expect(stillThere).toHaveLength(1)
  })

  it("enforces api_keys.hash uniqueness across workspaces", async () => {
    const db = createDb(env)
    const a = await seedUserAndWorkspace("ka@x.test", "ws a")
    const b = await seedUserAndWorkspace("kb@x.test", "ws b")

    await db.insert(apiKeys).values({
      workspaceId: a.workspace.id,
      name: "a-key",
      prefix: "rsk_live_",
      last4: "1111",
      hash: "collision-hash",
    })

    await assertRejectsWithMessage(
      db.insert(apiKeys).values({
        workspaceId: b.workspace.id,
        name: "b-key",
        prefix: "rsk_live_",
        last4: "2222",
        hash: "collision-hash",
      }),
      /UNIQUE/i,
    )
  })

  it("cascades session deletion to its batches", async () => {
    const db = createDb(env)
    const { workspace } = await seedUserAndWorkspace("cascade@x.test", "cascade ws")
    const [session] = await db
      .insert(telemetrySessions)
      .values({
        workspaceId: workspace.id,
        sessionId: "sess-cascade",
        startedAt: new Date(),
      })
      .returning()
    await db.insert(sessionBatches).values({
      sessionId: session!.id,
      seq: 1,
      byteLength: 10,
      entryCount: 1,
      r2Key: "r2-key",
    })

    await db.delete(telemetrySessions).where(eq(telemetrySessions.id, session!.id))

    const orphans = await db
      .select()
      .from(sessionBatches)
      .where(eq(sessionBatches.sessionId, session!.id))
    expect(orphans).toHaveLength(0)
  })
})

describe("schema: workspace members & invites (U1)", () => {
  it("composite PK rejects duplicate (workspace_id, user_id) membership rows", async () => {
    const db = createDb(env)
    const { user, workspace } = await seedUserAndWorkspace("dup@x.test", "dup ws")

    await assertRejectsWithMessage(
      db
        .insert(workspaceMembers)
        .values({ workspaceId: workspace.id, userId: user.id, role: "member" }),
      /UNIQUE|PRIMARY KEY|constraint/i,
    )
  })

  it("cascades membership rows when the workspace is deleted", async () => {
    const db = createDb(env)
    const { user, workspace } = await seedUserAndWorkspace("wscas@x.test", "wscas")
    // Second member to make the cascade observable.
    const [other] = await db
      .insert(users)
      .values({ email: "second@x.test" })
      .returning()
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: workspace.id, userId: other!.id, role: "member" })

    await db.delete(workspaces).where(eq(workspaces.id, workspace.id))

    const rows = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspace.id))
    expect(rows).toHaveLength(0)
    // Both user rows survive — cascade only removes memberships, not users.
    const usersAfter = await db.select().from(users)
    expect(usersAfter.map((u) => u.email).sort()).toEqual(["second@x.test", "wscas@x.test"])
    void user // silence unused
  })

  it("partial unique index blocks a second pending invite for the same (workspace, email)", async () => {
    const db = createDb(env)
    const { workspace } = await seedUserAndWorkspace("inviter@x.test", "inv ws")

    await db.insert(workspaceInvites).values({
      workspaceId: workspace.id,
      invitedEmail: "dup@target.test",
      role: "member",
      tokenHash: "hash-1",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })

    await assertRejectsWithMessage(
      db.insert(workspaceInvites).values({
        workspaceId: workspace.id,
        invitedEmail: "dup@target.test",
        role: "member",
        tokenHash: "hash-2",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }),
      /UNIQUE|constraint/i,
    )
  })

  it("partial unique index permits a new pending invite once the prior is revoked", async () => {
    const db = createDb(env)
    const { workspace } = await seedUserAndWorkspace("reinviter@x.test", "reinv ws")

    const [first] = await db
      .insert(workspaceInvites)
      .values({
        workspaceId: workspace.id,
        invitedEmail: "again@target.test",
        role: "member",
        tokenHash: "hash-first",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .returning()

    // Revoke the first invite.
    await db
      .update(workspaceInvites)
      .set({ revokedAt: new Date() })
      .where(eq(workspaceInvites.id, first!.id))

    // A second invite to the same address is now allowed.
    await db.insert(workspaceInvites).values({
      workspaceId: workspace.id,
      invitedEmail: "again@target.test",
      role: "member",
      tokenHash: "hash-second",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })

    const all = await db.select().from(workspaceInvites)
    expect(all).toHaveLength(2)
  })

  it("partial unique index permits a new pending invite once the prior is accepted", async () => {
    const db = createDb(env)
    const { workspace } = await seedUserAndWorkspace("accepter@x.test", "acc ws")

    const [first] = await db
      .insert(workspaceInvites)
      .values({
        workspaceId: workspace.id,
        invitedEmail: "rejoin@target.test",
        role: "member",
        tokenHash: "hash-accepted",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .returning()

    await db
      .update(workspaceInvites)
      .set({ acceptedAt: new Date() })
      .where(eq(workspaceInvites.id, first!.id))

    await db.insert(workspaceInvites).values({
      workspaceId: workspace.id,
      invitedEmail: "rejoin@target.test",
      role: "member",
      tokenHash: "hash-second",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })

    const all = await db.select().from(workspaceInvites)
    expect(all).toHaveLength(2)
  })

  it("token_hash uniqueness is absolute across workspaces", async () => {
    const db = createDb(env)
    const a = await seedUserAndWorkspace("ta@x.test", "ws a")
    const b = await seedUserAndWorkspace("tb@x.test", "ws b")

    await db.insert(workspaceInvites).values({
      workspaceId: a.workspace.id,
      invitedEmail: "x@target.test",
      role: "member",
      tokenHash: "collision-token",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })

    await assertRejectsWithMessage(
      db.insert(workspaceInvites).values({
        workspaceId: b.workspace.id,
        invitedEmail: "y@target.test",
        role: "member",
        tokenHash: "collision-token",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }),
      /UNIQUE/i,
    )
  })
})

describe("schema: viewer layouts & preferences (U1)", () => {
  it("rejects duplicate (workspace_id, name) within a workspace", async () => {
    const db = createDb(env)
    const { user, workspace } = await seedUserAndWorkspace("vl1@x.test", "vl ws1")
    await db.insert(workspaceViewerLayouts).values({
      workspaceId: workspace.id,
      name: "Coach view",
      stateJson: "{}",
      createdByUserId: user.id,
    })

    await assertRejectsWithMessage(
      db.insert(workspaceViewerLayouts).values({
        workspaceId: workspace.id,
        name: "Coach view",
        stateJson: "{}",
        createdByUserId: user.id,
      }),
      /UNIQUE|constraint/i,
    )
  })

  it("allows the same layout name under different workspaces", async () => {
    const db = createDb(env)
    const a = await seedUserAndWorkspace("vlx@x.test", "vl ws x")
    const b = await seedUserAndWorkspace("vly@x.test", "vl ws y")
    await db.insert(workspaceViewerLayouts).values({
      workspaceId: a.workspace.id,
      name: "Shared name",
      stateJson: "{}",
    })
    await db.insert(workspaceViewerLayouts).values({
      workspaceId: b.workspace.id,
      name: "Shared name",
      stateJson: "{}",
    })
    const rows = await db.select().from(workspaceViewerLayouts)
    expect(rows).toHaveLength(2)
  })

  it("deleting a layout sets default_layout_id to NULL on any prefs rows pointing at it", async () => {
    // R3/R6: another user having your layout as their default should not
    // block its deletion, and should not cascade-erase their captured
    // last-used blob. Confirmed by onDelete=set null on the FK.
    const db = createDb(env)
    const { user, workspace } = await seedUserAndWorkspace("vl2@x.test", "vl ws2")
    const [layout] = await db
      .insert(workspaceViewerLayouts)
      .values({
        workspaceId: workspace.id,
        name: "About to die",
        stateJson: "{}",
      })
      .returning()
    await db.insert(userViewerPreferences).values({
      userId: user.id,
      workspaceId: workspace.id,
      defaultLayoutId: layout!.id,
      lastUsedStateJson: '{"last":"used"}',
    })

    await db.delete(workspaceViewerLayouts).where(eq(workspaceViewerLayouts.id, layout!.id))

    const [prefs] = await db
      .select()
      .from(userViewerPreferences)
      .where(eq(userViewerPreferences.userId, user.id))
    expect(prefs).toBeDefined()
    expect(prefs!.defaultLayoutId).toBeNull()
    // Last-used survives the layout delete — intentional, it's per-user state.
    expect(prefs!.lastUsedStateJson).toBe('{"last":"used"}')
  })

  it("deleting a workspace cascades both layouts and prefs", async () => {
    const db = createDb(env)
    const { user, workspace } = await seedUserAndWorkspace("vl3@x.test", "vl ws3")
    await db.insert(workspaceViewerLayouts).values({
      workspaceId: workspace.id,
      name: "Layout A",
      stateJson: "{}",
    })
    await db.insert(userViewerPreferences).values({
      userId: user.id,
      workspaceId: workspace.id,
      lastUsedStateJson: "{}",
    })

    await db.delete(workspaces).where(eq(workspaces.id, workspace.id))

    const layoutsAfter = await db
      .select()
      .from(workspaceViewerLayouts)
      .where(eq(workspaceViewerLayouts.workspaceId, workspace.id))
    expect(layoutsAfter).toHaveLength(0)
    const prefsAfter = await db
      .select()
      .from(userViewerPreferences)
      .where(eq(userViewerPreferences.workspaceId, workspace.id))
    expect(prefsAfter).toHaveLength(0)
  })

  it("deleting a user cascades their prefs but nulls their authored layouts' created_by", async () => {
    // Preserves the layout for the team while removing personal prefs.
    const db = createDb(env)
    const { user, workspace } = await seedUserAndWorkspace("vl4@x.test", "vl ws4")
    const [layout] = await db
      .insert(workspaceViewerLayouts)
      .values({
        workspaceId: workspace.id,
        name: "Keeper",
        stateJson: "{}",
        createdByUserId: user.id,
      })
      .returning()
    await db.insert(userViewerPreferences).values({
      userId: user.id,
      workspaceId: workspace.id,
      lastUsedStateJson: "{}",
    })

    await db.delete(users).where(eq(users.id, user.id))

    const prefsAfter = await db
      .select()
      .from(userViewerPreferences)
      .where(eq(userViewerPreferences.userId, user.id))
    expect(prefsAfter).toHaveLength(0)
    const [kept] = await db
      .select()
      .from(workspaceViewerLayouts)
      .where(eq(workspaceViewerLayouts.id, layout!.id))
    expect(kept).toBeDefined()
    expect(kept!.createdByUserId).toBeNull()
  })

  it("composite PK rejects duplicate (user_id, workspace_id) prefs rows", async () => {
    const db = createDb(env)
    const { user, workspace } = await seedUserAndWorkspace("vl5@x.test", "vl ws5")
    await db.insert(userViewerPreferences).values({
      userId: user.id,
      workspaceId: workspace.id,
      lastUsedStateJson: "{}",
    })
    await assertRejectsWithMessage(
      db.insert(userViewerPreferences).values({
        userId: user.id,
        workspaceId: workspace.id,
        lastUsedStateJson: "{}",
      }),
      /UNIQUE|PRIMARY KEY|constraint/i,
    )
  })
})
