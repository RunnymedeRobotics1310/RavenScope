/**
 * Signed, versioned session cookies. See plan Unit 3 → Session cookie.
 *
 * SESSION_SECRET is a JSON map `{"v1": "<base64>", "v2": "..."}`. Each entry
 * is a 32-byte base64 HMAC-SHA256 key. The newest key (by string compare on
 * the kid) is the "current" key used for signing. Verification tries the
 * cookie's named key; on success with a non-current kid, callers should
 * re-sign with the current key.
 *
 * Cookie wire format: base64url(payload_json) + "." + base64url(hmac_sig).
 */

export interface SessionPayload {
  uid: string
  wsid: string
  kid: string
  /** Absolute expiry as unix-ms. */
  exp: number
}

export interface KeySet {
  /** All keys, mapped by kid. */
  keys: Record<string, CryptoKey>
  /** Newest kid (the one we sign new cookies with). */
  currentKid: string
}

function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ""
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!)
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4)
  const raw = atob(padded)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function importHmacKey(base64Secret: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64Secret), (c) => c.charCodeAt(0))
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )
}

export async function loadKeySet(sessionSecretJson: string): Promise<KeySet> {
  const parsed = JSON.parse(sessionSecretJson) as Record<string, string>
  const kids = Object.keys(parsed)
  if (kids.length === 0) throw new Error("SESSION_SECRET is empty")
  const keys: Record<string, CryptoKey> = {}
  for (const kid of kids) keys[kid] = await importHmacKey(parsed[kid]!)
  // "current" kid: highest by locale-compare. v2 > v1, v10 > v9 only if caller
  // pads; projects with many rotations should use v01, v02, ... — we document
  // this in README during Unit 10.
  const currentKid = kids.sort().at(-1)!
  return { keys, currentKid }
}

export async function signSession(
  payload: Omit<SessionPayload, "kid">,
  keyset: KeySet,
): Promise<string> {
  const full: SessionPayload = { ...payload, kid: keyset.currentKid }
  const payloadBytes = new TextEncoder().encode(JSON.stringify(full))
  const sig = await crypto.subtle.sign("HMAC", keyset.keys[keyset.currentKid]!, payloadBytes)
  return `${b64urlEncode(payloadBytes)}.${b64urlEncode(sig)}`
}

export type VerifyResult =
  | { ok: true; payload: SessionPayload; reSignNeeded: boolean }
  | { ok: false; reason: "unknown-kid" | "bad-signature" | "expired" | "malformed" }

export async function verifySession(
  cookie: string,
  keyset: KeySet,
  now: number = Date.now(),
): Promise<VerifyResult> {
  const parts = cookie.split(".")
  if (parts.length !== 2) return { ok: false, reason: "malformed" }
  const [payloadB64, sigB64] = parts as [string, string]

  let payload: SessionPayload
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))) as SessionPayload
  } catch {
    return { ok: false, reason: "malformed" }
  }
  if (
    typeof payload.uid !== "string" ||
    typeof payload.wsid !== "string" ||
    typeof payload.kid !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" }
  }

  const key = keyset.keys[payload.kid]
  if (!key) return { ok: false, reason: "unknown-kid" }

  const sigBytes = b64urlDecode(sigB64)
  const payloadBytes = b64urlDecode(payloadB64)
  const verified = await crypto.subtle.verify("HMAC", key, sigBytes, payloadBytes)
  if (!verified) return { ok: false, reason: "bad-signature" }

  if (payload.exp < now) return { ok: false, reason: "expired" }

  return { ok: true, payload, reSignNeeded: payload.kid !== keyset.currentKid }
}

export interface SerializeCookieOpts {
  maxAgeSeconds?: number
  path?: string
  domain?: string
  /** Defaults to true — cookies are HTTPS-only in production. */
  secure?: boolean
  httpOnly?: boolean
  sameSite?: "Strict" | "Lax" | "None"
}

export function serializeCookie(
  name: string,
  value: string,
  opts: SerializeCookieOpts = {},
): string {
  const {
    maxAgeSeconds,
    path = "/",
    domain,
    secure = true,
    httpOnly = true,
    sameSite = "Lax",
  } = opts
  const parts = [`${name}=${value}`, `Path=${path}`, `SameSite=${sameSite}`]
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`)
  if (domain) parts.push(`Domain=${domain}`)
  if (secure) parts.push("Secure")
  if (httpOnly) parts.push("HttpOnly")
  return parts.join("; ")
}

export const SESSION_COOKIE_NAME = "rs_session"
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days
