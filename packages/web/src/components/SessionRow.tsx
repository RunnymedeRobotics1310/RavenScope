import { Download, Trash2 } from "lucide-react"
import { Link } from "react-router-dom"
import type { SessionListItem } from "../lib/api"
import { sessionDownloadUrl } from "../lib/api"
import { Tooltip } from "./Tooltip"

interface SessionRowProps {
  session: SessionListItem
  onRequestDelete: (session: SessionListItem) => void
}

export function SessionRow({ session, onRequestDelete }: SessionRowProps) {
  const started = new Date(session.startedAt)
  const ended = session.endedAt ? new Date(session.endedAt) : null
  const durationMs = ended ? ended.getTime() - started.getTime() : 0
  return (
    <div className="flex items-center gap-6 pl-5 pr-3 py-[18px] border-b border-border hover:bg-surface/50 transition-colors text-[14px]">
      {/* Clickable region → session detail. Sibling to the actions cell so
          the buttons aren't nested inside an anchor (invalid HTML + event
          bubbling footguns). */}
      <Link
        to={`/sessions/${session.id}`}
        className="flex flex-1 items-center gap-6 min-w-0 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <div className="flex-1 min-w-0">
          <div className="font-medium text-primary truncate">
            {session.fmsEventName ? (
              session.fmsEventName
            ) : (
              <span className="font-mono">{session.sessionId}</span>
            )}
          </div>
          <div className="text-[12px] text-muted mt-0.5">
            Team {session.teamNumber} · {fmtShortDate(started)}
          </div>
        </div>
        <div className="w-40 font-mono text-[13px] text-primary shrink-0">
          {session.matchLabel ?? "—"}
        </div>
        <div className="w-56 shrink-0">
          <div className="text-[13px] text-primary">{fmtDateTime(started)}</div>
          <div className="text-[12px] text-muted">{fmtAgo(started)}</div>
        </div>
        <div className="w-32 font-mono text-[13px] text-primary shrink-0">
          {durationMs > 0 ? fmtDuration(durationMs) : "—"}
        </div>
        <div className="w-32 flex justify-end font-mono text-[13px] text-primary shrink-0">
          {session.entryCount.toLocaleString()}
        </div>
      </Link>
      <div className="w-24 flex justify-end items-center gap-1 shrink-0">
        <Tooltip label="Download .wpilog">
          <a
            href={sessionDownloadUrl(session.id)}
            download
            className="p-2 text-secondary hover:text-primary hover:bg-surface transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            aria-label="Download .wpilog"
          >
            <Download size={16} />
          </a>
        </Tooltip>
        <Tooltip label="Delete session">
          <button
            onClick={() => onRequestDelete(session)}
            className="p-2 text-secondary hover:text-accent hover:bg-surface transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            aria-label="Delete session"
          >
            <Trash2 size={16} />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

function fmtShortDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

function fmtDateTime(d: Date): string {
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function fmtAgo(d: Date): string {
  const ms = Date.now() - d.getTime()
  if (ms < 0) return "just now"
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? "" : "s"} ago`
}

function fmtDuration(ms: number): string {
  const total = ms / 1000
  const mins = Math.floor(total / 60)
  const secs = Math.round(total - mins * 60)
  return `${mins}m ${secs}s`
}
