/**
 * Client helpers for shared viewer layouts (plan U4).
 *
 * CRUD against /api/workspaces/:wsid/layouts, per-user preferences
 * against /api/me/viewer-*, plus `captureCurrentState(iframe)` which
 * performs the postMessage round-trip against the patched AS outer
 * shell to grab the current HubState without a server round-trip.
 */
import type {
  SaveViewerLayoutRequest,
  UpdateViewerLayoutRequest,
  UpdateViewerPreferencesRequest,
  ViewerLayoutBootstrap,
  ViewerLayoutDto,
  ViewerLayoutSummary,
  ViewerLayoutsResponse,
  ViewerPreferencesResponse,
} from "../../../worker/src/dto"

export type {
  ViewerLayoutBootstrap,
  ViewerLayoutDto,
  ViewerLayoutSummary,
  ViewerPreferencesResponse,
} from "../../../worker/src/dto"

const RAVEN_MSG_NAMESPACE = "ravenscope:viewer"
/** Upper bound on how long to wait for the iframe to respond with its
 *  captured state. The iframe responds synchronously from an in-memory
 *  cache; anything over a second indicates the patch didn't install
 *  (wrong bundle) or the iframe never finished loading. */
const CAPTURE_TIMEOUT_MS = 3000

async function jsonFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ data: T | null; status: number }> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  })
  let data: T | null = null
  const ct = res.headers.get("Content-Type") ?? ""
  if (ct.includes("application/json")) {
    try {
      data = (await res.json()) as T
    } catch {
      data = null
    }
  }
  return { data, status: res.status }
}

export async function listViewerLayouts(
  workspaceId: string,
): Promise<ViewerLayoutSummary[]> {
  const { data, status } = await jsonFetch<ViewerLayoutsResponse>(
    `/api/workspaces/${workspaceId}/layouts`,
  )
  if (status !== 200 || !data) {
    throw new Error(`list viewer layouts returned ${status}`)
  }
  return data.layouts
}

export async function getViewerLayout(
  workspaceId: string,
  layoutId: string,
): Promise<ViewerLayoutDto> {
  const { data, status } = await jsonFetch<ViewerLayoutDto>(
    `/api/workspaces/${workspaceId}/layouts/${layoutId}`,
  )
  if (status !== 200 || !data) {
    throw new Error(`get viewer layout returned ${status}`)
  }
  return data
}

export async function saveViewerLayout(
  workspaceId: string,
  name: string,
  state: unknown,
): Promise<ViewerLayoutDto> {
  const body: SaveViewerLayoutRequest = { name, state }
  const { data, status } = await jsonFetch<ViewerLayoutDto>(
    `/api/workspaces/${workspaceId}/layouts`,
    { method: "POST", body: JSON.stringify(body) },
  )
  if (status === 409) throw new Error("name_in_use")
  if (status === 413) throw new Error("payload_too_large")
  if (status !== 201 || !data) {
    throw new Error(`save viewer layout returned ${status}`)
  }
  return data
}

export async function updateViewerLayout(
  workspaceId: string,
  layoutId: string,
  patch: UpdateViewerLayoutRequest,
): Promise<ViewerLayoutDto> {
  const { data, status } = await jsonFetch<ViewerLayoutDto>(
    `/api/workspaces/${workspaceId}/layouts/${layoutId}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  )
  if (status === 409) throw new Error("name_in_use")
  if (status === 413) throw new Error("payload_too_large")
  if (status !== 200 || !data) {
    throw new Error(`update viewer layout returned ${status}`)
  }
  return data
}

export async function deleteViewerLayout(
  workspaceId: string,
  layoutId: string,
): Promise<void> {
  const { status } = await jsonFetch(
    `/api/workspaces/${workspaceId}/layouts/${layoutId}`,
    { method: "DELETE" },
  )
  if (status !== 204 && status !== 404) {
    throw new Error(`delete viewer layout returned ${status}`)
  }
}

export async function fetchViewerPreferences(): Promise<ViewerPreferencesResponse> {
  const { data, status } = await jsonFetch<ViewerPreferencesResponse>(
    "/api/me/viewer-preferences",
  )
  if (status !== 200 || !data) {
    throw new Error(`viewer preferences returned ${status}`)
  }
  return data
}

export async function setDefaultViewerLayout(
  defaultLayoutId: string | null,
): Promise<ViewerPreferencesResponse> {
  const body: UpdateViewerPreferencesRequest = { defaultLayoutId }
  const { data, status } = await jsonFetch<ViewerPreferencesResponse>(
    "/api/me/viewer-preferences",
    { method: "PUT", body: JSON.stringify(body) },
  )
  if (status === 404) throw new Error("not_found")
  if (status !== 200 || !data) {
    throw new Error(`set default viewer layout returned ${status}`)
  }
  return data
}

/**
 * Round-trip with the patched AS outer shell to capture the current
 * HubState. Resolves with the state the iframe has most recently seen
 * from its hub frame. Rejects on timeout (iframe unresponsive — usually
 * means the bundle is too old to know about the message namespace).
 *
 * Safe to call repeatedly; each call uses its own reqId and cleans up
 * its listener regardless of outcome.
 */
export function captureCurrentState(
  iframe: HTMLIFrameElement,
): Promise<unknown> {
  const reqId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `r${Date.now()}_${Math.random().toString(36).slice(2)}`

  return new Promise<unknown>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage)
      reject(new Error("capture_timeout"))
    }, CAPTURE_TIMEOUT_MS)

    function onMessage(event: MessageEvent) {
      if (event.source !== iframe.contentWindow) return
      if (event.origin !== window.location.origin) return
      const data = event.data as
        | { type?: string; kind?: string; reqId?: string; state?: unknown }
        | null
      if (!data || data.type !== RAVEN_MSG_NAMESPACE) return
      if (data.kind !== "state-response" || data.reqId !== reqId) return
      window.clearTimeout(timer)
      window.removeEventListener("message", onMessage)
      resolve(data.state)
    }

    window.addEventListener("message", onMessage)
    iframe.contentWindow?.postMessage(
      { type: RAVEN_MSG_NAMESPACE, kind: "get-state", reqId },
      window.location.origin,
    )
  })
}

/**
 * Push a layout into the live iframe without a page reload. The outer
 * shell forwards it via sendMessage(hubPort, "restore-state", state).
 */
export function applyLayoutToIframe(
  iframe: HTMLIFrameElement,
  state: unknown,
): void {
  iframe.contentWindow?.postMessage(
    { type: RAVEN_MSG_NAMESPACE, kind: "apply-state", state },
    window.location.origin,
  )
}
