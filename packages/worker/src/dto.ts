// Wire contracts mirroring RavenBrain's TelemetryApi records.
// Populated across Units 3, 4, 5, 6.

/* --- Auth (Unit 3) -------------------------------------------------- */

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

/* --- Telemetry ingest (Unit 5) ------------------------------------- *
 *
 * Byte-compatible with RavenBrain's TelemetryApi records
 * (ca.team1310.ravenbrain.telemetry.TelemetryApi). All timestamps are
 * ISO-8601 strings (Java `Instant` / Go `time.Time` default JSON).
 */

export interface CreateSessionRequest {
  sessionId: string
  teamNumber: number
  robotIp: string
  startedAt: string
}

export interface TelemetryEntryRequest {
  ts: string
  entryType: string
  ntKey?: string | null
  ntType?: string | null
  ntValue?: string | null
  fmsRaw?: number | null
}

export interface CompleteSessionRequest {
  endedAt: string
  entryCount: number
}

export interface BatchInsertResult {
  count: number
}

/** Shape returned for `POST /session`, `GET /session/{id}`, `POST
 * /session/{id}/complete`. Mirrors RavenBrain's TelemetrySession record. */
export interface TelemetrySessionResponse {
  id: string
  sessionId: string
  teamNumber: number
  robotIp: string
  startedAt: string
  endedAt: string | null
  entryCount: number
  uploadedCount: number
  createdAt: string
  tournamentId: string | null
  matchLabel: string | null
  matchLevel: string | null
  matchNumber: number | null
  playoffRound: string | null
  fmsEventName: string | null
}
