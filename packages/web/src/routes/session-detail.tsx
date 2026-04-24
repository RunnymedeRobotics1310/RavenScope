import * as Dialog from "@radix-ui/react-dialog"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronLeft, Search, X } from "lucide-react"
import { useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { Button } from "../components/Button"
import { KeyTree } from "../components/KeyTree"
import { TopNav } from "../components/TopNav"
import { EditableText } from "../components/EditableText"
import {
  deleteSession,
  fetchSessionDetail,
  fetchSessionTree,
  sessionDownloadUrl,
  updateSession,
  type SessionDetail as SessionDetailDto,
} from "../lib/api"

export function SessionDetail() {
  const { id = "" } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [treeSearch, setTreeSearch] = useState("")
  const [confirmOpen, setConfirmOpen] = useState(false)

  const detail = useQuery({
    queryKey: ["session", id],
    queryFn: () => fetchSessionDetail(id),
    enabled: !!id,
  })

  const tree = useQuery({
    queryKey: ["session", id, "tree"],
    queryFn: () => fetchSessionTree(id),
    enabled: !!id,
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteSession(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sessions"] })
      nav("/", { replace: true })
    },
  })

  const updateEventName = useMutation({
    mutationFn: (next: string | null) => updateSession(id, { fmsEventName: next }),
    onSuccess: (updated) => {
      qc.setQueryData<SessionDetailDto>(["session", id], updated)
      qc.invalidateQueries({ queryKey: ["sessions"] })
    },
  })

  return (
    <div className="min-h-screen bg-page">
      <TopNav />
      <main className="px-12 py-8 flex flex-col gap-6">
        {detail.isLoading && (
          <div className="text-muted text-[14px]">Loading session…</div>
        )}
        {detail.data && (
          <>
            <section className="border border-border px-7 py-6 flex flex-col gap-6">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2.5 text-[13px]">
                  <ChevronLeft size={14} className="text-muted" />
                  <Link to="/" className="text-secondary hover:text-primary">
                    Sessions
                  </Link>
                  <span className="text-muted">/</span>
                  <span className="text-primary font-medium">
                    {detail.data.matchLabel ?? detail.data.sessionId}
                    {detail.data.fmsEventName && (
                      <span className="text-secondary font-normal">
                        {" "}
                        — {detail.data.fmsEventName}
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="destructive"
                    onClick={() => setConfirmOpen(true)}
                    disabled={deleteMutation.isPending}
                  >
                    Delete
                  </Button>
                  <a href={sessionDownloadUrl(id)} download>
                    <Button variant="secondary">Download .wpilog</Button>
                  </a>
                  <Link to={`/sessions/${id}/view`}>
                    <Button variant="primary">Open viewer</Button>
                  </Link>
                </div>
              </div>
              <h1 className="font-display text-[40px] font-medium leading-tight tracking-[-1px] text-primary flex items-baseline gap-4">
                <EditableText
                  value={detail.data.fmsEventName}
                  placeholder="Add event name"
                  onCommit={async (next) => {
                    await updateEventName.mutateAsync(next)
                  }}
                  className="text-[40px] font-display font-medium tracking-[-1px]"
                  ariaLabel="Edit event name"
                />
                {detail.data.matchLabel && (
                  <span className="text-secondary text-[22px] font-display font-normal">
                    · {detail.data.matchLabel}
                  </span>
                )}
              </h1>
              <div className="flex flex-wrap gap-12">
                <Stat
                  label="Session"
                  value={<span className="font-mono">{detail.data.sessionId}</span>}
                  mono={false}
                />
                <Stat
                  label="Started"
                  value={new Date(detail.data.startedAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                  mono={false}
                />
                <Stat
                  label="Duration"
                  value={
                    detail.data.endedAt
                      ? fmtDuration(
                          new Date(detail.data.endedAt).getTime() -
                            new Date(detail.data.startedAt).getTime(),
                        )
                      : "—"
                  }
                />
                <Stat
                  label="Entries"
                  value={detail.data.entryCount.toLocaleString()}
                />
                <Stat label="Batches" value={detail.data.batchCount.toLocaleString()} />
                <Stat
                  label="WPILog"
                  value={
                    <span className="flex items-center gap-1.5">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          detail.data.wpilogKey ? "bg-success" : "bg-muted"
                        }`}
                      />
                      {detail.data.wpilogKey ? "Ready (cached)" : "Not generated"}
                    </span>
                  }
                  mono={false}
                />
              </div>
            </section>

            <section className="border border-border">
              <header className="flex items-center justify-between px-5 py-3.5 bg-surface border-b border-border">
                <div className="flex items-center gap-4">
                  <h2 className="font-display text-[14px] font-semibold text-primary">
                    Key tree
                  </h2>
                  <span className="text-muted text-[12px]">
                    {tree.data ? `${tree.data.totalKeys} keys` : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2 px-2.5 py-2 bg-page border border-border w-72">
                  <Search size={12} className="text-muted" />
                  <input
                    value={treeSearch}
                    onChange={(e) => setTreeSearch(e.target.value)}
                    placeholder="Filter by key path…"
                    className="flex-1 bg-transparent text-[12px] font-mono text-primary placeholder:text-placeholder focus:outline-none"
                  />
                </div>
              </header>
              {tree.isLoading && (
                <div className="p-12 text-center text-muted text-[14px]">
                  Building tree…
                </div>
              )}
              {tree.data && (
                <KeyTree
                  nodes={tree.data.nodes}
                  search={treeSearch}
                  sessionStartIso={detail.data.startedAt}
                />
              )}
            </section>
          </>
        )}
      </main>

      <Dialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50" />
          <Dialog.Content className="fixed top-[24%] left-1/2 -translate-x-1/2 w-[520px] bg-page border border-border">
            <div className="flex items-start justify-between px-7 py-6 border-b border-border">
              <Dialog.Title className="font-display text-[18px] font-semibold text-primary">
                Delete this session?
              </Dialog.Title>
              <Dialog.Close asChild>
                <button className="text-muted hover:text-primary">
                  <X size={18} />
                </button>
              </Dialog.Close>
            </div>
            <div className="px-7 py-6 flex flex-col gap-4">
              <p className="text-secondary text-[14px] leading-relaxed">
                This permanently deletes the session row, its batch JSONLs,
                the cached key tree, and any cached WPILog. The RavenLink
                upload history on disk is unaffected.
              </p>
              {detail.data && (
                <div className="bg-surface border border-border px-4 py-3 text-[13px] font-mono text-primary">
                  {detail.data.sessionId}
                  {detail.data.matchLabel && (
                    <span className="text-muted"> · {detail.data.matchLabel}</span>
                  )}
                </div>
              )}
              {deleteMutation.isError && (
                <p className="text-accent text-[13px]">
                  Delete failed. {String((deleteMutation.error as Error).message)}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-3 px-7 py-5 border-t border-border">
              <Dialog.Close asChild>
                <Button variant="secondary" type="button">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button
                variant="destructive"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? "Deleting…" : "Delete session"}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

function Stat({
  label,
  value,
  mono = true,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] text-muted">{label}</div>
      <div
        className={`text-[14px] text-primary ${
          mono ? "font-mono" : "font-display font-medium"
        }`}
      >
        {value}
      </div>
    </div>
  )
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return "—"
  const total = ms / 1000
  const mins = Math.floor(total / 60)
  const secs = Math.round(total - mins * 60)
  return `${mins}m ${secs}s`
}
