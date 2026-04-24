import type { MiddlewareHandler } from "hono"
import type { Env } from "../env"
import { requireCookieKind } from "./user"

/**
 * Enforces the 'owner' role for the active workspace. Must compose AFTER
 * `requireCookieUser`, which populates `c.var.user.role`.
 *
 * Returns 403 `{error: "forbidden"}` for non-owner cookie users.
 */
export const requireOwnerRole: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const user = c.var.user
  requireCookieKind(user)
  if (user.role !== "owner") {
    return c.json({ error: "forbidden" }, 403)
  }
  await next()
}
