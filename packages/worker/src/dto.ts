// Wire contracts mirroring RavenBrain's TelemetryApi records.
// Populated across Units 3, 4, 5, 6.

export interface RequestLinkRequest {
  email: string
}

export interface UserMeResponse {
  userId: string
  email: string
  workspaceId: string
  workspaceName: string
}

export interface ApiKeyCreateRequest {
  /** 1-100 characters. Duplicates allowed. Not editable after creation. */
  name: string
}

export interface ApiKeyCreateResponse {
  id: string
  name: string
  prefix: string
  last4: string
  /** Unix ms. */
  createdAt: number
  /** The full token. Returned exactly once at creation; never shown again. */
  plaintext: string
}

export interface ApiKeyListItem {
  id: string
  name: string
  prefix: string
  last4: string
  /** Unix ms. */
  createdAt: number
  lastUsedAt: number | null
  revokedAt: number | null
}

export interface ApiKeyListResponse {
  items: ApiKeyListItem[]
}
