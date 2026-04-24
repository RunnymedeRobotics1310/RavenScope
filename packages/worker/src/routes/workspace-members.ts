/**
 * Workspace member management — U5 of the workspace-members plan.
 *
 * Owner-only:
 *   GET    /:wsid/members                list members
 *   DELETE /:wsid/members/:userId        remove a member
 *   POST   /:wsid/transfer               transfer ownership (body: {newOwnerUserId})
 *   DELETE /:wsid                        delete the workspace (R2 cleanup first, then D1)
 *
 * Any cookie user who is a member:
 *   POST   /:wsid/leave                  leave the workspace
 *
 * Cross-tenancy guard: the :wsid path param must match c.var.user.workspaceId.
 * If it doesn't, return 403 `{error: "forbidden"}`.
 */

import { and, asc, eq } from "drizzle-orm"
import { Hono } from "hono"
import { hashIp, logAudit } from "../audit/log"
import { requireCookieUser } from "../auth/require-cookie-user"
import { requireOwnerRole } from "../auth/require-owner-role"
import { requireCookieKind } from "../auth/user"
import { createDb } from "../db/client"
import {
  apiKeys,
  telemetrySessions,
  users,
  workspaceInvites,
  workspaceMembers,
  workspaces,
} from "../db/schema"
import type {
  MemberDto,
  MembersResponse,
  TransferOwnershipRequest,
} from "../dto"
import type { Env } from "../env"
import { batchPrefix } from "../storage/keys"

export const workspaceMembersRoutes = new Hono<{ Bindings: Env }>()

// Every route here requires a cookie user. Owner-only middlewares apply per-route.
workspaceMembersRoutes.use("*", requireCookieUser)

function assertActiveWsid(
  userWsid: string,
  paramWsid: string,
): "ok" | "mismatch" {
  return userWsid === paramWsid ? "ok" : "mismatch"
}

/* ------------------------------------------------- GET /:wsid/members */

workspaceMembersRoutes.get("/:wsid/members", requireOwnerRole, async (c) => {
  const user = c.var.user
  requireCookieKind(user)
  const paramWsid = c.req.param("wsid")
  if (assertActiveWsid(user.workspaceId, paramWsid) !== "ok") {
    return c.json({ error: "forbidden" }, 403)
  }

  const db = createDb(c.env)
  const rows = await db
    .select({
      userId: workspaceMembers.userId,
      email: users.email,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.joinedAt,
      invitedByUserId: workspaceMembers.invitedByUserId,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, paramWsid))
    .orderBy(asc(workspaceMembers.joinedAt), asc(workspaceMembers.userId))

  const members: MemberDto[] = rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    role: r.role as "owner" | "member",
    joinedAt: r.joinedAt.getTime(),
    invitedByUserId: r.invitedByUserId ?? null,
  }))
  const response: MembersResponse = { members }
  return c.json(response)
})

/* ------------------------------- DELETE /:wsid/members/:userId (remove) */

workspaceMembersRoutes.delete(
  "/:wsid/members/:userId",
  requireOwnerRole,
  async (c) => {
    const user = c.var.user
    requireCookieKind(user)
    const paramWsid = c.req.param("wsid")
    const targetUserId = c.req.param("userId")
    if (assertActiveWsid(user.workspaceId, paramWsid) !== "ok") {
      return c.json({ error: "forbidden" }, 403)
    }
    if (targetUserId === user.userId) {
      return c.json(
        { error: "cannot_remove_self", hint: "use_leave_or_transfer" },
        409,
      )
    }

    const db = createDb(c.env)
    const [target] = await db
      .select({
        userId: workspaceMembers.userId,
        email: users.email,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, paramWsid),
          eq(workspaceMembers.userId, targetUserId),
        ),
      )
      .limit(1)
    if (!target) return c.json({ error: "not_found" }, 404)

    await db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, paramWsid),
          eq(workspaceMembers.userId, targetUserId),
        ),
      )

    const ipHash = await hashIp(c.req.header("CF-Connecting-IP") ?? "unknown")
    await logAudit(db, {
      eventType: "workspace.member_removed",
      actorUserId: user.userId,
      workspaceId: paramWsid,
      ipHash,
      metadata: {
        removed_user_id: target.userId,
        removed_email: target.email,
      },
    })

    return c.body(null, 204)
  },
)

/* ------------------------------------------- POST /:wsid/leave (self) */

workspaceMembersRoutes.post("/:wsid/leave", async (c) => {
  const user = c.var.user
  requireCookieKind(user)
  const paramWsid = c.req.param("wsid")
  if (assertActiveWsid(user.workspaceId, paramWsid) !== "ok") {
    return c.json({ error: "forbidden" }, 403)
  }

  const db = createDb(c.env)

  // Find all owner rows in this workspace. If the caller is the only owner,
  // refuse — they must transfer or delete.
  const owners = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, paramWsid),
        eq(workspaceMembers.role, "owner"),
      ),
    )

  if (user.role === "owner") {
    const otherOwners = owners.filter((o) => o.userId !== user.userId)
    if (otherOwners.length === 0) {
      return c.json(
        { error: "sole_owner_cannot_leave", hint: "transfer_or_delete" },
        409,
      )
    }
  }

  await db
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, paramWsid),
        eq(workspaceMembers.userId, user.userId),
      ),
    )

  const ipHash = await hashIp(c.req.header("CF-Connecting-IP") ?? "unknown")
  await logAudit(db, {
    eventType: "workspace.member_left",
    actorUserId: user.userId,
    workspaceId: paramWsid,
    ipHash,
    metadata: { user_id: user.userId, email: user.email },
  })

  return c.body(null, 204)
})

/* ----------------------------------- POST /:wsid/transfer (ownership) */

workspaceMembersRoutes.post("/:wsid/transfer", requireOwnerRole, async (c) => {
  const user = c.var.user
  requireCookieKind(user)
  const paramWsid = c.req.param("wsid")
  if (assertActiveWsid(user.workspaceId, paramWsid) !== "ok") {
    return c.json({ error: "forbidden" }, 403)
  }

  const body = await c.req.json<TransferOwnershipRequest>().catch(() => null)
  if (
    !body ||
    typeof body.newOwnerUserId !== "string" ||
    body.newOwnerUserId.trim() === ""
  ) {
    return c.json({ error: "invalid_request" }, 400)
  }
  const targetUserId = body.newOwnerUserId.trim()
  if (targetUserId === user.userId) {
    return c.json({ error: "target_is_self" }, 400)
  }

  const db = createDb(c.env)

  // Verify the target is a current member (role='member' — the only valid
  // promotable state; owner->owner is impossible in v1).
  const [targetMembership] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, paramWsid),
        eq(workspaceMembers.userId, targetUserId),
      ),
    )
    .limit(1)
  if (!targetMembership) {
    return c.json({ error: "target_not_member" }, 409)
  }

  // Predicate-protected UPDATEs via raw D1 batch so we can inspect
  // meta.changes per statement. Each UPDATE only fires if the target row is
  // in the expected role — closes the concurrent-removal race.
  const demoteSelf = c.env.DB.prepare(
    "UPDATE workspace_members SET role = 'member' WHERE workspace_id = ? AND user_id = ? AND role = 'owner'",
  ).bind(paramWsid, user.userId)
  const promoteTarget = c.env.DB.prepare(
    "UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ? AND user_id = ? AND role = 'member'",
  ).bind(paramWsid, targetUserId)

  const results = await c.env.DB.batch([demoteSelf, promoteTarget])
  const demoteChanges = results[0]?.meta?.changes ?? 0
  const promoteChanges = results[1]?.meta?.changes ?? 0

  if (demoteChanges === 0 || promoteChanges === 0) {
    // Compensate: if we demoted the caller but the target promotion failed,
    // restore the caller's owner row.
    if (demoteChanges > 0 && promoteChanges === 0) {
      await c.env.DB.prepare(
        "UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ? AND user_id = ? AND role = 'member'",
      )
        .bind(paramWsid, user.userId)
        .run()
    }
    // If we promoted target but caller demote failed (caller was already
    // demoted by someone else), demote target back so we never end with two
    // owners.
    if (promoteChanges > 0 && demoteChanges === 0) {
      await c.env.DB.prepare(
        "UPDATE workspace_members SET role = 'member' WHERE workspace_id = ? AND user_id = ? AND role = 'owner'",
      )
        .bind(paramWsid, targetUserId)
        .run()
    }
    return c.json({ error: "transfer_race" }, 409)
  }

  const ipHash = await hashIp(c.req.header("CF-Connecting-IP") ?? "unknown")
  await logAudit(db, {
    eventType: "workspace.ownership_transferred",
    actorUserId: user.userId,
    workspaceId: paramWsid,
    ipHash,
    metadata: {
      from_user_id: user.userId,
      to_user_id: targetUserId,
    },
  })

  return c.body(null, 204)
})

/* ------------------------------------ DELETE /:wsid (delete workspace) */

workspaceMembersRoutes.delete("/:wsid", requireOwnerRole, async (c) => {
  const user = c.var.user
  requireCookieKind(user)
  const paramWsid = c.req.param("wsid")
  if (assertActiveWsid(user.workspaceId, paramWsid) !== "ok") {
    return c.json({ error: "forbidden" }, 403)
  }

  const db = createDb(c.env)

  // (a) Enumerate sessions in this workspace.
  const sessionRows = await db
    .select({
      id: telemetrySessions.id,
      wpilogKey: telemetrySessions.wpilogKey,
    })
    .from(telemetrySessions)
    .where(eq(telemetrySessions.workspaceId, paramWsid))

  // (b) R2 cleanup — do this BEFORE any D1 mutation so a mid-operation
  // failure leaves a retry-safe state (D1 intact + possibly orphan blobs).
  let r2ObjectCount = 0
  try {
    for (const session of sessionRows) {
      const prefix = batchPrefix(session.id)
      let cursor: string | undefined
      while (true) {
        const options: R2ListOptions = cursor ? { prefix, cursor } : { prefix }
        const listed = await c.env.BLOBS.list(options)
        for (const obj of listed.objects) {
          await c.env.BLOBS.delete(obj.key)
          r2ObjectCount += 1
        }
        if (!listed.truncated) break
        cursor = listed.cursor
      }
      if (session.wpilogKey) {
        // The wpilogKey usually lives under the batchPrefix and was already
        // listed + deleted above; this is a defensive cleanup for any stored
        // key that sits outside that prefix.
        const prefixMatch = session.wpilogKey.startsWith(prefix)
        if (!prefixMatch) {
          await c.env.BLOBS.delete(session.wpilogKey)
          r2ObjectCount += 1
        }
      }
    }
  } catch (err) {
    // Leave D1 intact so retry is safe.
    return c.json(
      { error: "r2_cleanup_failed", message: String(err) },
      500,
    )
  }

  // (c) Delete telemetry_sessions — cascades session_batches per schema.
  await db
    .delete(telemetrySessions)
    .where(eq(telemetrySessions.workspaceId, paramWsid))

  // (d) api_keys (restrict FK — explicit delete required before workspaces).
  const apiKeyRows = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.workspaceId, paramWsid))
  await db.delete(apiKeys).where(eq(apiKeys.workspaceId, paramWsid))

  // (e) workspace_members + workspace_invites. FKs cascade on workspace
  // delete, but the plan asks for explicit orchestration.
  await db
    .delete(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, paramWsid))
  await db
    .delete(workspaceInvites)
    .where(eq(workspaceInvites.workspaceId, paramWsid))

  // (f) the workspaces row itself.
  await db.delete(workspaces).where(eq(workspaces.id, paramWsid))

  const ipHash = await hashIp(c.req.header("CF-Connecting-IP") ?? "unknown")
  await logAudit(db, {
    eventType: "workspace.deleted",
    actorUserId: user.userId,
    workspaceId: paramWsid,
    ipHash,
    metadata: {
      session_count: sessionRows.length,
      r2_object_count: r2ObjectCount,
      api_key_count: apiKeyRows.length,
    },
  })

  return c.body(null, 204)
})
