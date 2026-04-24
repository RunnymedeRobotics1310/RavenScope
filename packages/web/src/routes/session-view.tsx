import * as Dialog from "@radix-ui/react-dialog"
import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ChevronDown, ChevronLeft, Layout, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { Button } from "../components/Button"
import { ManageLayoutsDialog } from "../components/ManageLayoutsDialog"
import { fetchSessionDetail, sessionViewerUrl } from "../lib/api"
import { useMe } from "../lib/auth"
import {
  applyLayoutToIframe,
  captureCurrentState,
  deleteViewerLayout,
  fetchViewerPreferences,
  getViewerLayout,
  listViewerLayouts,
  saveViewerLayout,
  setDefaultViewerLayout,
  updateViewerLayout,
  type ViewerLayoutSummary,
} from "../lib/viewer-layouts"

/**
 * Full-bleed embedded AdvantageScope Lite viewer for a single session.
 * Thin RavenScope chrome at the top (Back + session identity +
 * Layouts menu), iframe fills the rest of the viewport.
 *
 * iframe sandbox is `allow-scripts allow-same-origin` -- same-origin is
 * required for the session cookie to flow on AS Lite's relative fetches
 * under /v/:id/*. Session cookie is HttpOnly (see
 * packages/worker/src/auth/cookie.ts), so AS Lite's JS cannot read it
 * even with same-origin. allow-downloads is intentionally omitted for
 * v1; AS Lite's export flows are not required.
 *
 * The Layouts dropdown goes through packages/web/src/lib/viewer-layouts.ts
 * and the namespaced postMessage channel the AS outer shell patch
 * installs -- see
 * docs/plans/2026-04-24-002-feat-shared-viewer-layouts-plan.md.
 */
export function SessionView() {
  const { id = "" } = useParams()
  const detail = useQuery({
    queryKey: ["session", id],
    queryFn: () => fetchSessionDetail(id),
    enabled: !!id,
  })

  const title = detail.data
    ? (detail.data.matchLabel ?? detail.data.sessionId)
    : "…"
  const subtitle = detail.data?.fmsEventName

  const iframeRef = useRef<HTMLIFrameElement>(null)
  // Gate the dropdown until the iframe's outer shell has loaded; the
  // postMessage responder is registered in main.ts's initHub, so
  // capturing state before that fires will time out.
  const [iframeReady, setIframeReady] = useState(false)

  return (
    <div className="flex flex-col h-screen w-screen bg-page">
      <header className="flex items-center gap-4 px-6 h-12 border-b border-border flex-shrink-0">
        <Link
          to={`/sessions/${id}`}
          className="flex items-center gap-1.5 text-secondary hover:text-primary text-[13px]"
        >
          <ChevronLeft size={14} />
          Back
        </Link>
        <span className="text-muted">/</span>
        <span className="text-primary font-medium text-[13px] truncate flex-1 min-w-0">
          {title}
          {subtitle && (
            <span className="text-secondary font-normal"> — {subtitle}</span>
          )}
        </span>
        <LayoutsMenu iframeRef={iframeRef} iframeReady={iframeReady} />
      </header>
      <iframe
        ref={iframeRef}
        title="AdvantageScope viewer"
        src={sessionViewerUrl(id)}
        sandbox="allow-scripts allow-same-origin"
        className="flex-1 w-full border-0"
        onLoad={() => setIframeReady(true)}
      />
    </div>
  )
}

function LayoutsMenu({
  iframeRef,
  iframeReady,
}: {
  iframeRef: React.RefObject<HTMLIFrameElement | null>
  iframeReady: boolean
}) {
  const me = useMe()
  const workspaceId = me.data?.workspaceId ?? ""
  const queryClient = useQueryClient()

  const layoutsQuery = useQuery({
    queryKey: ["viewer-layouts", workspaceId],
    queryFn: () => listViewerLayouts(workspaceId),
    enabled: !!workspaceId,
  })
  const prefsQuery = useQuery({
    queryKey: ["viewer-prefs"],
    queryFn: fetchViewerPreferences,
    enabled: !!workspaceId,
  })

  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [saveDialogName, setSaveDialogName] = useState("")
  const [saveDialogError, setSaveDialogError] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [manageOpen, setManageOpen] = useState(false)

  useEffect(() => {
    if (!statusMsg) return
    const timer = window.setTimeout(() => setStatusMsg(null), 2500)
    return () => window.clearTimeout(timer)
  }, [statusMsg])

  const saveMutation = useMutation({
    mutationFn: async ({ name, state }: { name: string; state: unknown }) => {
      return saveViewerLayout(workspaceId, name, state)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["viewer-layouts", workspaceId] })
      setSaveDialogOpen(false)
      setSaveDialogName("")
      setSaveDialogError(null)
      setStatusMsg("Layout saved")
    },
    onError: (err: Error) => {
      if (err.message === "name_in_use") {
        setSaveDialogError("A layout with that name already exists.")
      } else if (err.message === "payload_too_large") {
        setSaveDialogError("Layout state is too large to save.")
      } else {
        setSaveDialogError("Save failed. Try again.")
      }
    },
  })

  const overwriteMutation = useMutation({
    mutationFn: async ({
      layoutId,
      state,
    }: {
      layoutId: string
      state: unknown
    }) => {
      return updateViewerLayout(workspaceId, layoutId, { state })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["viewer-layouts", workspaceId] })
      setStatusMsg("Layout updated")
    },
    onError: () => setStatusMsg("Update failed"),
  })

  const setDefaultMutation = useMutation({
    mutationFn: (layoutId: string | null) => setDefaultViewerLayout(layoutId),
    onSuccess: (data) => {
      queryClient.setQueryData(["viewer-prefs"], data)
      setStatusMsg(
        data.defaultLayoutId ? "Default set for you" : "Default cleared",
      )
    },
    onError: () => setStatusMsg("Could not set default"),
  })

  async function captureOrToast(): Promise<unknown | null> {
    const iframe = iframeRef.current
    if (!iframe) return null
    setCapturing(true)
    try {
      return await captureCurrentState(iframe)
    } catch {
      setStatusMsg("Viewer didn't respond. Refresh and try again.")
      return null
    } finally {
      setCapturing(false)
    }
  }

  async function onSaveAsNew() {
    setSaveDialogError(null)
    setSaveDialogName("")
    setSaveDialogOpen(true)
  }

  async function submitSaveAsNew() {
    const name = saveDialogName.trim()
    if (!name) {
      setSaveDialogError("Name can't be empty.")
      return
    }
    const state = await captureOrToast()
    if (state === null) {
      setSaveDialogOpen(false)
      return
    }
    saveMutation.mutate({ name, state })
  }

  async function onOverwrite(layout: ViewerLayoutSummary) {
    const state = await captureOrToast()
    if (state === null) return
    overwriteMutation.mutate({ layoutId: layout.id, state })
  }

  async function onLoad(layout: ViewerLayoutSummary) {
    try {
      const full = await getViewerLayout(workspaceId, layout.id)
      const iframe = iframeRef.current
      if (!iframe) return
      applyLayoutToIframe(iframe, full.state)
      setStatusMsg(`Loaded "${layout.name}"`)
    } catch {
      setStatusMsg("Could not load layout")
    }
  }

  const layouts = layoutsQuery.data ?? []
  const explicitDefaultId = prefsQuery.data?.defaultLayoutId ?? null
  // Effective default includes the server's sole-layout fallback:
  // when the user has no explicit default and the workspace has
  // exactly one layout, that layout is treated as the default. Keep
  // the UI truth in one place so the check mark matches the bootstrap
  // response the viewer actually loads.
  const effectiveDefaultId =
    explicitDefaultId ?? (layouts.length === 1 ? layouts[0]!.id : null)
  const disabled = !iframeReady || !workspaceId || capturing

  return (
    <>
      <div className="flex items-center gap-3">
        {statusMsg && (
          <span className="text-secondary text-[12px]">{statusMsg}</span>
        )}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label="Layout menu"
              className="flex items-center gap-1.5 px-2.5 py-1 border border-border text-[13px] text-secondary hover:text-primary hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Layout size={13} aria-hidden />
              Layouts
              <ChevronDown size={12} aria-hidden />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              className="z-50 min-w-[240px] bg-surface border border-border shadow-lg py-1"
            >
              <DropdownMenu.Item
                className="px-3 py-2 text-[13px] text-primary outline-none cursor-pointer data-[highlighted]:bg-page"
                onSelect={() => {
                  // Defer to next tick so the dropdown finishes closing
                  // before the dialog mounts.
                  setTimeout(() => onSaveAsNew(), 0)
                }}
              >
                Save current as new layout…
              </DropdownMenu.Item>

              <SubmenuList
                label="Save current over…"
                layouts={layouts}
                emptyLabel="No saved layouts yet"
                onPick={onOverwrite}
              />
              <SubmenuList
                label="Load layout…"
                layouts={layouts}
                emptyLabel="No saved layouts yet"
                onPick={onLoad}
              />
              <SubmenuList
                label="Set as my default"
                layouts={layouts}
                emptyLabel="No saved layouts yet"
                checkFor={effectiveDefaultId}
                onPick={(layout) => setDefaultMutation.mutate(layout.id)}
                footer={
                  // "Clear my default" only makes sense for an explicit
                  // pick. The sole-layout fallback is not user-cleared
                  // — adding a second layout dissolves it instead.
                  explicitDefaultId ? (
                    <DropdownMenu.Item
                      className="px-3 py-2 text-[13px] text-secondary outline-none cursor-pointer data-[highlighted]:bg-page"
                      onSelect={() => setDefaultMutation.mutate(null)}
                    >
                      Clear my default
                    </DropdownMenu.Item>
                  ) : null
                }
              />

              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Item
                className="px-3 py-2 text-[13px] text-secondary outline-none cursor-pointer data-[highlighted]:bg-page hover:text-primary"
                onSelect={() => setTimeout(() => setManageOpen(true), 0)}
              >
                Manage layouts…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      <ManageLayoutsDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        workspaceId={workspaceId}
        layouts={layouts}
        onDelete={async (layout) => {
          await deleteViewerLayout(workspaceId, layout.id)
          queryClient.invalidateQueries({
            queryKey: ["viewer-layouts", workspaceId],
          })
          queryClient.invalidateQueries({ queryKey: ["viewer-prefs"] })
        }}
        onRename={async (layout, newName) => {
          await updateViewerLayout(workspaceId, layout.id, { name: newName })
          queryClient.invalidateQueries({
            queryKey: ["viewer-layouts", workspaceId],
          })
        }}
      />

      <Dialog.Root open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50" />
          <Dialog.Content className="fixed top-[24%] left-1/2 -translate-x-1/2 w-[440px] bg-page border border-border">
            <div className="flex items-start justify-between px-7 py-6 border-b border-border">
              <Dialog.Title className="font-display text-[18px] font-semibold text-primary">
                Save layout
              </Dialog.Title>
              <Dialog.Close asChild>
                <button className="text-muted hover:text-primary">
                  <X size={18} />
                </button>
              </Dialog.Close>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                submitSaveAsNew()
              }}
              className="px-7 py-6 flex flex-col gap-4"
            >
              <label className="flex flex-col gap-2 text-[13px]">
                <span className="text-secondary">Layout name</span>
                <input
                  autoFocus
                  value={saveDialogName}
                  onChange={(e) => {
                    setSaveDialogName(e.target.value)
                    if (saveDialogError) setSaveDialogError(null)
                  }}
                  placeholder="e.g. Match review"
                  className="border border-border bg-surface px-3 py-2 text-primary outline-none focus:border-accent"
                />
                {saveDialogError && (
                  <span className="text-accent text-[12px]">
                    {saveDialogError}
                  </span>
                )}
              </label>
              <div className="flex justify-end gap-3 pt-2">
                <Dialog.Close asChild>
                  <Button variant="secondary" type="button">
                    Cancel
                  </Button>
                </Dialog.Close>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={saveMutation.isPending || capturing}
                >
                  {saveMutation.isPending || capturing ? "Saving…" : "Save"}
                </Button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}

/**
 * A dropdown item that opens a submenu listing layouts. `onPick` fires
 * when the user clicks a specific layout. `checkFor` renders a check
 * next to the current default. `footer` is an optional extra item
 * below the list (used for "Clear my default").
 */
function SubmenuList({
  label,
  layouts,
  emptyLabel,
  onPick,
  checkFor,
  footer,
}: {
  label: string
  layouts: ViewerLayoutSummary[]
  emptyLabel: string
  onPick: (layout: ViewerLayoutSummary) => void
  checkFor?: string | null
  footer?: React.ReactNode
}) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger
        className="px-3 py-2 text-[13px] text-primary outline-none cursor-pointer data-[highlighted]:bg-page flex items-center justify-between"
      >
        {label}
        <span className="text-muted ml-3" aria-hidden>
          ›
        </span>
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          sideOffset={4}
          className="z-50 min-w-[220px] bg-surface border border-border shadow-lg py-1 max-h-[60vh] overflow-y-auto"
        >
          {layouts.length === 0 && (
            <div className="px-3 py-2 text-[13px] text-muted italic">
              {emptyLabel}
            </div>
          )}
          {layouts.map((layout) => (
            <DropdownMenu.Item
              key={layout.id}
              className="flex items-center gap-2 px-3 py-2 text-[13px] outline-none cursor-pointer data-[highlighted]:bg-page"
              onSelect={() => onPick(layout)}
            >
              <span className="w-4 flex items-center justify-center" aria-hidden>
                {checkFor === layout.id ? (
                  <Check className="w-3.5 h-3.5 text-accent" />
                ) : null}
              </span>
              <span className="flex-1 text-primary truncate">
                {layout.name}
              </span>
            </DropdownMenu.Item>
          ))}
          {footer && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              {footer}
            </>
          )}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  )
}
