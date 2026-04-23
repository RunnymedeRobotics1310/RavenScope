import * as Dialog from "@radix-ui/react-dialog"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowDown, ArrowUp, Search, X } from "lucide-react"
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { Button } from "../components/Button"
import { EmptyState } from "../components/EmptyState"
import { SessionRow } from "../components/SessionRow"
import { TopNav } from "../components/TopNav"
import {
  deleteSession,
  fetchSessions,
  type SessionListItem,
  type SessionListResponse,
} from "../lib/api"

type Sort = "started_at" | "fms_event_name" | "match_label"
type Order = "asc" | "desc"

export function Sessions() {
  const [q, setQ] = useState("")
  const [sort, setSort] = useState<Sort>("started_at")
  const [order, setOrder] = useState<Order>("desc")
  const [pendingDelete, setPendingDelete] = useState<SessionListItem | null>(null)
  const qc = useQueryClient()

  const params = useMemo(() => ({ q, sort, order, limit: 25 }), [q, sort, order])

  const list = useQuery<SessionListResponse>({
    queryKey: ["sessions", params],
    queryFn: () => fetchSessions(params),
  })

  const del = useMutation({
    mutationFn: (session: SessionListItem) => deleteSession(session.id),
    onSuccess: () => {
      setPendingDelete(null)
      qc.invalidateQueries({ queryKey: ["sessions"] })
    },
  })

  return (
    <div className="min-h-screen bg-page">
      <TopNav />
      <main className="px-12 py-10 flex flex-col gap-8">
        <div className="flex items-end justify-between gap-6">
          <div className="flex flex-col gap-1">
            <h1 className="font-display text-[40px] font-medium leading-tight tracking-[-1px] text-primary">
              Sessions
            </h1>
            <p className="text-secondary text-[14px]">
              {list.data ? `${list.data.items.length} shown` : "Loading…"}
            </p>
          </div>
          <div className="flex items-center gap-2 px-3 py-2.5 bg-page border border-border w-80">
            <Search size={14} className="text-muted" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search event name…"
              className="flex-1 bg-transparent text-[13px] text-primary placeholder:text-placeholder focus:outline-none"
            />
          </div>
        </div>

        <div className="border border-border">
          <header className="flex items-center gap-6 px-5 py-3.5 bg-surface border-b border-border text-[12px] font-display font-medium text-secondary">
            <SortHeader
              label="Started"
              className="w-56"
              field="started_at"
              current={sort}
              order={order}
              onToggle={(next) => {
                setSort(next.sort)
                setOrder(next.order)
              }}
            />
            <span className="w-32">Duration</span>
            <span className="w-32 text-right">Entries</span>
            <SortHeader
              label="Event"
              className="flex-1 min-w-0"
              field="fms_event_name"
              current={sort}
              order={order}
              onToggle={(next) => {
                setSort(next.sort)
                setOrder(next.order)
              }}
            />
            <SortHeader
              label="Match"
              className="w-40"
              field="match_label"
              current={sort}
              order={order}
              onToggle={(next) => {
                setSort(next.sort)
                setOrder(next.order)
              }}
            />
            <span className="w-24 text-right">Actions</span>
          </header>

          {list.isLoading && (
            <div className="p-12 text-center text-muted text-[14px]">Loading sessions…</div>
          )}
          {list.isError && (
            <div className="p-12 text-center text-accent text-[14px]">
              Couldn't load sessions.
            </div>
          )}
          {list.data && list.data.items.length === 0 && (
            <EmptyState
              title="No sessions yet"
              description="Create an API key and point RavenLink at this workspace to start uploading telemetry."
              action={
                <Link to="/keys">
                  <Button variant="primary">Create API key</Button>
                </Link>
              }
            />
          )}
          {list.data?.items.map((s) => (
            <SessionRow key={s.id} session={s} onRequestDelete={setPendingDelete} />
          ))}
        </div>

        {list.data && list.data.nextCursor && (
          <div className="flex justify-end">
            <Button variant="secondary">Next page</Button>
          </div>
        )}
      </main>

      <Dialog.Root
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
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
              {pendingDelete && (
                <div className="bg-surface border border-border px-4 py-3 text-[13px] font-mono text-primary">
                  {pendingDelete.sessionId}
                  {pendingDelete.matchLabel && (
                    <span className="text-muted"> · {pendingDelete.matchLabel}</span>
                  )}
                </div>
              )}
              {del.isError && (
                <p className="text-accent text-[13px]">
                  Delete failed. {String((del.error as Error).message)}
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
                onClick={() => pendingDelete && del.mutate(pendingDelete)}
                disabled={del.isPending || !pendingDelete}
              >
                {del.isPending ? "Deleting…" : "Delete session"}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

interface SortHeaderProps {
  label: string
  field: Sort
  current: Sort
  order: Order
  className?: string
  onToggle: (next: { sort: Sort; order: Order }) => void
}

function SortHeader({ label, field, current, order, className = "", onToggle }: SortHeaderProps) {
  const isActive = current === field
  return (
    <button
      onClick={() => {
        if (isActive) {
          onToggle({ sort: field, order: order === "asc" ? "desc" : "asc" })
        } else {
          onToggle({ sort: field, order: "desc" })
        }
      }}
      className={`flex items-center gap-1.5 text-left ${className} ${
        isActive ? "text-primary" : "text-secondary hover:text-primary"
      }`}
    >
      {label}
      {isActive &&
        (order === "desc" ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
    </button>
  )
}
