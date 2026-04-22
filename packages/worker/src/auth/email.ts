/**
 * Resend client for magic-link delivery. See plan Unit 3 → Email template.
 * On transient failures (5xx, network errors) we retry with exponential
 * backoff up to 3 attempts. On ultimate failure the caller logs
 * `magic_link_requested` with `metadata_json = {email_send_failed: true}`.
 */

export interface SendMagicLinkResult {
  ok: boolean
  /** Only present when ok=false — a short reason tag for audit logging. */
  error?: string
}

export interface EmailConfig {
  apiKey: string
  from: string
}

const RESEND_URL = "https://api.resend.com/emails"
const MAX_ATTEMPTS = 3
const BASE_BACKOFF_MS = 200

export async function sendMagicLink(
  config: EmailConfig,
  to: string,
  link: string,
): Promise<SendMagicLinkResult> {
  const body = JSON.stringify({
    from: config.from,
    to: [to],
    subject: "Your RavenScope sign-in link",
    text:
      `Click the link below to sign in to RavenScope. It expires in 15 minutes.\n\n` +
      `${link}\n\n` +
      `If you didn't request this, you can safely ignore this email.`,
  })

  let lastError = "unknown"
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(RESEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      })
      if (res.ok) return { ok: true }

      // 4xx is not retryable (bad API key, bad from address, etc.).
      if (res.status >= 400 && res.status < 500) {
        return { ok: false, error: `resend-${res.status}` }
      }
      lastError = `resend-${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? `network-${err.name}` : "network-unknown"
    }

    // Exponential backoff: 200ms, 400ms.
    if (attempt < MAX_ATTEMPTS - 1) {
      await sleep(BASE_BACKOFF_MS * 2 ** attempt)
    }
  }
  return { ok: false, error: lastError }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
