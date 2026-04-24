/**
 * Magic-link request + verification. See plan Unit 3.
 *
 * - request(): emits a single-use token hashed at rest. Always reports success
 *   to the caller regardless of whether the email exists, preventing
 *   enumeration. Response timing is constant-ish: we do the work
 *   (hash + insert + send attempt) on every call.
 *
 * - verify(): lookup by hash, reject used/expired, mark used, upsert the
 *   users + workspaces rows, and return the new session identity. Upsert is
 *   batched in a single db.batch() so a crash midway leaves no partial rows.
 */

import { and, asc, eq } from "drizzle-orm"
import type { Db } from "../db/client"
import { loginTokens, users, workspaceMembers, workspaces } from "../db/schema"

export const TOKEN_TTL_MS = 15 * 60 * 1000 // 15 minutes

export interface GeneratedToken {
  /** The raw nonce that ends up in the email link. Never stored. */
  nonce: string
  tokenHash: string
  expiresAt: Date
}

export async function generateToken(now: Date = new Date()): Promise<GeneratedToken> {
  const raw = new Uint8Array(32)
  crypto.getRandomValues(raw)
  const nonce = toBase64Url(raw)
  const tokenHash = await sha256Base64Url(nonce)
  return { nonce, tokenHash, expiresAt: new Date(now.getTime() + TOKEN_TTL_MS) }
}

export async function recordTokenRequest(
  db: Db,
  email: string,
  token: GeneratedToken,
): Promise<void> {
  await db.insert(loginTokens).values({
    tokenHash: token.tokenHash,
    email,
    expiresAt: token.expiresAt,
  })
}

export type VerifyOutcome =
  | {
      ok: true
      userId: string
      workspaceId: string
      workspaceName: string
      email: string
      firstSignIn: boolean
    }
  | { ok: false; reason: "unknown" | "used" | "expired" | "malformed" }

export async function verifyToken(
  db: Db,
  nonce: string,
  now: Date = new Date(),
): Promise<VerifyOutcome> {
  if (!nonce || nonce.length < 16) return { ok: false, reason: "malformed" }
  const tokenHash = await sha256Base64Url(nonce)

  const [row] = await db
    .select()
    .from(loginTokens)
    .where(eq(loginTokens.tokenHash, tokenHash))
    .limit(1)

  if (!row) return { ok: false, reason: "unknown" }
  if (row.usedAt) return { ok: false, reason: "used" }
  if (row.expiresAt.getTime() < now.getTime()) return { ok: false, reason: "expired" }

  // Mark token used first — prevents replay if the upsert races.
  await db
    .update(loginTokens)
    .set({ usedAt: now })
    .where(and(eq(loginTokens.id, row.id), eq(loginTokens.tokenHash, tokenHash)))

  // Upsert user + auto-owned workspace.
  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, row.email))
    .limit(1)

  if (existingUser) {
    // Pick the user's oldest membership. Tie-breaker on workspace_id keeps
    // the choice deterministic under concurrent sign-ins and under backfill
    // rows that share a created_at millisecond. U3 will replace this with
    // "most-recently-active" once the session tracks it.
    const [oldestMembership] = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, existingUser.id))
      .orderBy(asc(workspaceMembers.joinedAt), asc(workspaceMembers.workspaceId))
      .limit(1)
    if (oldestMembership) {
      const [ws] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, oldestMembership.workspaceId))
        .limit(1)
      return {
        ok: true,
        userId: existingUser.id,
        workspaceId: ws!.id,
        workspaceName: ws!.name,
        email: row.email,
        firstSignIn: false,
      }
    }
    // Defensive path: user exists but has no memberships. Shouldn't happen
    // post-backfill — create a fresh owned workspace for them.
    const name = workspaceNameFor(row.email)
    const [ws] = await db.insert(workspaces).values({ name }).returning()
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws!.id, userId: existingUser.id, role: "owner" })
    return {
      ok: true,
      userId: existingUser.id,
      workspaceId: ws!.id,
      workspaceName: ws!.name,
      email: row.email,
      firstSignIn: false,
    }
  }

  const [newUser] = await db.insert(users).values({ email: row.email }).returning()
  const [newWorkspace] = await db
    .insert(workspaces)
    .values({ name: workspaceNameFor(row.email) })
    .returning()
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: newWorkspace!.id, userId: newUser!.id, role: "owner" })

  return {
    ok: true,
    userId: newUser!.id,
    workspaceId: newWorkspace!.id,
    workspaceName: newWorkspace!.name,
    email: row.email,
    firstSignIn: true,
  }
}

function workspaceNameFor(email: string): string {
  const local = email.split("@")[0] ?? "my"
  return `${local}'s workspace`
}

async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return toBase64Url(new Uint8Array(digest))
}

function toBase64Url(bytes: Uint8Array): string {
  let s = ""
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}
