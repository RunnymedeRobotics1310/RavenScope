import { eq } from "drizzle-orm"
import type { MiddlewareHandler } from "hono"
import { logAudit } from "../audit/log"
import { createDb } from "../db/client"
import { apiKeys } from "../db/schema"
import type { Env } from "../env"
import { hashApiKey, parseAuthorizationHeader } from "./apikey"
// Imports the module augmentation that registers `user` in ContextVariableMap.
import "./user"

/**
 * Reads `Authorization: Bearer rsk_live_...`, verifies the hash against
 * `api_keys.hash`, rejects revoked tokens, and hydrates `c.var.user` with
 * `{ kind: "apikey", workspaceId, apiKeyId }`. last_used_at is updated via
 * ctx.waitUntil so the response isn't delayed.
 */
export const requireApiKeyUser: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const token = parseAuthorizationHeader(c.req.header("Authorization"))
  if (!token) return c.json({ error: "unauthenticated" }, 401)

  const hash = await hashApiKey(token)
  const db = createDb(c.env)
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.hash, hash)).limit(1)
  if (!row || row.revokedAt) return c.json({ error: "unauthenticated" }, 401)

  c.set("user", {
    kind: "apikey",
    workspaceId: row.workspaceId,
    apiKeyId: row.id,
  })

  c.executionCtx.waitUntil(
    (async () => {
      const now = new Date()
      await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.id))
      await logAudit(db, {
        eventType: "key_use",
        actorApiKeyId: row.id,
        workspaceId: row.workspaceId,
      })
    })(),
  )

  await next()
}
