/**
 * Invite-token generation + hashing. Mirrors the nonce/hash pattern from
 * `magic-link.ts`'s `generateToken`: 32 random bytes → base64url nonce →
 * SHA-256 base64url digest stored at rest. The raw nonce leaves the Worker
 * only via the invite email; the DB keeps just the hash, so a DB read never
 * yields an accept URL.
 *
 * TTL is 7 days (vs. magic-link's 15 minutes) — invites intentionally live
 * longer because the invited email may not be checked for several days.
 */

export const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export interface GeneratedInviteToken {
  /** Raw nonce embedded in the accept URL. Never persisted. */
  nonce: string
  /** SHA-256(nonce), base64url. Stored in `workspace_invites.token_hash`. */
  tokenHash: string
  /** Absolute expiry (Date) for `workspace_invites.expires_at`. */
  expiresAt: Date
}

export async function generateInviteToken(
  now: Date = new Date(),
): Promise<GeneratedInviteToken> {
  const raw = new Uint8Array(32)
  crypto.getRandomValues(raw)
  const nonce = toBase64Url(raw)
  const tokenHash = await hashInviteNonce(nonce)
  return { nonce, tokenHash, expiresAt: new Date(now.getTime() + INVITE_TOKEN_TTL_MS) }
}

export async function hashInviteNonce(nonce: string): Promise<string> {
  const data = new TextEncoder().encode(nonce)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return toBase64Url(new Uint8Array(digest))
}

function toBase64Url(bytes: Uint8Array): string {
  let s = ""
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}
