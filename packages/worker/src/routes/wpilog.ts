import { Hono } from "hono"
import { requireCookieUser } from "../auth/require-cookie-user"
import { loadOwnedSession } from "../auth/session-owner"
import type { Env } from "../env"
import { getOrBuildWpilog } from "../wpilog/get-or-build"

export const wpilogRoutes = new Hono<{ Bindings: Env }>()
wpilogRoutes.use("*", requireCookieUser)

wpilogRoutes.get("/:id/wpilog", async (c) => {
  const id = c.req.param("id")
  const session = await loadOwnedSession(c, id)
  if (!session) return c.json({ error: "not_found" }, 404)

  const result = await getOrBuildWpilog(c, session)
  if (!result.ok) return result.response
  return streamWpilogDownload(result.body, session.sessionId)
})

/**
 * Stream a plain (uncompressed) WPILog body to the client as an
 * attachment download. readPlainBlobStream pipes through
 * DecompressionStream when the stored object is gzipped. No
 * Content-Encoding header on the response: clients (browsers, curl,
 * wget, AdvantageScope) always see standard uncompressed WPILog bytes.
 */
function streamWpilogDownload(
  body: ReadableStream<Uint8Array>,
  sessionId: string,
): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${sessionId}.wpilog"`,
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  })
}
