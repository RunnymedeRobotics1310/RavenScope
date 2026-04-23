/**
 * Typed fetch wrappers for the RavenScope worker API. Re-exports DTO
 * shapes from the worker package so the UI stays in lock-step with the
 * wire contract without a generated client.
 */

import type {
  ApiKeyCreateRequest,
  ApiKeyCreateResponse,
  ApiKeyListResponse,
  KeyTreeResponse,
  RequestLinkRequest,
  SessionDetail,
  SessionListResponse,
  UserMeResponse,
} from "../../../worker/src/dto"

export type {
  ApiKeyCreateResponse,
  ApiKeyListItem,
  ApiKeyListResponse,
  KeyTreeNode,
  KeyTreeResponse,
  SessionDetail,
  SessionListItem,
  SessionListResponse,
  UserMeResponse,
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

export async function deleteSession(id: string): Promise<void> {
  const { status } = await request(`/api/sessions/${id}`, { method: "DELETE" })
  if (status !== 204) throw new Error(`delete ${id} returned ${status}`)
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
