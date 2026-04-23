import { useMutation } from "@tanstack/react-query"
import { useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { Button } from "../components/Button"
import { requestMagicLink } from "../lib/api"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function SignIn() {
  const [email, setEmail] = useState("")
  const [error, setError] = useState<string | null>(null)
  const nav = useNavigate()
  const [params] = useSearchParams()

  const submit = useMutation({
    mutationFn: async (addr: string) => {
      const res = await requestMagicLink(addr)
      return res
    },
    onSuccess: (res, addr) => {
      if (res.ok) {
        const next = params.get("next") ?? "/"
        nav(`/check-email?email=${encodeURIComponent(addr)}&next=${encodeURIComponent(next)}`)
        return
      }
      if (res.status === 429) {
        setError("Too many sign-in requests from this address. Please wait a minute and try again.")
      } else {
        setError(`Sign-in request failed (HTTP ${res.status}).`)
      }
    },
    onError: () => {
      setError("Couldn't reach RavenScope. Check your connection and try again.")
    },
  })

  const disabled = submit.isPending || !EMAIL_RE.test(email)

  return (
    <div className="min-h-screen flex items-center justify-center p-20">
      <form
        className="w-[440px] flex flex-col gap-8"
        onSubmit={(e) => {
          e.preventDefault()
          setError(null)
          submit.mutate(email)
        }}
      >
        <div className="flex items-center gap-2.5">
          <span className="w-[18px] h-[18px] bg-accent" aria-hidden />
          <span className="font-display text-[22px] font-semibold text-primary">
            RavenScope
          </span>
        </div>
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-[40px] font-medium leading-tight tracking-[-1px] text-primary">
            Sign in
          </h1>
          <p className="text-secondary text-[14px] leading-relaxed">
            Enter your email and we'll send you a sign-in link.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="email" className="font-display text-[13px] font-medium text-primary">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoFocus
            autoComplete="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              setError(null)
            }}
            placeholder="you@example.com"
            className="px-3.5 py-3 bg-page border border-border text-[14px] text-primary placeholder:text-placeholder focus:outline-none focus:border-primary"
          />
        </div>
        {error && (
          <div className="text-[13px] text-accent border-l-2 border-accent bg-surface px-4 py-3">
            {error}
          </div>
        )}
        <Button type="submit" disabled={disabled} className="w-full">
          {submit.isPending ? "Sending…" : "Send me a sign-in link"}
        </Button>
        <p className="text-muted text-[13px] leading-relaxed">
          No password. We'll email you a link that's valid for 15 minutes.
        </p>
      </form>
    </div>
  )
}
