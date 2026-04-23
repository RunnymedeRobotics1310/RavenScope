import { useQuery } from "@tanstack/react-query"
import { ChevronLeft, Search } from "lucide-react"
import { useState } from "react"
import { Link, useParams } from "react-router-dom"
import { Button } from "../components/Button"
import { KeyTree } from "../components/KeyTree"
import { TopNav } from "../components/TopNav"
import {
  fetchSessionDetail,
  fetchSessionTree,
  sessionDownloadUrl,
} from "../lib/api"

export function SessionDetail() {
  const { id = "" } = useParams()
  const [treeSearch, setTreeSearch] = useState("")

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
                <a href={sessionDownloadUrl(id)} download>
                  <Button variant="primary">Download .wpilog</Button>
                </a>
              </div>
              <h1 className="font-display text-[40px] font-medium leading-tight tracking-[-1px] text-primary">
                {detail.data.matchLabel ?? detail.data.sessionId}
              </h1>
              <div className="flex flex-wrap gap-12">
                <Stat label="Event" value={detail.data.fmsEventName ?? "—"} mono={false} />
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
