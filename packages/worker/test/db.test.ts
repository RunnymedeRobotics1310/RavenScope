import { env } from "cloudflare:test"
import { eq } from "drizzle-orm"
import { beforeEach, describe, expect, it } from "vitest"
import { createDb } from "../src/db/client"
import {
  apiKeys,
  loginTokens,
  sessionBatches,
  telemetrySessions,
  users,
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
  const [workspace] = await db
    .insert(workspaces)
    .values({ ownerUserId: user!.id, name: wsName })
    .returning()
  return { user: user!, workspace: workspace! }
}

// Wipe tables between tests to keep cases independent.
beforeEach(async () => {
  const db = createDb(env)
  await db.delete(sessionBatches)
  await db.delete(telemetrySessions)
  await db.delete(apiKeys)
  await db.delete(loginTokens)
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

  it("restricts user deletion while workspaces still reference the user", async () => {
    const db = createDb(env)
    const { user } = await seedUserAndWorkspace("owner@x.test", "owned workspace")

    await assertRejectsWithMessage(
      db.delete(users).where(eq(users.id, user.id)),
      /FOREIGN KEY|constraint/i,
    )

    const stillThere = await db.select().from(users).where(eq(users.id, user.id))
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
