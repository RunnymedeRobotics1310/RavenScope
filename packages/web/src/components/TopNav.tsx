import { Link, NavLink } from "react-router-dom"
import { useMe } from "../lib/auth"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { logout } from "../lib/api"

export function TopNav() {
  const me = useMe()
  const qc = useQueryClient()
  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      qc.setQueryData(["me"], null)
      window.location.href = "/sign-in"
    },
  })

  return (
    <header className="sticky top-0 z-10 flex items-center justify-between h-16 px-8 bg-page border-b">
      <div className="flex items-center gap-10">
        <Link to="/" className="flex items-center gap-2">
          <span className="w-3.5 h-3.5 bg-accent" aria-hidden />
          <span className="font-display text-[18px] font-semibold text-primary">
            RavenScope
          </span>
        </Link>
        <nav className="flex items-center h-16">
          <NavTab to="/" label="Sessions" />
          <NavTab to="/keys" label="API Keys" />
        </nav>
      </div>
      {me.data && (
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 px-3 py-1.5 border border-border">
            <span className="w-2 h-2 rounded-full bg-success" />
            <span className="text-[13px] text-primary">{me.data.workspaceName}</span>
          </div>
          <button
            onClick={() => signOut.mutate()}
            className="w-8 h-8 bg-accent text-accent-fg font-display font-semibold text-[13px]"
            title={`Sign out (${me.data.email})`}
          >
            {me.data.email.charAt(0).toUpperCase()}
          </button>
        </div>
      )}
    </header>
  )
}

function NavTab({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        `font-display text-[14px] px-4 h-16 flex items-center border-b-2 transition-colors ${
          isActive
            ? "text-primary font-medium border-accent"
            : "text-secondary border-transparent hover:text-primary"
        }`
      }
    >
      {label}
    </NavLink>
  )
}
