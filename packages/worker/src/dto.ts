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
