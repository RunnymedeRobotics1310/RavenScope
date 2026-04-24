/**
 * Embedded AdvantageScope Lite viewer route group, mounted at /v.
 *
 * Every path under /v/:id/* is session-scoped: the authenticated user
 * must own :id (workspace match) or every endpoint returns 404
 * not_found, matching the policy of /api/sessions/:id/wpilog byte-for-
 * byte (plan R5).
 *
 * Four dynamic paths speak AdvantageScope Lite's minimal HTTP contract:
 *   GET /:id/logs                  -> [{name, size}] listing of one file
 *   GET /:id/logs/:name{.*}        -> stream the session's single wpilog
 *   GET /:id/assets                -> asset manifest JSON
 *   GET /:id/assets/:path{.*}      -> asset file bytes
 *
 * Everything else under /:id/* is proxied from Workers Static Assets
 * under /advantagescope/<rest>, with a content-type sanity check to
 * defeat the SPA-fallback-returning-index.html trap that wrangler's
 * not_found_handling = "single-page-application" enables.
 */
import { Hono } from "hono"
import { requireCookieUser } from "../auth/require-cookie-user"
import { loadOwnedSession } from "../auth/session-owner"
import type { Env } from "../env"
import { chargeOrThrow, QuotaExceededError } from "../quota/daily-quota"
import { handleQuotaExceeded } from "../quota/http"
import { getOrBuildWpilog } from "../wpilog/get-or-build"
import type { Context } from "hono"

const STATIC_PREFIX = "/advantagescope"

export const advantagescopeRoutes = new Hono<{ Bindings: Env }>()
advantagescopeRoutes.use("*", requireCookieUser)

/* ---------- root-of-iframe: serve index.html ------------------------- */

advantagescopeRoutes.get("/:id", async (c) => {
  const session = await loadOwnedSession(c, c.req.param("id"))
  if (!session) return c.json({ error: "not_found" }, 404)
  return proxyStatic(c, "index.html", { allowHtml: true })
})

/* ---------- /logs listing (one-entry, ignores folder) --------------- */

advantagescopeRoutes.get("/:id/logs", async (c) => {
  const session = await loadOwnedSession(c, c.req.param("id"))
  if (!session) return c.json({ error: "not_found" }, 404)

  // When the cache is populated, report its on-disk (compressed) size
  // so Lite's download-popup UI shows something plausible. When not
  // populated, report 0 -- the URL-param auto-open path (iframe src
  // /v/:id/?log=<sessionId>.wpilog) bypasses this listing entirely, so
  // this endpoint is only hit if the user opens File -> Download Logs
  // manually inside Lite. Triggering a full wpilog build here just to
  // display an accurate size would make that menu open slow.
  let size = 0
  if (session.wpilogKey) {
    try {
      await chargeOrThrow(c.env, { classB: 1 })
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        return handleQuotaExceeded(c, err, session.workspaceId)
      }
      throw err
    }
    const head = await c.env.BLOBS.head(session.wpilogKey)
    size = head?.size ?? 0
  }
  return c.json([{ name: `${session.sessionId}.wpilog`, size }])
})

/* ---------- /logs/<name> stream (ignores name + folder) ------------- */

advantagescopeRoutes.get("/:id/logs/:name{.+}", async (c) => {
  const session = await loadOwnedSession(c, c.req.param("id"))
  if (!session) return c.json({ error: "not_found" }, 404)

  const result = await getOrBuildWpilog(c, session)
  if (!result.ok) return result.response
  return new Response(result.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  })
})

/* ---------- /assets (manifest) -------------------------------------- */

advantagescopeRoutes.get("/:id/assets", async (c) => {
  const session = await loadOwnedSession(c, c.req.param("id"))
  if (!session) return c.json({ error: "not_found" }, 404)
  return proxyStatic(c, "assets-manifest.json")
})

/* ---------- /assets/<path> (single asset file) ---------------------- */

advantagescopeRoutes.get("/:id/assets/:path{.+}", async (c) => {
  const session = await loadOwnedSession(c, c.req.param("id"))
  if (!session) return c.json({ error: "not_found" }, 404)
  const subPath = c.req.param("path")
  return proxyStatic(c, `bundledAssets/${subPath}`)
})

/* ---------- static catch-all ---------------------------------------- */

advantagescopeRoutes.get("/:id/*", async (c) => {
  const session = await loadOwnedSession(c, c.req.param("id"))
  if (!session) return c.json({ error: "not_found" }, 404)
  // Strip the /v/:id/ prefix from the URL to get the sub-path under
  // AS Lite's static tree.
  const url = new URL(c.req.url)
  const prefix = `/v/${c.req.param("id")}/`
  if (!url.pathname.startsWith(prefix)) return c.json({ error: "not_found" }, 404)
  const subPath = url.pathname.slice(prefix.length)
  return proxyStatic(c, subPath)
})

/* ---------- helpers ------------------------------------------------- */

/**
 * Proxy a request to the Workers Static Assets bundle under
 * /advantagescope/<staticPath>. Guards against:
 *   (1) path traversal (rejects any path containing ".." or starting
 *       with "/"),
 *   (2) SPA fallback (wrangler's not_found_handling =
 *       "single-page-application" makes env.ASSETS.fetch return the
 *       RavenScope SPA index.html with HTTP 200 for missing paths --
 *       we return 404 when the response content-type doesn't match
 *       what was requested).
 */
async function proxyStatic(
  c: Context<{ Bindings: Env }>,
  staticPath: string,
  opts: { allowHtml?: boolean } = {},
): Promise<Response> {
  if (staticPath.includes("..") || staticPath.startsWith("/")) {
    return c.json({ error: "not_found" }, 404)
  }
  const fullPath = `${STATIC_PREFIX}/${staticPath}`
  const origin = new URL(c.req.url).origin
  const rewritten = new URL(fullPath, origin)
  const res = await c.env.ASSETS.fetch(new Request(rewritten.toString(), { method: "GET" }))
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase()

  // SPA fallback returns text/html for any missing file. Reject unless
  // this particular request actually expected HTML (only the iframe
  // root passes allowHtml).
  if (!opts.allowHtml && contentType.startsWith("text/html")) {
    return c.json({ error: "not_found" }, 404)
  }

  const expected = expectedTypeFromExt(staticPath)
  if (expected && !contentType.startsWith(expected)) {
    return c.json({ error: "not_found" }, 404)
  }
  return res
}

/** Expected Content-Type prefix for a given file extension. Null means
 *  "don't check" (extensionless paths or unknown extensions). */
function expectedTypeFromExt(path: string): string | null {
  const ext = path.toLowerCase().split("/").pop()?.split(".").slice(-1)[0] ?? ""
  switch (ext) {
    case "js":
    case "mjs":
      return "application/javascript"
    case "css":
      return "text/css"
    case "json":
      return "application/json"
    case "html":
    case "htm":
      return "text/html"
    case "png":
      return "image/png"
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "gif":
      return "image/gif"
    case "svg":
      return "image/svg+xml"
    case "ico":
      return "image/"
    case "glb":
      return "model/gltf-binary"
    case "gltf":
      return "model/gltf+json"
    case "wasm":
      return "application/wasm"
    case "woff":
      return "font/woff"
    case "woff2":
      return "font/woff2"
    case "ttf":
      return "font/ttf"
    case "txt":
      return "text/plain"
    default:
      return null
  }
}
