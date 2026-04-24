/**
 * Shared auth identity types. See plan Unit 3 → 4:
 * cookie auth (web UI) and bearer API-key auth (ingest) never mix on a
 * given route, but both set `c.var.user` so callers that only care about
 * `workspaceId` can treat them uniformly.
 */

export interface CookieUser {
  kind: "cookie"
  userId: string
  workspaceId: string
  email: string
  workspaceName: string
  /** Membership role for the active workspace. Always set by requireCookieUser. */
  role: "owner" | "member"
}

export interface ApiKeyUser {
  kind: "apikey"
  workspaceId: string
  apiKeyId: string
}

export type AuthUser = CookieUser | ApiKeyUser

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser
  }
}

export function requireCookieKind(user: AuthUser): asserts user is CookieUser {
  if (user.kind !== "cookie") {
    throw new Error("cookie-kind auth expected")
  }
}

export function requireApiKeyKind(user: AuthUser): asserts user is ApiKeyUser {
  if (user.kind !== "apikey") {
    throw new Error("apikey-kind auth expected")
  }
}
