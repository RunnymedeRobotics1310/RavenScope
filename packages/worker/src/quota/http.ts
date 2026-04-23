import type { QuotaExceededError } from "./daily-quota"

/**
 * 429 Too Many Requests with Retry-After + a plain-text body naming the
 * cap that was hit. Used by every route that catches QuotaExceededError
 * from the storage wrappers.
 */
export function cappedResponse(err: QuotaExceededError): Response {
  return new Response(`quota_cap_hit: ${err.metric}`, {
    status: 429,
    headers: {
      "Retry-After": String(err.retryAfter),
      "Content-Type": "text/plain; charset=utf-8",
    },
  })
}
