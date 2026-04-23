import * as Dialog from "@radix-ui/react-dialog"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Copy, TriangleAlert, X } from "lucide-react"
import { useState } from "react"
import { Button } from "../components/Button"
import { EmptyState } from "../components/EmptyState"
import { StatusBadge } from "../components/Badge"
import { TopNav } from "../components/TopNav"
import {
  createApiKey,
  fetchApiKeys,
  revokeApiKey,
  type ApiKeyCreateResponse,
  type ApiKeyListItem,
} from "../lib/api"

export function ApiKeysPage() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ["keys"], queryFn: fetchApiKeys })
  const [createOpen, setCreateOpen] = useState(false)
  const [revealed, setRevealed] = useState<ApiKeyCreateResponse | null>(null)

  const create = useMutation({
    mutationFn: createApiKey,
    onSuccess: (created) => {
      setRevealed(created)
      setCreateOpen(false)
      qc.invalidateQueries({ queryKey: ["keys"] })
    },
  })

  const revoke = useMutation({
    mutationFn: revokeApiKey,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["keys"] }),
  })

  return (
    <div className="min-h-screen bg-page">
      <TopNav />
      <main className="px-12 py-10 flex flex-col gap-8">
        <div className="flex items-end justify-between gap-6">
          <div className="flex flex-col gap-1.5 max-w-3xl">
            <h1 className="font-display text-[40px] font-medium leading-tight tracking-[-1px] text-primary">
              API keys
            </h1>
            <p className="text-secondary text-[14px] leading-relaxed">
              Create a key and point RavenLink at this workspace. Keys are shown in full
              only once — store them safely.
            </p>
          </div>
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            + Create key
          </Button>
        </div>

        <div className="border border-border">
          <header className="flex items-center gap-6 px-5 py-3.5 bg-surface border-b border-border text-[12px] font-display font-medium text-secondary">
            <span className="flex-1">Name</span>
            <span className="w-64">Key</span>
            <span className="w-40">Created</span>
            <span className="w-40">Last used</span>
            <span className="w-36">Status</span>
            <span className="w-24 text-right" />
          </header>
          {list.isLoading && (
            <div className="p-12 text-center text-muted text-[14px]">Loading…</div>
          )}
          {list.data && list.data.items.length === 0 && (
            <EmptyState
              title="No API keys yet"
              description="Create one to let RavenLink upload telemetry to this workspace."
              action={
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  Create your first key
                </Button>
              }
            />
          )}
          {list.data?.items.map((k) => (
            <KeyRow key={k.id} k={k} onRevoke={() => revoke.mutate(k.id)} />
          ))}
        </div>
      </main>

      <CreateKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        submitting={create.isPending}
        onSubmit={(name) => create.mutate(name)}
      />

      <RevealKeyDialog revealed={revealed} onClose={() => setRevealed(null)} />
    </div>
  )
}

function KeyRow({ k, onRevoke }: { k: ApiKeyListItem; onRevoke: () => void }) {
  const isRevoked = !!k.revokedAt
  return (
    <div className="flex items-center gap-6 px-5 py-[18px] border-b border-border text-[14px]">
      <div className="flex-1 font-medium text-primary truncate">{k.name}</div>
      <div className="w-64 font-mono text-[13px] text-secondary truncate">
        {k.prefix}…{k.last4}
      </div>
      <div className="w-40 text-secondary text-[13px]">{fmtDate(k.createdAt)}</div>
      <div className="w-40 text-secondary text-[13px]">
        {k.lastUsedAt ? fmtRelative(k.lastUsedAt) : "Never"}
      </div>
      <div className="w-36">
        <StatusBadge tone={isRevoked ? "revoked" : "active"}>
          {isRevoked ? "Revoked" : "Active"}
        </StatusBadge>
      </div>
      <div className="w-24 text-right">
        {isRevoked ? (
          <span className="text-muted">—</span>
        ) : (
          <button
            onClick={onRevoke}
            className="text-accent hover:opacity-80 font-display font-medium text-[13px]"
          >
            Revoke
          </button>
        )}
      </div>
    </div>
  )
}

function CreateKeyDialog({
  open,
  onOpenChange,
  submitting,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  submitting: boolean
  onSubmit: (name: string) => void
}) {
  const [name, setName] = useState("")
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) setName("")
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed top-[20%] left-1/2 -translate-x-1/2 w-[480px] bg-page border border-border">
          <div className="flex items-center justify-between px-7 py-6 border-b border-border">
            <Dialog.Title className="font-display text-[18px] font-semibold text-primary">
              New API key
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="text-muted hover:text-primary">
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>
          <form
            className="flex flex-col gap-4 px-7 py-6"
            onSubmit={(e) => {
              e.preventDefault()
              if (name.trim()) onSubmit(name.trim())
            }}
          >
            <label className="font-display text-[13px] font-medium text-primary">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              maxLength={100}
              placeholder="e.g. RavenLink — DS Laptop"
              className="px-3.5 py-3 bg-page border border-border text-[14px] text-primary placeholder:text-placeholder focus:outline-none focus:border-primary"
            />
            <div className="flex justify-end gap-3 pt-2">
              <Dialog.Close asChild>
                <Button variant="secondary" type="button">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button
                variant="primary"
                type="submit"
                disabled={submitting || !name.trim()}
              >
                {submitting ? "Creating…" : "Create"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function RevealKeyDialog({
  revealed,
  onClose,
}: {
  revealed: ApiKeyCreateResponse | null
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  if (!revealed) return null
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) {
          const ok = confirm(
            "Are you sure? You will NOT be able to see this key again.",
          )
          if (ok) onClose()
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed top-[18%] left-1/2 -translate-x-1/2 w-[720px] bg-page border border-border">
          <div className="flex items-start justify-between px-7 py-6 border-b border-border">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="font-display text-[18px] font-semibold text-primary">
                API key created
              </Dialog.Title>
              <Dialog.Description className="text-secondary text-[13px]">
                {revealed.name}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button className="text-muted hover:text-primary">
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>
          <div className="flex flex-col gap-5 px-7 py-6">
            <div className="flex items-start gap-3 bg-surface border-l-2 border-accent px-4 py-3.5">
              <TriangleAlert size={16} className="text-accent shrink-0 mt-0.5" />
              <p className="text-[13px] text-primary leading-relaxed">
                This is the only time the full key will be shown. Copy it and store it
                somewhere safe — we don't keep a copy.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <span className="font-display text-[13px] font-medium text-primary">
                Your new key
              </span>
              <div className="flex border border-border">
                <div className="flex-1 px-4 py-3.5 bg-code font-mono text-[13px] text-primary break-all">
                  {revealed.plaintext}
                </div>
                <button
                  onClick={async () => {
                    await navigator.clipboard.writeText(revealed.plaintext)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  }}
                  className="px-4 py-3.5 border-l border-border flex items-center gap-1.5 text-[13px] font-display font-medium text-primary hover:bg-surface"
                >
                  <Copy size={14} />
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="text-muted text-[12px] leading-relaxed">
                Add this to your RavenLink config under{" "}
                <span className="font-mono">ravenbrain.api_key</span> (requires the
                bearer-auth patch).
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-3 px-7 py-5 border-t border-border">
            <Button variant="primary" onClick={onClose}>
              I've saved this key
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function fmtRelative(ms: number): string {
  const delta = Date.now() - ms
  if (delta < 0) return "just now"
  const mins = Math.floor(delta / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}
