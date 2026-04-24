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

/**
 * Daily-cap breach alert for the operator. Fires on the first breach of a
 * given metric in a UTC day (see `quota/daily-quota.ts` — the alerted_*
 * latch guarantees at most one email per metric per day). Plain text,
 * same template shape as the magic-link email for Gmail deliverability.
 */
export interface OperatorAlert {
  metric: "bytes" | "classA" | "classB"
  cap: number
  counter: number
  dateUtc: string
  retryAfterSeconds: number
  baseUrl: string
}

export async function sendOperatorAlert(
  config: EmailConfig,
  operatorEmail: string,
  alert: OperatorAlert,
): Promise<SendMagicLinkResult> {
  const metricLabel = alert.metric === "bytes" ? "bytes" : `${alert.metric} ops`
  const subject = `RavenScope: daily ${metricLabel} cap hit`
  const resetAt = new Date(Date.now() + alert.retryAfterSeconds * 1000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC")
  const text =
    `The ${metricLabel} cap was reached on ${alert.dateUtc} UTC.\n\n` +
    `  Cap:   ${formatMetric(alert.metric, alert.cap)}\n` +
    `  Used:  ${formatMetric(alert.metric, alert.counter)}\n` +
    `  Reset: ${resetAt}\n\n` +
    `All write paths are returning HTTP 429 until UTC midnight.\n\n` +
    `If this was a legitimate spike, no action needed — the counter\n` +
    `resets automatically. If you suspect abuse, check audit_log for\n` +
    `recent key_use events and revoke any suspicious API keys at\n` +
    `${alert.baseUrl}/keys.\n\n` +
    `— RavenScope\n`

  const body = JSON.stringify({
    from: config.from,
    to: [operatorEmail],
    subject,
    text,
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
      if (res.status >= 400 && res.status < 500) {
        return { ok: false, error: `resend-${res.status}` }
      }
      lastError = `resend-${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? `network-${err.name}` : "network-unknown"
    }
    if (attempt < MAX_ATTEMPTS - 1) {
      await sleep(BASE_BACKOFF_MS * 2 ** attempt)
    }
  }
  return { ok: false, error: lastError }
}

/**
 * Invite-email delivery (U4). Sits alongside `sendMagicLink`; same retry +
 * backoff semantics. Subject mentions both the inviter and the workspace so
 * recipients can recognize the message at a glance. Body calls out the 7-day
 * expiry and an explicit "ignore if unexpected" line.
 */
export interface InviteEmailPayload {
  workspaceName: string
  inviterEmail: string
  acceptLink: string
}

export async function sendInviteEmail(
  config: EmailConfig,
  to: string,
  payload: InviteEmailPayload,
): Promise<SendMagicLinkResult> {
  const subject = `${payload.inviterEmail} invited you to ${payload.workspaceName} on RavenScope`
  const text =
    `${payload.inviterEmail} invited you to join the workspace "${payload.workspaceName}" on RavenScope.\n\n` +
    `Click the link below to accept. It expires in 7 days.\n\n` +
    `${payload.acceptLink}\n\n` +
    `If you didn't expect this invite, you can safely ignore this email.`

  const body = JSON.stringify({
    from: config.from,
    to: [to],
    subject,
    text,
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
      if (res.status >= 400 && res.status < 500) {
        return { ok: false, error: `resend-${res.status}` }
      }
      lastError = `resend-${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? `network-${err.name}` : "network-unknown"
    }
    if (attempt < MAX_ATTEMPTS - 1) {
      await sleep(BASE_BACKOFF_MS * 2 ** attempt)
    }
  }
  return { ok: false, error: lastError }
}

function formatMetric(metric: OperatorAlert["metric"], value: number): string {
  if (metric !== "bytes") return value.toLocaleString("en-US") + " ops"
  const mib = 1024 * 1024
  const gib = 1024 * mib
  if (value >= gib) return `${(value / gib).toFixed(2)} GiB`
  if (value >= mib) return `${(value / mib).toFixed(2)} MiB`
  return `${value.toLocaleString("en-US")} B`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
