import * as Dialog from "@radix-ui/react-dialog"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import { useMemo, useState, type ReactNode } from "react"
import { Button } from "../components/Button"
import { EditableText } from "../components/EditableText"
import { TopNav } from "../components/TopNav"
import { Tooltip } from "../components/Tooltip"
import { useMe } from "../lib/auth"
import {
  deleteWorkspace,
  leaveWorkspace,
  listInvites,
  listMembers,
  removeMember,
  resendInvite,
  revokeInvite,
  sendInvite,
  transferOwnership,
  updateWorkspace,
  type InviteDto,
  type MemberDto,
} from "../lib/api"

const INVITE_ERROR_COPY: Record<string, string> = {
  invite_pending: "An invite is already pending for that email.",
  already_member: "That email is already a member of this workspace.",
  invalid_email: "That isn't a valid email address.",
  http_429: "Too many invites from this workspace today. Try again later.",
  http_400: "We couldn't send that invite. Double-check the email.",
  http_403: "You don't have permission to send invites.",
}

export function WorkspaceSettings() {
  const me = useMe()
  const qc = useQueryClient()
  if (!me.data) {
    // AuthGate handles unauthenticated callers; this is belt-and-suspenders.
    return null
  }
  const active = me.data.activeWorkspace
  const isOwner = active.role === "owner"

  const renameWorkspace = useMutation({
    mutationFn: (next: string | null) => {
      if (next === null) throw new Error("Workspace name can't be empty")
      return updateWorkspace(active.id, { name: next })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] })
    },
  })

  return (
    <div className="min-h-screen bg-page">
      <TopNav />
      <main className="px-12 py-10 flex flex-col gap-10">
        <header className="flex flex-col gap-1.5 max-w-3xl">
          <p className="text-secondary text-[13px] font-display font-medium uppercase tracking-[0.08em]">
            Workspace settings
          </p>
          {isOwner ? (
            <h1 className="font-display text-[40px] font-medium leading-tight tracking-[-1px] text-primary">
              <EditableText
                value={active.name}
                placeholder="Workspace name"
                onCommit={async (next) => {
                  await renameWorkspace.mutateAsync(next)
                }}
                maxLength={80}
                className="text-[40px] font-display font-medium tracking-[-1px]"
                ariaLabel="Edit workspace name"
              />
            </h1>
          ) : (
            <h1 className="font-display text-[40px] font-medium leading-tight tracking-[-1px] text-primary">
              {active.name}
            </h1>
          )}
        </header>

        {isOwner ? (
          <OwnerView
            workspaceId={active.id}
            workspaceName={active.name}
            currentUserId={me.data.userId}
          />
        ) : (
          <MemberView workspaceId={active.id} />
        )}
      </main>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Member view                                                        */
/* ------------------------------------------------------------------ */

function MemberView({ workspaceId }: { workspaceId: string }) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const leave = useMutation({
    mutationFn: () => leaveWorkspace(workspaceId),
    onSuccess: () => {
      window.location.assign("/")
    },
  })
  return (
    <section className="flex flex-col gap-4 max-w-2xl">
      <h2 className="font-display text-[20px] font-medium text-primary">
        Leave workspace
      </h2>
      <p className="text-secondary text-[13px] leading-relaxed">
        You'll lose access to this workspace's sessions. The owner can invite
        you again later.
      </p>
      <div>
        <button
          onClick={() => setConfirmOpen(true)}
          className="text-accent hover:opacity-80 font-display font-medium text-[13px]"
        >
          Leave workspace
        </button>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Leave workspace?"
        description="You'll lose access immediately. You can be re-invited later."
        confirmLabel="Leave"
        onConfirm={() => leave.mutate()}
        pending={leave.isPending}
      />
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  Owner view                                                         */
/* ------------------------------------------------------------------ */

function OwnerView({
  workspaceId,
  workspaceName,
  currentUserId,
}: {
  workspaceId: string
  workspaceName: string
  currentUserId: string
}) {
  return (
    <>
      <MembersSection
        workspaceId={workspaceId}
        currentUserId={currentUserId}
      />
      <InvitesSection workspaceId={workspaceId} />
      <DangerZone workspaceId={workspaceId} workspaceName={workspaceName} />
    </>
  )
}

/* -- Members ------------------------------------------------------- */

function MembersSection({
  workspaceId,
  currentUserId,
}: {
  workspaceId: string
  currentUserId: string
}) {
  const qc = useQueryClient()
  const list = useQuery({
    queryKey: ["members", workspaceId],
    queryFn: () => listMembers(workspaceId),
  })

  const ownerCount = useMemo(
    () => list.data?.filter((m) => m.role === "owner").length ?? 0,
    [list.data],
  )

  const [confirm, setConfirm] = useState<{
    kind: "remove" | "transfer" | "leave"
    member: MemberDto
  } | null>(null)

  const remove = useMutation({
    mutationFn: (userId: string) => removeMember(workspaceId, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["members", workspaceId] })
      setConfirm(null)
    },
  })
  const transfer = useMutation({
    mutationFn: (userId: string) => transferOwnership(workspaceId, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["members", workspaceId] })
      qc.invalidateQueries({ queryKey: ["me"] })
      setConfirm(null)
    },
  })
  const leave = useMutation({
    mutationFn: () => leaveWorkspace(workspaceId),
    onSuccess: () => {
      window.location.assign("/")
    },
  })

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-[20px] font-medium text-primary">
        Members
      </h2>
      <div className="border border-border">
        <header className="flex items-center gap-6 px-5 py-3.5 bg-surface border-b border-border text-[12px] font-display font-medium text-secondary">
          <span className="flex-1">Email</span>
          <span className="w-28">Role</span>
          <span className="w-36">Joined</span>
          <span className="w-64 text-right" />
        </header>
        {list.isLoading && (
          <div className="p-10 text-center text-muted text-[14px]">Loading…</div>
        )}
        {list.data?.map((m) => {
          const isSelf = m.userId === currentUserId
          const soleOwner = m.role === "owner" && ownerCount === 1
          return (
            <div
              key={m.userId}
              className="flex items-center gap-6 px-5 py-[18px] border-b border-border text-[14px]"
            >
              <div className="flex-1 font-medium text-primary truncate">
                {m.email}
                {isSelf && (
                  <span className="ml-2 text-muted text-[12px]">(you)</span>
                )}
              </div>
              <div className="w-28 text-secondary text-[13px] capitalize">
                {m.role}
              </div>
              <div className="w-36 text-secondary text-[13px]">
                {fmtDate(m.joinedAt)}
              </div>
              <div className="w-64 flex items-center justify-end gap-3">
                {isSelf ? (
                  soleOwner ? (
                    <Tooltip label="Transfer ownership or delete the workspace first.">
                      <span className="text-muted font-display font-medium text-[13px] cursor-not-allowed">
                        Leave workspace
                      </span>
                    </Tooltip>
                  ) : (
                    <button
                      onClick={() => setConfirm({ kind: "leave", member: m })}
                      className="text-accent hover:opacity-80 font-display font-medium text-[13px]"
                    >
                      Leave workspace
                    </button>
                  )
                ) : (
                  <>
                    {m.role === "member" && (
                      <button
                        onClick={() =>
                          setConfirm({ kind: "transfer", member: m })
                        }
                        className="text-primary hover:opacity-80 font-display font-medium text-[13px]"
                      >
                        Make owner
                      </button>
                    )}
                    <button
                      onClick={() => setConfirm({ kind: "remove", member: m })}
                      className="text-accent hover:opacity-80 font-display font-medium text-[13px]"
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {confirm?.kind === "remove" && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirm(null)}
          title={`Remove ${confirm.member.email}?`}
          description="They'll lose access immediately."
          confirmLabel="Remove"
          onConfirm={() => remove.mutate(confirm.member.userId)}
          pending={remove.isPending}
          error={remove.error?.message}
        />
      )}
      {confirm?.kind === "transfer" && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirm(null)}
          title={`Make ${confirm.member.email} the owner?`}
          description="You will become a Member. Continue?"
          confirmLabel="Transfer ownership"
          onConfirm={() => transfer.mutate(confirm.member.userId)}
          pending={transfer.isPending}
          error={transfer.error?.message}
        />
      )}
      {confirm?.kind === "leave" && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirm(null)}
          title="Leave workspace?"
          description="You'll lose access immediately."
          confirmLabel="Leave"
          onConfirm={() => leave.mutate()}
          pending={leave.isPending}
          error={leave.error?.message}
        />
      )}
    </section>
  )
}

/* -- Invites ------------------------------------------------------- */

function InvitesSection({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient()
  const list = useQuery({
    queryKey: ["invites", workspaceId],
    queryFn: () => listInvites(workspaceId),
  })
  const [email, setEmail] = useState("")
  const [sendError, setSendError] = useState<string | null>(null)

  const send = useMutation({
    mutationFn: (addr: string) => sendInvite(workspaceId, addr),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invites", workspaceId] })
      setEmail("")
      setSendError(null)
    },
    onError: (err: Error) => {
      setSendError(INVITE_ERROR_COPY[err.message] ?? "Couldn't send invite.")
    },
  })

  const revokeM = useMutation({
    mutationFn: (id: string) => revokeInvite(workspaceId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invites", workspaceId] })
      setRevokeTarget(null)
    },
  })
  const resendM = useMutation({
    mutationFn: (id: string) => resendInvite(workspaceId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invites", workspaceId] }),
  })

  const [revokeTarget, setRevokeTarget] = useState<InviteDto | null>(null)

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-[20px] font-medium text-primary">
        Pending invites
      </h2>
      <form
        className="flex items-start gap-3 max-w-xl"
        onSubmit={(e) => {
          e.preventDefault()
          setSendError(null)
          if (email.trim()) send.mutate(email.trim())
        }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            setSendError(null)
          }}
          placeholder="teammate@example.com"
          className="flex-1 px-3.5 py-3 bg-page border border-border text-[14px] text-primary placeholder:text-placeholder focus:outline-none focus:border-primary"
        />
        <Button
          variant="primary"
          type="submit"
          disabled={send.isPending || !email.trim()}
        >
          {send.isPending ? "Sending…" : "Send invite"}
        </Button>
      </form>
      {sendError && (
        <div className="text-[13px] text-accent border-l-2 border-accent bg-surface px-4 py-3 max-w-xl">
          {sendError}
        </div>
      )}

      <div className="border border-border">
        <header className="flex items-center gap-6 px-5 py-3.5 bg-surface border-b border-border text-[12px] font-display font-medium text-secondary">
          <span className="flex-1">Email</span>
          <span className="w-36">Sent</span>
          <span className="w-36">Expires</span>
          <span className="w-48 text-right" />
        </header>
        {list.isLoading && (
          <div className="p-8 text-center text-muted text-[14px]">Loading…</div>
        )}
        {list.data && list.data.length === 0 && (
          <div className="p-8 text-center text-muted text-[14px]">
            No pending invites.
          </div>
        )}
        {list.data?.map((inv) => (
          <div
            key={inv.id}
            className="flex items-center gap-6 px-5 py-[18px] border-b border-border text-[14px]"
          >
            <div className="flex-1 font-medium text-primary truncate">
              {inv.invitedEmail}
            </div>
            <div className="w-36 text-secondary text-[13px]">
              {fmtDate(inv.createdAt)}
            </div>
            <div className="w-36 text-secondary text-[13px]">
              {fmtDate(inv.expiresAt)}
            </div>
            <div className="w-48 flex items-center justify-end gap-3">
              <button
                onClick={() => resendM.mutate(inv.id)}
                className="text-primary hover:opacity-80 font-display font-medium text-[13px]"
                disabled={resendM.isPending}
              >
                Resend
              </button>
              <button
                onClick={() => setRevokeTarget(inv)}
                className="text-accent hover:opacity-80 font-display font-medium text-[13px]"
              >
                Revoke
              </button>
            </div>
          </div>
        ))}
      </div>

      {revokeTarget && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setRevokeTarget(null)}
          title={`Revoke invite to ${revokeTarget.invitedEmail}?`}
          description="The existing link will stop working."
          confirmLabel="Revoke"
          onConfirm={() => revokeM.mutate(revokeTarget.id)}
          pending={revokeM.isPending}
          error={revokeM.error?.message}
        />
      )}
    </section>
  )
}

/* -- Danger zone --------------------------------------------------- */

function DangerZone({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string
  workspaceName: string
}) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")
  const del = useMutation({
    mutationFn: () => deleteWorkspace(workspaceId),
    onSuccess: () => {
      window.location.assign("/")
    },
  })

  const matches = typed === workspaceName

  return (
    <section className="flex flex-col gap-4 max-w-2xl">
      <h2 className="font-display text-[20px] font-medium text-primary">
        Danger zone
      </h2>
      <p className="text-secondary text-[13px] leading-relaxed">
        Deleting a workspace removes all sessions, API keys, members, and
        pending invites. This cannot be undone.
      </p>
      <div>
        <button
          onClick={() => {
            setTyped("")
            setOpen(true)
          }}
          className="text-accent hover:opacity-80 font-display font-medium text-[13px] border border-accent px-4 py-2"
        >
          Delete workspace
        </button>
      </div>

      <Dialog.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setTyped("")
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50" />
          <Dialog.Content className="fixed top-[20%] left-1/2 -translate-x-1/2 w-[520px] bg-page border border-border">
            <div className="flex items-center justify-between px-7 py-6 border-b border-border">
              <Dialog.Title className="font-display text-[18px] font-semibold text-primary">
                Delete workspace
              </Dialog.Title>
              <Dialog.Close asChild>
                <button className="text-muted hover:text-primary">
                  <X size={18} />
                </button>
              </Dialog.Close>
            </div>
            <div className="flex flex-col gap-4 px-7 py-6">
              <Dialog.Description className="text-[13px] text-primary leading-relaxed">
                This will permanently delete{" "}
                <span className="font-mono">{workspaceName}</span> and all its
                data.
              </Dialog.Description>
              <label className="font-display text-[13px] font-medium text-primary">
                Type the workspace name to confirm
              </label>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                aria-label="Workspace name confirmation"
                autoFocus
                className="px-3.5 py-3 bg-page border border-border text-[14px] text-primary focus:outline-none focus:border-primary"
              />
              {del.error && (
                <div className="text-[13px] text-accent border-l-2 border-accent bg-surface px-4 py-3">
                  Couldn't delete workspace. Try again.
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <Dialog.Close asChild>
                  <Button variant="secondary" type="button">
                    Cancel
                  </Button>
                </Dialog.Close>
                <button
                  onClick={() => del.mutate()}
                  disabled={!matches || del.isPending}
                  className="bg-accent text-accent-fg font-display font-medium text-[13px] px-5 py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {del.isPending ? "Deleting…" : "Delete workspace"}
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  Shared confirmation dialog                                         */
/* ------------------------------------------------------------------ */

function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending,
  error,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description: ReactNode
  confirmLabel: string
  onConfirm: () => void
  pending?: boolean | undefined
  error?: string | undefined
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed top-[25%] left-1/2 -translate-x-1/2 w-[460px] bg-page border border-border">
          <div className="flex items-center justify-between px-7 py-6 border-b border-border">
            <Dialog.Title className="font-display text-[18px] font-semibold text-primary">
              {title}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="text-muted hover:text-primary">
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>
          <div className="flex flex-col gap-4 px-7 py-6">
            <Dialog.Description className="text-[13px] text-secondary leading-relaxed">
              {description}
            </Dialog.Description>
            {error && (
              <div className="text-[13px] text-accent border-l-2 border-accent bg-surface px-4 py-3">
                Something went wrong. Try again.
              </div>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <Dialog.Close asChild>
                <Button variant="secondary" type="button">
                  Cancel
                </Button>
              </Dialog.Close>
              <button
                onClick={onConfirm}
                disabled={pending}
                className="bg-accent text-accent-fg font-display font-medium text-[13px] px-5 py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {pending ? "Working…" : confirmLabel}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/* ------------------------------------------------------------------ */

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}
