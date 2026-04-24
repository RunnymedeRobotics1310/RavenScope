import * as Dialog from "@radix-ui/react-dialog"
import { Trash2, X } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "./Button"
import { EditableText } from "./EditableText"
import type { ViewerLayoutSummary } from "../lib/viewer-layouts"

/**
 * Secondary flow for renaming and deleting workspace-shared viewer
 * layouts. Opened from the session-view Layouts dropdown's "Manage
 * layouts…" item. Delete uses a 2-click pattern on the same row: the
 * first click flips the label to "Confirm delete" for ~3 seconds; a
 * second click in that window actually deletes. Rename uses the
 * shared <EditableText> component.
 */
export function ManageLayoutsDialog({
  open,
  onOpenChange,
  workspaceId,
  layouts,
  onRename,
  onDelete,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  layouts: ViewerLayoutSummary[]
  onRename: (layout: ViewerLayoutSummary, newName: string) => Promise<void>
  onDelete: (layout: ViewerLayoutSummary) => Promise<void>
}) {
  // Guards against posting to /api/workspaces//layouts before the
  // session cookie has been materialized in the SPA.
  const active = open && !!workspaceId

  return (
    <Dialog.Root open={active} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed top-[18%] left-1/2 -translate-x-1/2 w-[640px] max-w-[92vw] bg-page border border-border">
          <div className="flex items-start justify-between px-7 py-5 border-b border-border">
            <Dialog.Title className="font-display text-[18px] font-semibold text-primary">
              Manage layouts
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="text-muted hover:text-primary" aria-label="Close">
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>
          <div className="px-7 py-5">
            {layouts.length === 0 ? (
              <p className="text-muted italic text-[14px] py-4">
                No saved layouts yet. Use "Save current as new layout…"
                in the Layouts menu to create one.
              </p>
            ) : (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-secondary border-b border-border">
                    <th className="py-2 font-medium">Name</th>
                    <th className="py-2 font-medium w-[140px]">Updated</th>
                    <th className="py-2 font-medium w-[80px] text-right" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {layouts.map((layout) => (
                    <LayoutRow
                      key={layout.id}
                      layout={layout}
                      onRename={(newName) => onRename(layout, newName)}
                      onDelete={() => onDelete(layout)}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="flex justify-end gap-3 px-7 py-4 border-t border-border">
            <Dialog.Close asChild>
              <Button variant="secondary" type="button">
                Close
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function LayoutRow({
  layout,
  onRename,
  onDelete,
}: {
  layout: ViewerLayoutSummary
  onRename: (newName: string) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    if (!confirming) return
    const timer = window.setTimeout(() => setConfirming(false), 3000)
    return () => window.clearTimeout(timer)
  }, [confirming])

  async function handleDeleteClick() {
    if (!confirming) {
      setConfirming(true)
      setDeleteError(null)
      return
    }
    setDeleting(true)
    setDeleteError(null)
    try {
      await onDelete()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Delete failed")
    } finally {
      setDeleting(false)
      setConfirming(false)
    }
  }

  return (
    <tr className="border-b border-border/50">
      <td className="py-2 pr-3">
        <EditableText
          value={layout.name}
          placeholder="(unnamed)"
          maxLength={120}
          ariaLabel={`Rename layout ${layout.name}`}
          onCommit={async (next) => {
            if (!next) throw new Error("Name cannot be empty")
            try {
              await onRename(next)
            } catch (e) {
              const tag = e instanceof Error ? e.message : ""
              if (tag === "name_in_use") {
                throw new Error("A layout with that name already exists.")
              }
              throw e
            }
          }}
        />
      </td>
      <td className="py-2 pr-3 text-secondary">
        {new Date(layout.updatedAt).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}
      </td>
      <td className="py-2 text-right">
        {deleteError && (
          <span className="block text-[12px] text-accent mb-1">
            {deleteError}
          </span>
        )}
        <button
          type="button"
          onClick={handleDeleteClick}
          disabled={deleting}
          aria-label={confirming ? `Confirm delete ${layout.name}` : `Delete ${layout.name}`}
          className={`inline-flex items-center gap-1 px-2 py-1 text-[12px] border ${
            confirming
              ? "border-accent text-accent hover:bg-accent/5"
              : "border-border text-secondary hover:text-primary"
          } disabled:opacity-50`}
        >
          <Trash2 size={12} aria-hidden />
          {deleting ? "Deleting…" : confirming ? "Confirm delete" : "Delete"}
        </button>
      </td>
    </tr>
  )
}
