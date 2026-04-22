import type { MiddlewareHandler } from "hono"

/**
 * Rejects non-HTTPS requests with 400. localhost / 127.0.0.1 / *.local are
 * exempt so `wrangler dev` and the Vite proxy keep working.
 */
export const httpsOnly: MiddlewareHandler = async (c, next) => {
  const url = new URL(c.req.url)
  if (url.protocol === "https:" || isLocalHost(url.hostname)) {
    return next()
  }
  return c.text("HTTPS required", 400)
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".localhost")
  )
}
