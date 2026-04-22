/**
 * Per-key rate limiter backed by a Durable Object. See plan Unit 3.
 *
 * Limits enforced on /api/auth/request-link:
 *   - per-IP: 5 requests / 60s
 *   - per-email: 3 requests / 600s
 *
 * The per-email cap specifically exists to prevent a malicious actor from
 * exhausting Resend's 3000/month quota by spamming request-link with
 * fabricated addresses.
 */

import type { Env } from "../env"

export interface RateLimitResult {
  ok: boolean
  /** Seconds until the caller can try again (0 when ok). */
  retryAfter: number
}

export interface RateLimitRule {
  key: string
  limit: number
  windowSeconds: number
}

export async function checkRateLimit(
  env: Env,
  rule: RateLimitRule,
): Promise<RateLimitResult> {
  const id = env.RATE_LIMIT_DO.idFromName(rule.key)
  const stub = env.RATE_LIMIT_DO.get(id)
  const res = await stub.fetch("https://rate-limit/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: rule.limit, windowSeconds: rule.windowSeconds }),
  })
  return (await res.json()) as RateLimitResult
}

/**
 * Sliding-window limiter. Each DO instance tracks the timestamps of recent
 * hits and returns ok=false with the delay until the oldest hit falls out
 * of the window.
 */
export class RateLimitDO implements DurableObject {
  private hits: number[] = []

  constructor(
    private readonly state: DurableObjectState,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    env: Env,
  ) {
    state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<number[]>("hits")
      this.hits = stored ?? []
    })
  }

  async fetch(request: Request): Promise<Response> {
    const { limit, windowSeconds } = (await request.json()) as {
      limit: number
      windowSeconds: number
    }
    const now = Date.now()
    const windowStart = now - windowSeconds * 1000

    // Drop anything outside the window.
    this.hits = this.hits.filter((t) => t > windowStart)

    if (this.hits.length >= limit) {
      const oldest = this.hits[0]!
      const retryAfter = Math.ceil((oldest + windowSeconds * 1000 - now) / 1000)
      return Response.json({ ok: false, retryAfter: Math.max(retryAfter, 1) })
    }

    this.hits.push(now)
    await this.state.storage.put("hits", this.hits)
    return Response.json({ ok: true, retryAfter: 0 })
  }
}
