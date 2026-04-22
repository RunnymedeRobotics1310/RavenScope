import { and, desc, eq } from "drizzle-orm"
import { Hono } from "hono"
import { hashIp, logAudit } from "../audit/log"
import { generateApiKey } from "../auth/apikey"
import { requireCookieUser } from "../auth/require-cookie-user"
import { requireCookieKind } from "../auth/user"
import { createDb } from "../db/client"
import { apiKeys } from "../db/schema"
import type {
  ApiKeyCreateRequest,
  ApiKeyCreateResponse,
  ApiKeyListResponse,
} from "../dto"
import type { Env } from "../env"

export const apiKeyRoutes = new Hono<{ Bindings: Env }>()
apiKeyRoutes.use("*", requireCookieUser)

apiKeyRoutes.post("/", async (c) => {
  const user = c.var.user
  requireCookieKind(user)

  const body = await c.req.json<ApiKeyCreateRequest>().catch(() => null)
  if (!body || typeof body.name !== "string") {
    return c.json({ error: "invalid_name" }, 400)
  }
  const name = body.name.trim()
  if (name.length < 1 || name.length > 100) {
    return c.json({ error: "invalid_name_length" }, 400)
  }

  const db = createDb(c.env)
  const generated = await generateApiKey()
  const [row] = await db
    .insert(apiKeys)
    .values({
      workspaceId: user.workspaceId,
      name,
      prefix: generated.prefix,
      last4: generated.last4,
      hash: generated.hash,
    })
    .returning()

  await logAudit(db, {
    eventType: "key_create",
    actorUserId: user.userId,
    workspaceId: user.workspaceId,
    ipHash: await hashIp(c.req.header("CF-Connecting-IP") ?? "unknown"),
    metadata: { keyId: row!.id, name },
  })

  const response: ApiKeyCreateResponse = {
    id: row!.id,
    name: row!.name,
    prefix: row!.prefix,
    last4: row!.last4,
    createdAt: row!.createdAt.getTime(),
    plaintext: generated.plaintext,
  }
  return c.json(response, 201)
})

apiKeyRoutes.get("/", async (c) => {
  const user = c.var.user
  requireCookieKind(user)

  const db = createDb(c.env)
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.workspaceId, user.workspaceId))
    .orderBy(desc(apiKeys.createdAt))

  const response: ApiKeyListResponse = {
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      last4: r.last4,
      createdAt: r.createdAt.getTime(),
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.getTime() : null,
      revokedAt: r.revokedAt ? r.revokedAt.getTime() : null,
    })),
  }
  return c.json(response)
})

apiKeyRoutes.delete("/:id", async (c) => {
  const user = c.var.user
  requireCookieKind(user)
  const id = c.req.param("id")

  const db = createDb(c.env)
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, user.workspaceId)))
    .limit(1)

  if (!row) return c.json({ error: "not_found" }, 404)
  if (row.revokedAt) return c.body(null, 204) // idempotent

  await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id))
  await logAudit(db, {
    eventType: "key_revoke",
    actorUserId: user.userId,
    workspaceId: user.workspaceId,
    ipHash: await hashIp(c.req.header("CF-Connecting-IP") ?? "unknown"),
    metadata: { keyId: id },
  })
  return c.body(null, 204)
})
