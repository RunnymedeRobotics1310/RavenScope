/**
 * Typed fetch wrappers for the RavenScope worker API. Re-exports DTO
 * shapes from the worker package so the UI stays in lock-step with the
 * wire contract without a generated client.
 */

import type {
  ApiKeyCreateRequest,
  ApiKeyCreateResponse,
  ApiKeyListResponse,
  CreateInviteResponse,
  InviteCreateRequest,
  InviteDto,
  KeyTreeResponse,
  MemberDto,
  MembersResponse,
  PendingInvitesResponse,
  RequestLinkRequest,
  SessionDetail,
  SessionListResponse,
  SwitchWorkspaceRequest,
  TransferOwnershipRequest,
  UpdateWorkspaceRequest,
  UserMeResponse,
  WorkspaceInfo,
} from "../../../worker/src/dto"

export type {
  ApiKeyCreateResponse,
  ApiKeyListItem,
  ApiKeyListResponse,
  InviteDto,
  KeyTreeNode,
  KeyTreeResponse,
  MemberDto,
  SessionDetail,
  SessionListItem,
  SessionListResponse,
  UserMeResponse,
  WorkspaceInfo,
} from "../../../worker/src/dto"

const BASE = "" // same-origin; Vite's dev proxy forwards /api → worker

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ data: T | null; status: number; response: Response }> {
  const res = await fetch(BASE + path, {
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
  return { data, status: res.status, response: res }
}

export async function fetchMe(): Promise<UserMeResponse | null> {
  const { data, status } = await request<UserMeResponse>("/api/auth/me")
  if (status === 401) return null
  if (status !== 200 || !data) throw new Error(`/api/auth/me returned ${status}`)
  return data
}

export async function requestMagicLink(email: string): Promise<{ ok: boolean; status: number }> {
  const body: RequestLinkRequest = { email }
  const { status } = await request("/api/auth/request-link", {
    method: "POST",
    body: JSON.stringify(body),
  })
  return { ok: status === 204, status }
}

export async function logout(): Promise<void> {
  await request("/api/auth/logout", { method: "POST" })
}

export async function switchWorkspace(workspaceId: string): Promise<void> {
  const body: SwitchWorkspaceRequest = { workspaceId }
  const { status } = await request("/api/auth/switch-workspace", {
    method: "POST",
    body: JSON.stringify(body),
  })
  if (status < 200 || status >= 300) {
    throw new Error(`/api/auth/switch-workspace returned ${status}`)
  }
}

export async function fetchSessions(params: {
  q?: string
  sort?: string
  order?: string
  cursor?: string | null
  limit?: number
}): Promise<SessionListResponse> {
  const sp = new URLSearchParams()
  if (params.q) sp.set("q", params.q)
  if (params.sort) sp.set("sort", params.sort)
  if (params.order) sp.set("order", params.order)
  if (params.cursor) sp.set("cursor", params.cursor)
  if (params.limit) sp.set("limit", String(params.limit))
  const qs = sp.toString()
  const { data, status } = await request<SessionListResponse>(
    `/api/sessions${qs ? `?${qs}` : ""}`,
  )
  if (status !== 200 || !data) throw new Error(`/api/sessions returned ${status}`)
  return data
}

export async function fetchSessionDetail(id: string): Promise<SessionDetail> {
  const { data, status } = await request<SessionDetail>(`/api/sessions/${id}`)
  if (status !== 200 || !data) throw new Error(`session ${id} returned ${status}`)
  return data
}

export async function fetchSessionTree(id: string): Promise<KeyTreeResponse> {
  const { data, status } = await request<KeyTreeResponse>(`/api/sessions/${id}/tree`)
  if (status !== 200 || !data) throw new Error(`tree ${id} returned ${status}`)
  return data
}

export function sessionDownloadUrl(id: string): string {
  return `/api/sessions/${id}/wpilog`
}

/**
 * URL for the embedded AdvantageScope Lite viewer iframe. The trailing
 * slash matters -- AS Lite's relative fetches (logs?folder=...,
 * assets/...) resolve against `/v/${id}/`, so they land on our worker
 * route handlers. The `?log=` query param is consumed by AS Lite's
 * RavenScope-applied main.ts patch to auto-open that file on boot;
 * the name is arbitrary since /v/:id/logs/<name> ignores it.
 */
export function sessionViewerUrl(id: string): string {
  return `/v/${encodeURIComponent(id)}/?log=session.wpilog`
}

export async function deleteSession(id: string): Promise<void> {
  const { status } = await request(`/api/sessions/${id}`, { method: "DELETE" })
  if (status !== 204) throw new Error(`delete ${id} returned ${status}`)
}

export async function updateSession(
  id: string,
  patch: { fmsEventName?: string | null },
): Promise<SessionDetail> {
  const { data, status } = await request<SessionDetail>(`/api/sessions/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })
  if (status !== 200 || !data) throw new Error(`update ${id} returned ${status}`)
  return data
}

export async function fetchApiKeys(): Promise<ApiKeyListResponse> {
  const { data, status } = await request<ApiKeyListResponse>("/api/keys")
  if (status !== 200 || !data) throw new Error(`/api/keys returned ${status}`)
  return data
}

export async function createApiKey(name: string): Promise<ApiKeyCreateResponse> {
  const body: ApiKeyCreateRequest = { name }
  const { data, status } = await request<ApiKeyCreateResponse>("/api/keys", {
    method: "POST",
    body: JSON.stringify(body),
  })
  if (status !== 201 || !data) throw new Error(`create key returned ${status}`)
  return data
}

export async function revokeApiKey(id: string): Promise<void> {
  const { status } = await request(`/api/keys/${id}`, { method: "DELETE" })
  if (status !== 204) throw new Error(`revoke ${id} returned ${status}`)
}

/* --- Workspace members (U5) ---------------------------------------- */

export async function listMembers(workspaceId: string): Promise<MemberDto[]> {
  const { data, status } = await request<MembersResponse>(
    `/api/workspaces/${workspaceId}/members`,
  )
  if (status !== 200 || !data) {
    throw new Error(`/api/workspaces/${workspaceId}/members returned ${status}`)
  }
  return data.members
}

export async function removeMember(
  workspaceId: string,
  userId: string,
): Promise<void> {
  const { status } = await request(
    `/api/workspaces/${workspaceId}/members/${userId}`,
    { method: "DELETE" },
  )
  if (status !== 204) throw new Error(`remove member returned ${status}`)
}

export async function leaveWorkspace(workspaceId: string): Promise<void> {
  const { status } = await request(`/api/workspaces/${workspaceId}/leave`, {
    method: "POST",
  })
  if (status !== 204) throw new Error(`leave returned ${status}`)
}

export async function transferOwnership(
  workspaceId: string,
  newOwnerUserId: string,
): Promise<void> {
  const body: TransferOwnershipRequest = { newOwnerUserId }
  const { status } = await request(`/api/workspaces/${workspaceId}/transfer`, {
    method: "POST",
    body: JSON.stringify(body),
  })
  if (status !== 204) throw new Error(`transfer returned ${status}`)
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  const { status } = await request(`/api/workspaces/${workspaceId}`, {
    method: "DELETE",
  })
  if (status !== 204) throw new Error(`delete workspace returned ${status}`)
}

export async function updateWorkspace(
  workspaceId: string,
  patch: UpdateWorkspaceRequest,
): Promise<WorkspaceInfo> {
  const { data, status } = await request<WorkspaceInfo>(
    `/api/workspaces/${workspaceId}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  )
  if (status !== 200 || !data) {
    throw new Error(`update workspace returned ${status}`)
  }
  return data
}

/* --- Invites (U4) -------------------------------------------------- */

export async function listInvites(workspaceId: string): Promise<InviteDto[]> {
  const { data, status } = await request<PendingInvitesResponse>(
    `/api/workspaces/${workspaceId}/invites`,
  )
  if (status !== 200 || !data) {
    throw new Error(`/api/workspaces/${workspaceId}/invites returned ${status}`)
  }
  return data.invites
}

export async function sendInvite(
  workspaceId: string,
  email: string,
): Promise<CreateInviteResponse> {
  const body: InviteCreateRequest = { email }
  const { data, status, response } = await request<CreateInviteResponse>(
    `/api/workspaces/${workspaceId}/invites`,
    { method: "POST", body: JSON.stringify(body) },
  )
  if (status === 201 && data) return data
  // Bubble up structured error tag for UI branching.
  const tag =
    (data as { error?: string } | null)?.error ??
    `http_${status || response.status}`
  throw new Error(tag)
}

export async function revokeInvite(
  workspaceId: string,
  inviteId: string,
): Promise<void> {
  const { status } = await request(
    `/api/workspaces/${workspaceId}/invites/${inviteId}`,
    { method: "DELETE" },
  )
  if (status !== 204) throw new Error(`revoke invite returned ${status}`)
}

export async function resendInvite(
  workspaceId: string,
  inviteId: string,
): Promise<void> {
  const { status } = await request(
    `/api/workspaces/${workspaceId}/invites/${inviteId}/resend`,
    { method: "POST" },
  )
  if (status !== 204 && status !== 200 && status !== 202) {
    throw new Error(`resend invite returned ${status}`)
  }
}

export async function acceptInvite(token: string): Promise<void> {
  // The backend 302s to `/` on success. fetch() follows redirects by default;
  // after the redirect the final response will be the SPA's `/` (HTML) with a
  // 200. Treat any 2xx as success. Non-2xx carries a structured {error:tag}
  // body which we surface as Error.message for the UI to branch on.
  const { data, status } = await request<{ error?: string }>(
    "/api/invites/accept",
    { method: "POST", body: JSON.stringify({ token }) },
  )
  if (status >= 200 && status < 300) return
  const tag = data?.error ?? `http_${status}`
  throw new Error(tag)
}
