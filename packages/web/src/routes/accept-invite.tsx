import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Button } from "../components/Button"
import { acceptInvite, logout } from "../lib/api"

type Phase = "pending" | "error"

interface ErrorCopy {
  heading: string
  body: string
  action?: "sign-out" | "home"
}

const ERROR_COPY: Record<string, ErrorCopy> = {
  token_expired: {
    heading: "This invite has expired",
    body: "Ask the workspace owner for a fresh one.",
  },
  token_revoked: {
    heading: "This invite was revoked",
    body: "Ask the workspace owner to send a new one.",
  },
  token_accepted: {
    heading: "This invite was already used",
    body: "If you weren't the one who accepted it, ask the workspace owner for a new invite.",
  },
  token_unknown: {
    heading: "This invite link is invalid",
    body: "Double-check the link or ask for a new invite.",
  },
  token_malformed: {
    heading: "This invite link is invalid",
    body: "Double-check the link or ask for a new invite.",
  },
  email_mismatch: {
    heading: "Wrong account signed in",
    body: "This invite was sent to a different email. Sign out and try again.",
    action: "sign-out",
  },
  already_member: {
    heading: "You're already a member of this workspace",
    body: "No action needed.",
    action: "home",
  },
  missing_token: {
    heading: "Missing token",
    body: "This link is incomplete. Ask the workspace owner for a new invite.",
  },
}

function copyFor(tag: string): ErrorCopy {
  return (
    ERROR_COPY[tag] ?? {
      heading: "Something went wrong",
      body: "Try again in a moment.",
    }
  )
}

export function AcceptInvite() {
  const [params] = useSearchParams()
  const token = params.get("token")
  const [phase, setPhase] = useState<Phase>("pending")
  const [errorTag, setErrorTag] = useState<string>("")

  useEffect(() => {
    let cancelled = false
    if (!token) {
      setErrorTag("missing_token")
      setPhase("error")
      return
    }
    acceptInvite(token)
      .then(() => {
        if (cancelled) return
        // Server may respond 2xx (follow-redirect browser behavior) — land home.
        window.location.assign("/")
      })
      .catch((err: Error) => {
        if (cancelled) return
        setErrorTag(err.message || "unknown")
        setPhase("error")
      })
    return () => {
      cancelled = true
    }
  }, [token])

  if (phase === "pending") {
    return (
      <div className="min-h-screen flex items-center justify-center text-secondary font-display">
        Accepting invite…
      </div>
    )
  }

  const copy = copyFor(errorTag)
  return (
    <div className="min-h-screen flex items-center justify-center p-20">
      <div className="w-[440px] flex flex-col gap-6">
        <div className="flex items-center gap-2.5">
          <span className="w-[18px] h-[18px] bg-accent" aria-hidden />
          <span className="font-display text-[22px] font-semibold text-primary">
            RavenScope
          </span>
        </div>
        <div className="flex flex-col gap-3">
          <h1 className="font-display text-[32px] font-medium leading-tight tracking-[-0.5px] text-primary">
            {copy.heading}
          </h1>
          <p className="text-secondary text-[14px] leading-relaxed">
            {copy.body}
          </p>
        </div>
        {copy.action === "sign-out" && (
          <Button
            variant="primary"
            onClick={async () => {
              await logout()
              window.location.assign(window.location.href)
            }}
          >
            Sign out and try again
          </Button>
        )}
        {copy.action === "home" && (
          <Link
            to="/"
            className="text-[13px] text-accent font-display font-medium hover:opacity-80"
          >
            Go to your workspace →
          </Link>
        )}
      </div>
    </div>
  )
}
