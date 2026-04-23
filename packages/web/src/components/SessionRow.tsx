import { ChevronRight } from "lucide-react"
import { Link } from "react-router-dom"
import type { SessionListItem } from "../lib/api"

interface SessionRowProps {
  session: SessionListItem
}

export function SessionRow({ session }: SessionRowProps) {
  const started = new Date(session.startedAt)
  const ended = session.endedAt ? new Date(session.endedAt) : null
  const durationMs = ended ? ended.getTime() - started.getTime() : 0
  return (
    <Link
      to={`/sessions/${session.id}`}
      className="flex items-center gap-6 px-5 py-[18px] border-b border-border hover:bg-surface/50 transition-colors text-[14px]"
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
      <ChevronRight size={14} className="text-muted w-8" />
    </Link>
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
