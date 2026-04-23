import { ChevronDown, ChevronRight } from "lucide-react"
import { useMemo, useState } from "react"
import type { KeyTreeNode } from "../lib/api"
import { Badge } from "./Badge"

interface KeyTreeProps {
  nodes: KeyTreeNode[]
  /** Case-insensitive path substring; empty string matches all. */
  search?: string
  /** Session-relative timebase for formatting firstTs/lastTs. */
  sessionStartIso?: string
}

/**
 * Hierarchical NT key tree. Branches are Radix-style disclosures, leaves
 * show path + type badge + sample count + ts range. Auto-expands ancestors
 * of any filter-matching leaf so search reveals nested hits.
 */
export function KeyTree({ nodes, search = "", sessionStartIso }: KeyTreeProps) {
  const baseMs = sessionStartIso ? Date.parse(sessionStartIso) : 0

  // Compute which paths must be force-open to reveal filter matches.
  const forceOpen = useMemo(
    () => (search ? collectMatchingAncestors(nodes, search.toLowerCase()) : null),
    [nodes, search],
  )

  if (nodes.length === 0) {
    return (
      <div className="py-12 px-6 text-center text-muted text-[14px]">
        No keys captured. The session was created but no NT data was posted.
      </div>
    )
  }

  return (
    <ul role="tree" className="py-2">
      {nodes.map((n) => (
        <Node
          key={n.path}
          node={n}
          depth={0}
          search={search.toLowerCase()}
          forceOpen={forceOpen}
          baseMs={baseMs}
        />
      ))}
    </ul>
  )
}

interface NodeProps {
  node: KeyTreeNode
  depth: number
  search: string
  forceOpen: Set<string> | null
  baseMs: number
}

function Node({ node, depth, search, forceOpen, baseMs }: NodeProps) {
  const [open, setOpen] = useState(depth === 0)
  const isLeaf = node.sampleCount !== undefined
  const hasChildren = node.children.length > 0
  const effectiveOpen = forceOpen ? forceOpen.has(node.path) : open
  const pad = 20 + depth * 24

  // Under an active search, hide branches that have no matching descendant.
  if (search && forceOpen && !forceOpen.has(node.path) && !matchesSelf(node, search)) {
    return null
  }

  return (
    <li role="treeitem" aria-expanded={hasChildren ? effectiveOpen : undefined}>
      <div
        className="flex items-center gap-3 py-2 text-[13px] hover:bg-surface/50 cursor-pointer"
        style={{ paddingLeft: pad, paddingRight: 20 }}
        onClick={() => hasChildren && setOpen((v) => !v)}
      >
        {hasChildren ? (
          effectiveOpen ? (
            <ChevronDown size={14} className="text-primary shrink-0" />
          ) : (
            <ChevronRight size={14} className="text-muted shrink-0" />
          )
        ) : (
          <span className="w-[14px] shrink-0" />
        )}
        <span className="font-mono text-primary truncate">
          {depth === 0 ? node.path : node.name}
        </span>
        {isLeaf && (
          <Badge className="shrink-0">
            {node.ntType}
          </Badge>
        )}
        {isLeaf && (
          <span className="ml-auto text-muted text-[12px] shrink-0 font-sans">
            {formatSampleLine(node, baseMs)}
          </span>
        )}
        {!isLeaf && (
          <span className="ml-auto text-muted text-[12px] shrink-0">
            {countDescendantLeaves(node)} keys
          </span>
        )}
      </div>
      {hasChildren && effectiveOpen && (
        <ul role="group">
          {node.children.map((child) => (
            <Node
              key={child.path}
              node={child}
              depth={depth + 1}
              search={search}
              forceOpen={forceOpen}
              baseMs={baseMs}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

function collectMatchingAncestors(
  nodes: KeyTreeNode[],
  search: string,
  acc = new Set<string>(),
): Set<string> {
  for (const n of nodes) {
    const descendantHit = collectMatchingAncestors(n.children, search, acc).has(
      n.children[0]?.path ?? "",
    )
    const selfHit = n.path.toLowerCase().includes(search)
    if (selfHit || anyDescendantMatches(n.children, search)) {
      acc.add(n.path)
    }
    // `descendantHit` unused but calling ensures recursion already populated acc
    void descendantHit
  }
  return acc
}

function anyDescendantMatches(nodes: KeyTreeNode[], search: string): boolean {
  for (const n of nodes) {
    if (n.path.toLowerCase().includes(search)) return true
    if (anyDescendantMatches(n.children, search)) return true
  }
  return false
}

function matchesSelf(node: KeyTreeNode, search: string): boolean {
  return !search || node.path.toLowerCase().includes(search)
}

function countDescendantLeaves(node: KeyTreeNode): number {
  let n = node.sampleCount !== undefined ? 1 : 0
  for (const c of node.children) n += countDescendantLeaves(c)
  return n
}

function formatSampleLine(node: KeyTreeNode, baseMs: number): string {
  const count = node.sampleCount ?? 0
  const first = node.firstTs ? formatRelative(node.firstTs, baseMs) : ""
  const last = node.lastTs ? formatRelative(node.lastTs, baseMs) : ""
  const rangeBit = first && last ? ` · ${first} – ${last}` : ""
  return `${count.toLocaleString()} samples${rangeBit}`
}

function formatRelative(iso: string, baseMs: number): string {
  const ms = Date.parse(iso) - baseMs
  if (!Number.isFinite(ms)) return iso
  const total = Math.max(ms, 0) / 1000
  const mins = Math.floor(total / 60)
  const secs = total - mins * 60
  return `${mins.toString().padStart(2, "0")}:${secs.toFixed(3).padStart(6, "0")}`
}
