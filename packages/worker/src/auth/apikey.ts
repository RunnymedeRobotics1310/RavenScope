/**
 * API key token format, generation, parsing, and hashing. See plan Unit 4.
 *
 * Token layout: `rsk_live_` prefix + 32 random bytes as base64url (no
 * padding) = ~52 chars total. The full plaintext is returned once at
 * creation and never stored. At rest we keep:
 *   - prefix  (always "rsk_live_") — for UI display
 *   - last4   (last 4 chars of the base64url body) — for disambiguation
 *   - hash    (SHA-256(plaintext) as base64url) — for lookup on auth
 *
 * SHA-256 without salt is appropriate here because the secret has ≥256 bits
 * of entropy — preimage and rainbow-table attacks are infeasible.
 */

export const API_KEY_PREFIX = "rsk_live_"

const TOKEN_BODY_PATTERN = /^[A-Za-z0-9_-]+$/

export interface GeneratedApiKey {
  plaintext: string
  prefix: string
  last4: string
  hash: string
}

export async function generateApiKey(): Promise<GeneratedApiKey> {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const body = toBase64Url(bytes)
  const plaintext = `${API_KEY_PREFIX}${body}`
  const hash = await sha256Base64Url(plaintext)
  return { plaintext, prefix: API_KEY_PREFIX, last4: body.slice(-4), hash }
}

export async function hashApiKey(plaintext: string): Promise<string> {
  return sha256Base64Url(plaintext)
}

export function parseAuthorizationHeader(authHeader: string | undefined): string | null {
  if (!authHeader) return null
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!match) return null
  const token = match[1]!
  if (!token.startsWith(API_KEY_PREFIX)) return null
  const body = token.slice(API_KEY_PREFIX.length)
  if (!TOKEN_BODY_PATTERN.test(body)) return null
  return token
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
