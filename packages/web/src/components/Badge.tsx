import type { ReactNode } from "react"

interface BadgeProps {
  children: ReactNode
  className?: string
}

/** Monospace code-style badge used for NT types. */
export function Badge({ children, className = "" }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[11px] font-mono text-secondary bg-surface border border-border ${className}`}
    >
      {children}
    </span>
  )
}

type StatusTone = "active" | "revoked"

interface StatusBadgeProps {
  tone: StatusTone
  children: ReactNode
}

const STATUS_DOT: Record<StatusTone, string> = {
  active: "bg-success",
  revoked: "bg-muted",
}

const STATUS_FG: Record<StatusTone, string> = {
  active: "text-primary",
  revoked: "text-secondary",
}

export function StatusBadge({ tone, children }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] bg-surface ${STATUS_FG[tone]}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[tone]}`} />
      {children}
    </span>
  )
}
