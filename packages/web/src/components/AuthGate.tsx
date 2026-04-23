import { Navigate, Outlet, useLocation } from "react-router-dom"
import { useMe } from "../lib/auth"

export function AuthGate() {
  const me = useMe()
  const location = useLocation()

  if (me.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-secondary font-display">
        Loading…
      </div>
    )
  }
  if (!me.data) {
    const redirect = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/sign-in?next=${redirect}`} replace />
  }
  return <Outlet />
}
