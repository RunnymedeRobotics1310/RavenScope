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
 * Deletion semantics: FK onDelete=RESTRICT on workspace/user references that
 * carry business data (api_keys, telemetry_sessions) so orphaning cannot
 * happen by accident. session_batches cascades on session delete (batches
 * are tightly owned). workspace_members cascades on both parents — pure
 * join-table rows with no independent existence; see plan
 * 2026-04-23-003-feat-workspace-members-plan.md → Key Technical Decisions.
 */

export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(uuid),
  email: text("email").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
})

// Ownership now flows through `workspace_members.role = 'owner'` — the old
// `owner_user_id` column was dropped in migration 0002.
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey().$defaultFn(uuid),
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

export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 'owner' | 'member' — enforced in application code.
    role: text("role").notNull(),
    joinedAt: integer("joined_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    // Nullable because backfilled owner rows have no inviter, and because
    // the inviter's user row may later be deleted (FK onDelete=set null).
    invitedByUserId: text("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.userId] }),
    // Powers "list workspaces a user belongs to" in the fallback query and
    // `GET /api/me`. Tie-breaker on workspace_id is load-bearing for the
    // requireCookieUser fallback determinism.
    userJoinedIdx: index("workspace_members_user_joined_idx").on(
      t.userId,
      t.joinedAt,
      t.workspaceId,
    ),
  }),
)

// NOTE: Drizzle-orm v0.45 cannot express partial SQLite unique indexes. The
// `pendingUnique` index below is declared as a plain unique in the schema,
// but the generated migration 0002 is hand-edited to add the
// `WHERE accepted_at IS NULL AND revoked_at IS NULL` clause. If a future
// `drizzle-kit generate` run strips that clause, re-add it by hand and
// review the diff carefully before applying.
export const workspaceInvites = sqliteTable(
  "workspace_invites",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    invitedEmail: text("invited_email").notNull(),
    invitedByUserId: text("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // 'member' only in v1 — reserved for future 'admin' etc.
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // Plain unique in the schema; hand-edited to partial in migration 0002.
    pendingUnique: uniqueIndex("workspace_invites_pending_unique").on(
      t.workspaceId,
      t.invitedEmail,
    ),
    workspaceCreatedIdx: index("workspace_invites_workspace_created_idx").on(
      t.workspaceId,
      t.createdAt,
    ),
  }),
)

// Workspace-shared viewer layouts. Any workspace member can create, rename,
// or delete rows. `state_json` carries the AS Lite HubState payload as
// JSON text. Unique (workspace_id, name) keeps picker UIs unambiguous;
// duplicates surface as 409 in the route layer.
export const workspaceViewerLayouts = sqliteTable(
  "workspace_viewer_layouts",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    stateJson: text("state_json").notNull(),
    // Nullable: set null when the creating user is deleted so layouts
    // outlive churn. Traceability preserved in the column until then.
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    workspaceNameUnique: uniqueIndex("workspace_viewer_layouts_workspace_name_unique").on(
      t.workspaceId,
      t.name,
    ),
    // Powers the picker ordered by most-recently-edited.
    workspaceUpdatedIdx: index("workspace_viewer_layouts_workspace_updated_idx").on(
      t.workspaceId,
      t.updatedAt,
    ),
  }),
)

// Per-user viewer preferences. Composite PK (user, workspace) so the row
// is unambiguous when a user later belongs to multiple workspaces. The
// `default_layout_id` FK uses onDelete=set null so deleting a shared
// layout silently demotes users who had selected it as their default,
// rather than blocking the delete or cascading to remove their
// captured last-used blob.
export const userViewerPreferences = sqliteTable(
  "user_viewer_preferences",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    defaultLayoutId: text("default_layout_id").references(
      () => workspaceViewerLayouts.id,
      { onDelete: "set null" },
    ),
    // Nullable: null = user has never interacted with the viewer. TEXT is
    // used (not BLOB) because HubState is small JSON and easier to
    // inspect during incident triage.
    lastUsedStateJson: text("last_used_state_json"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.workspaceId] }),
  }),
)

export const schema = {
  users,
  workspaces,
  workspaceMembers,
  workspaceInvites,
  loginTokens,
  apiKeys,
  telemetrySessions,
  sessionBatches,
  auditLog,
  dailyQuota,
  workspaceViewerLayouts,
  userViewerPreferences,
}

// Reference `sql` at top-level to keep the import stable even when we
// temporarily remove the default-expression column in future migrations.
export const _schemaMetadata = { generatedAt: sql`CURRENT_TIMESTAMP` }
