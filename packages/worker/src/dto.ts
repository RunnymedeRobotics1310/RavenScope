// Wire contracts mirroring RavenBrain's TelemetryApi records.
// Populated across Units 3, 4, 5, 6.

/* --- Auth (Unit 3) -------------------------------------------------- */

export interface RequestLinkRequest {
  email: string
}

export interface WorkspaceInfo {
  id: string
  name: string
  role: "owner" | "member"
}

export interface UserMeResponse {
  userId: string
  email: string
  /** Active workspace id. Mirrors `activeWorkspace.id` for backward compatibility. */
  workspaceId: string
  /** Active workspace name. Mirrors `activeWorkspace.name` for backward compatibility. */
  workspaceName: string
  activeWorkspace: WorkspaceInfo
  /** All workspaces the user belongs to, sorted by joinedAt ASC then workspace_id ASC. */
  workspaces: WorkspaceInfo[]
}

export interface SwitchWorkspaceRequest {
  workspaceId: string
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
  /**
   * "data" for NT value updates (ntKey/ntType/ntValue populated).
   * "match_start" / "match_end" / "session_end" for markers (fmsRaw
   * populated on match_start). Matches RavenLink's uploader and
   * RavenBrain's TelemetryApi wire contract verbatim.
   */
  entryType: "data" | "match_start" | "match_end" | "session_end" | string
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

/* --- Web-UI sessions (Unit 6) -------------------------------------- */

export type SessionListSort = "started_at" | "fms_event_name" | "match_label"
export type SessionListOrder = "asc" | "desc"

export interface SessionListQuery {
  q?: string
  sort?: SessionListSort
  order?: SessionListOrder
  cursor?: string
  limit?: number
}

export interface SessionListItem {
  id: string
  sessionId: string
  teamNumber: number
  startedAt: string
  endedAt: string | null
  entryCount: number
  uploadedCount: number
  fmsEventName: string | null
  matchLabel: string | null
  lastBatchAt: string | null
  wpilogGeneratedAt: string | null
}

export interface SessionListResponse {
  items: SessionListItem[]
  nextCursor: string | null
}

export interface SessionDetail extends SessionListItem {
  robotIp: string
  createdAt: string
  tournamentId: string | null
  matchLevel: string | null
  matchNumber: number | null
  playoffRound: string | null
  batchCount: number
  wpilogKey: string | null
}

export interface KeyTreeNode {
  /** Full path to this node (e.g. "/SmartDashboard/Drivetrain/Pose"). */
  path: string
  /** Last segment only (e.g. "Pose"). */
  name: string
  children: KeyTreeNode[]
  // Present only when this node has recorded samples (a "leaf" in NT terms).
  // NT allows a key to be both a branch and a leaf, so these are independent
  // of `children.length`.
  ntType?: string
  sampleCount?: number
  firstTs?: string
  lastTs?: string
}

export interface KeyTreeResponse {
  nodes: KeyTreeNode[]
  totalKeys: number
  malformedLines: number
  generatedAt: string
}
