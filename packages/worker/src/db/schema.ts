import { sql } from "drizzle-orm"
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

const uuid = () => crypto.randomUUID()

/*
 * RavenScope v1 data model (see docs/plans/2026-04-17-001-feat-ravenscope-
 * greenfield-plan.md → Data model sketch).
 *
 * IDs: random UUIDs as TEXT for portability and for safe concurrent generation
 * across the main Worker and Durable Objects.
 *
 * Timestamps: INTEGER columns storing ms-since-epoch; drizzle maps them to
 * Date objects via `{ mode: 'timestamp_ms' }`.
 *
 * Deletion semantics: FK onDelete=RESTRICT on all workspace/user references
 * so orphaning cannot happen by accident — see Unit 2 test scenarios.
 * session_batches cascades on session delete (batches are tightly owned).
 */

export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(uuid),
  email: text("email").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
})

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey().$defaultFn(uuid),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
})

export const loginTokens = sqliteTable(
  "login_tokens",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    tokenHash: text("token_hash").notNull().unique(),
    email: text("email").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // Used by the per-email rate limit in Unit 3.
    emailExpiresIdx: index("login_tokens_email_expires_idx").on(t.email, t.expiresAt),
  }),
)

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    last4: text("last4").notNull(),
    hash: text("hash").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    workspaceRevokedIdx: index("api_keys_workspace_revoked_idx").on(
      t.workspaceId,
      t.revokedAt,
    ),
  }),
)

export const telemetrySessions = sqliteTable(
  "telemetry_sessions",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    // The client-supplied session identifier (unique per workspace).
    sessionId: text("session_id").notNull(),
    teamNumber: integer("team_number"),
    robotIp: text("robot_ip"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    entryCount: integer("entry_count").notNull().default(0),
    uploadedCount: integer("uploaded_count").notNull().default(0),
    tournamentId: text("tournament_id"),
    matchLabel: text("match_label"),
    matchLevel: text("match_level"),
    matchNumber: integer("match_number"),
    playoffRound: text("playoff_round"),
    fmsEventName: text("fms_event_name"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    lastBatchAt: integer("last_batch_at", { mode: "timestamp_ms" }),
    wpilogKey: text("wpilog_key"),
    wpilogGeneratedAt: integer("wpilog_generated_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    workspaceSessionUnique: uniqueIndex("telemetry_sessions_workspace_session_unique").on(
      t.workspaceId,
      t.sessionId,
    ),
    // Powers the sessions-list query: WHERE workspace_id = ? ORDER BY started_at DESC.
    workspaceStartedIdx: index("telemetry_sessions_workspace_started_idx").on(
      t.workspaceId,
      t.startedAt,
    ),
  }),
)

export const sessionBatches = sqliteTable(
  "session_batches",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => telemetrySessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    byteLength: integer("byte_length").notNull(),
    entryCount: integer("entry_count").notNull(),
    r2Key: text("r2_key").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sessionId, t.seq] }),
  }),
)

export const dailyQuota = sqliteTable("daily_quota", {
  /** UTC "YYYY-MM-DD" — effective primary key and the partition boundary. */
  date: text("date").primaryKey(),
  /** Total gzip-compressed bytes written to R2 on this day. */
  bytesUploaded: integer("bytes_uploaded").notNull().default(0),
  classAOps: integer("class_a_ops").notNull().default(0),
  classBOps: integer("class_b_ops").notNull().default(0),
  /** One-shot flags for the operator alert — flip 0→1 on the first
   *  breach of the day; keeps us from emailing on every subsequent
   *  over-cap request. */
  alertedBytes: integer("alerted_bytes").notNull().default(0),
  alertedClassA: integer("alerted_class_a").notNull().default(0),
  alertedClassB: integer("alerted_class_b").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
})

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    eventType: text("event_type").notNull(),
    actorUserId: text("actor_user_id"),
    actorApiKeyId: text("actor_api_key_id"),
    workspaceId: text("workspace_id"),
    ipHash: text("ip_hash"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    metadataJson: text("metadata_json"),
  },
  (t) => ({
    // Audit rows are append-only and queried by recency + workspace.
    // Deliberately no FKs: records may outlive referenced workspaces/users.
    createdWorkspaceIdx: index("audit_log_created_workspace_idx").on(
      t.createdAt,
      t.workspaceId,
    ),
  }),
)

export const schema = {
  users,
  workspaces,
  loginTokens,
  apiKeys,
  telemetrySessions,
  sessionBatches,
  auditLog,
  dailyQuota,
}

// Reference `sql` at top-level to keep the import stable even when we
// temporarily remove the default-expression column in future migrations.
export const _schemaMetadata = { generatedAt: sql`CURRENT_TIMESTAMP` }
