import type { Db } from "../db/client"
import { auditLog } from "../db/schema"

export type AuditEventType =
  | "magic_link_requested"
  | "magic_link_verified"
  | "logout"
  | "key_create"
  | "key_revoke"
  | "key_use"
  | "session_create"
  | "session_complete"
  | "quota_cap_hit"
  // Workspace membership & invite lifecycle (see plan U2).
  | "workspace.member_invited"
  | "workspace.invite_revoked"
  | "workspace.invite_accepted"
  | "workspace.member_removed"
  | "workspace.member_left"
  | "workspace.ownership_transferred"
  | "workspace.deleted"
  // Both explicit POST /switch-workspace and automatic cookie-fallback
  // re-signs emit this event. Disambiguate via
  // metadata.reason: 'explicit' | 'cookie_fallback'. For forensics, the
  // audit row's workspace_id column holds the NEW (target) workspace id.
  | "workspace.switched"

export interface AuditEntry {
  eventType: AuditEventType
  actorUserId?: string | undefined
  actorApiKeyId?: string | undefined
  workspaceId?: string | undefined
  ipHash?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

export async function logAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    eventType: entry.eventType,
    actorUserId: entry.actorUserId ?? null,
    actorApiKeyId: entry.actorApiKeyId ?? null,
    workspaceId: entry.workspaceId ?? null,
    ipHash: entry.ipHash ?? null,
    metadataJson: entry.metadata ? JSON.stringify(entry.metadata) : null,
  })
}

export async function hashIp(ip: string): Promise<string> {
  const bytes = new TextEncoder().encode(ip)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  const u8 = new Uint8Array(digest)
  // First 8 bytes as hex is enough to correlate per-IP patterns without
  // storing a full identifying hash.
  let hex = ""
  for (let i = 0; i < 8; i++) hex += u8[i]!.toString(16).padStart(2, "0")
  return hex
}
