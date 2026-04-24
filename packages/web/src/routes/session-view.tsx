import { useQuery } from "@tanstack/react-query"
import { ChevronLeft } from "lucide-react"
import { Link, useParams } from "react-router-dom"
import { fetchSessionDetail, sessionViewerUrl } from "../lib/api"

/**
 * Full-bleed embedded AdvantageScope Lite viewer for a single session.
 * Thin RavenScope chrome at the top (Back + session identity), iframe
 * fills the rest of the viewport.
 *
 * iframe sandbox is `allow-scripts allow-same-origin` -- same-origin is
 * required for the session cookie to flow on AS Lite's relative fetches
 * under /v/:id/*. Session cookie is HttpOnly (see
 * packages/worker/src/auth/cookie.ts), so AS Lite's JS cannot read it
 * even with same-origin. allow-downloads is intentionally omitted for
 * v1; AS Lite's export flows are not required.
 */
export function SessionView() {
  const { id = "" } = useParams()
  const detail = useQuery({
    queryKey: ["session", id],
    queryFn: () => fetchSessionDetail(id),
    enabled: !!id,
  })

  const title = detail.data
    ? (detail.data.matchLabel ?? detail.data.sessionId)
    : "…"
  const subtitle = detail.data?.fmsEventName

  return (
    <div className="flex flex-col h-screen w-screen bg-page">
      <header className="flex items-center gap-4 px-6 h-12 border-b border-border flex-shrink-0">
        <Link
          to={`/sessions/${id}`}
          className="flex items-center gap-1.5 text-secondary hover:text-primary text-[13px]"
        >
          <ChevronLeft size={14} />
          Back
        </Link>
        <span className="text-muted">/</span>
        <span className="text-primary font-medium text-[13px] truncate">
          {title}
          {subtitle && (
            <span className="text-secondary font-normal"> — {subtitle}</span>
          )}
        </span>
      </header>
      <iframe
        title="AdvantageScope viewer"
        src={sessionViewerUrl(id)}
        sandbox="allow-scripts allow-same-origin"
        className="flex-1 w-full border-0"
      />
    </div>
  )
}
