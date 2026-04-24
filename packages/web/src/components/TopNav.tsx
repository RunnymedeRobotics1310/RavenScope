import * as Dialog from "@radix-ui/react-dialog"
import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Check, ChevronDown, X } from "lucide-react"
import { useState } from "react"
import { Link, NavLink } from "react-router-dom"
import { logout, switchWorkspace, type WorkspaceInfo } from "../lib/api"
import { useMe } from "../lib/auth"
import { Button } from "./Button"

export function TopNav() {
  const me = useMe()
  const qc = useQueryClient()
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      qc.setQueryData(["me"], null)
      window.location.href = "/sign-in"
    },
  })

  const switchMut = useMutation({
    mutationFn: (workspaceId: string) => switchWorkspace(workspaceId),
    onSuccess: () => {
      // Hard navigation: resets all route-local state (modals, filters,
      // drafts) which all assumed the prior workspace. A cross-tenancy
      // swap while retaining React state is a footgun. See plan U7.
      window.location.assign("/")
    },
  })

  const activeRole = me.data?.activeWorkspace.role
  const showApiKeys = activeRole === "owner"

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
          {showApiKeys && <NavTab to="/keys" label="API Keys" />}
        </nav>
      </div>
      {me.data && (
        <div className="flex items-center gap-4">
          <WorkspaceSwitcher
            activeWorkspace={me.data.activeWorkspace}
            workspaces={me.data.workspaces}
            onSwitch={(id) => switchMut.mutate(id)}
          />
          <button
            onClick={() => setConfirmSignOut(true)}
            className="w-8 h-8 bg-accent text-accent-fg font-display font-semibold text-[13px]"
            title={`Sign out (${me.data.email})`}
          >
            {me.data.email.charAt(0).toUpperCase()}
          </button>
        </div>
      )}

      <Dialog.Root open={confirmSignOut} onOpenChange={setConfirmSignOut}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50" />
          <Dialog.Content className="fixed top-[28%] left-1/2 -translate-x-1/2 w-[420px] max-w-[92vw] bg-page border border-border">
            <div className="flex items-start justify-between px-7 py-5 border-b border-border">
              <Dialog.Title className="font-display text-[18px] font-semibold text-primary">
                Sign out?
              </Dialog.Title>
              <Dialog.Close asChild>
                <button className="text-muted hover:text-primary" aria-label="Close">
                  <X size={18} />
                </button>
              </Dialog.Close>
            </div>
            <div className="px-7 py-5 text-[14px] text-secondary leading-relaxed">
              You'll be returned to the sign-in page. Session state and any
              unsaved UI state on this page will be cleared.
              {me.data?.email && (
                <div className="mt-3 bg-surface border border-border px-3 py-2 text-[13px] font-mono text-primary">
                  {me.data.email}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-3 px-7 py-4 border-t border-border">
              <Dialog.Close asChild>
                <Button variant="secondary" type="button">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button
                variant="primary"
                onClick={() => signOut.mutate()}
                disabled={signOut.isPending}
              >
                {signOut.isPending ? "Signing out…" : "Sign out"}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </header>
  )
}

function WorkspaceSwitcher({
  activeWorkspace,
  workspaces,
  onSwitch,
}: {
  activeWorkspace: WorkspaceInfo
  workspaces: WorkspaceInfo[]
  onSwitch: (workspaceId: string) => void
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 px-3 py-1.5 border border-border hover:bg-surface transition-colors"
          aria-label="Switch workspace"
        >
          <span className="w-2 h-2 rounded-full bg-success" />
          <span className="text-[13px] text-primary">{activeWorkspace.name}</span>
          <ChevronDown className="w-3.5 h-3.5 text-secondary" aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-[220px] bg-surface border border-border shadow-lg py-1"
        >
          {workspaces.map((ws) => {
            const isActive = ws.id === activeWorkspace.id
            return (
              <DropdownMenu.Item
                key={ws.id}
                disabled={isActive}
                onSelect={(e) => {
                  if (isActive) {
                    e.preventDefault()
                    return
                  }
                  onSwitch(ws.id)
                }}
                className={`flex items-center gap-2 px-3 py-2 text-[13px] outline-none cursor-pointer data-[highlighted]:bg-page ${
                  isActive ? "text-primary" : "text-secondary hover:text-primary"
                }`}
              >
                <span className="w-4 flex items-center justify-center" aria-hidden>
                  {isActive ? (
                    <Check className="w-3.5 h-3.5 text-accent" />
                  ) : null}
                </span>
                <span className="flex-1 text-primary">{ws.name}</span>
                <span className="inline-flex items-center px-1.5 py-0.5 text-[11px] font-mono text-secondary bg-page border border-border">
                  {ws.role === "owner" ? "Owner" : "Member"}
                </span>
              </DropdownMenu.Item>
            )
          })}
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item asChild>
            <Link
              to="/workspace/settings"
              className="flex items-center px-3 py-2 text-[13px] text-secondary hover:text-primary outline-none data-[highlighted]:bg-page"
            >
              Workspace settings
            </Link>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
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
