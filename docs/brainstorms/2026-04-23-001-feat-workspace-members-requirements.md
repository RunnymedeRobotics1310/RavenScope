# Workspace Members — Requirements

**Status:** Ready for planning
**Date:** 2026-04-23
**Scope:** Standard

## Problem

RavenScope today is strictly single-seat: `workspaces.owner_user_id` is a single FK, the magic-link session identity carries exactly one `workspaceId`, and there is no way for a second person to view a team's sessions without sharing the owner's login. In practice FRC teams have multiple people who care about post-match telemetry — drive coach, programming mentor, student lead — and they each want their own sign-in.

## Goal

Let a workspace owner invite other email addresses into the workspace so those people can view and download session data under their own identity, without giving them access to API keys, billing/quota, or audit history.

## Users

- **Owner** — the person whose email created the workspace (today's default). Continues to control API keys, quota visibility, member list, and workspace lifecycle.
- **Member** — an invited teammate (mentor, student, alum). Signs in with their own email; sees session list and downloads `.wpilog` files only.

A single email can be Owner of their own workspace and Member of one or more others simultaneously. The canonical example: a mentor who coaches Team 1310 and Team 9999, and keeps their personal workspace for experiments.

## Core behavior

### Roles and access

Two tiers, no per-session ACLs:

| Capability                              | Owner | Member |
|-----------------------------------------|:-----:|:------:|
| View session list                       |   ✓   |   ✓    |
| Download `.wpilog`                      |   ✓   |   ✓    |
| View / mint / revoke API keys           |   ✓   |        |
| See workspace quota / usage             |   ✓   |        |
| See audit log                           |   ✓   |        |
| Invite, remove, change role of members  |   ✓   |        |
| Delete sessions                         |   ✓   |        |
| Transfer ownership / delete workspace   |   ✓   |        |

Members explicitly do **not** see API key prefixes, last-used-at, or quota dashboards. The tightest possible viewer scope is the default because it matches the literal user request and avoids leaking operational surface area to students who only need to watch matches.

### Multi-workspace membership

- An authenticated user can belong to multiple workspaces. The active workspace lives on the session and is switchable via a workspace picker in the UI shell.
- All existing workspace-scoped routes (`/api/sessions/*`, `/api/api-keys/*`, etc.) must authorize against the active workspace + membership + role, not just the session's user.
- The bearer-token telemetry ingest path (`/api/telemetry/*`) continues to authorize by API key → workspace, unchanged. Members do **not** carry their own API keys.

### Invite flow

1. Owner opens workspace settings → Members → enters an email address.
2. Worker creates a pending invite row (email, workspace_id, role=member, token_hash, 7-day expiry, invited_by_user_id).
3. Resend sends a one-click accept link (`/accept-invite?token=…`). Reuses the existing Resend sender and the login-token TTL pattern.
4. Clicking the link:
   - If the invitee has no user row yet: create it, create the membership, sign them in (magic-link style, single flow), land on the invited workspace.
   - If the invitee already has a user row: on next sign-in (or immediate click-through if already signed in), create the membership, switch their active workspace to the new one, confirm with a "You joined `<workspace>`" toast.
5. The pending invite is marked `accepted_at` and cannot be reused.
6. Expired or revoked tokens return a clear error page and invite the user to ask for a fresh link.

### Invite management

Owner-side UI surfaces:

- **Members list** — email, role, joined date, "Remove" action. Removing a member is instant: their next authenticated request against that workspace fails the membership check, the workspace disappears from their switcher, and any existing cookie session for that workspace falls back to their default workspace.
- **Pending invites list** — email, sent date, expiry, "Resend" and "Revoke" actions. Resending rotates the token and resets the 7-day clock. Revoking invalidates the token immediately.
- **Transfer ownership** — promotes a selected member to Owner and demotes the current Owner to Member. Irreversible without the new Owner doing the reverse.
- **Leave workspace** — available for non-sole-owners. A sole Owner cannot leave; the UI blocks the action and prompts them to either transfer ownership first, or delete the workspace (which cascades sessions, batches, API keys, and memberships).

### Audit events

New audit event types recorded on the existing `audit_log` table:

- `workspace.member_invited` (actor=owner, metadata: invited_email, role)
- `workspace.invite_revoked`
- `workspace.invite_accepted` (actor=new member)
- `workspace.member_removed`
- `workspace.member_left`
- `workspace.ownership_transferred` (metadata: from_user_id, to_user_id)

## Non-goals (for this iteration)

- **Per-session or per-time-range ACLs.** Members see all sessions in the workspace or none. Deferred until we see a real request for finer-grained sharing.
- **Admin tier between Owner and Member.** Two tiers covers the stated need; a third tier is easy to add later if owners ask for "let students manage their own API keys."
- **Cross-workspace session sharing.** No Google-Docs-style "share this one session with anybody." Tenancy stays at the workspace boundary.
- **SSO / domain-based auto-join.** No "anyone @team1310.ca can join." Explicit invites only.
- **Email change / account merge.** If an invited email differs from the user's canonical email, that's a new user. Out of scope.
- **Notification preferences.** No per-user email settings beyond the invite itself.

## Success criteria

- A workspace owner can invite a teammate by email, and that teammate can sign in (first-time or returning) and see session data for that workspace without ever touching the owner's login.
- A member sees the workspace in a switcher alongside any other workspaces they belong to, can switch between them, and never sees API keys, quota, or the audit log for any of them (unless they own one).
- An owner can remove a member or revoke a pending invite and the effect is immediate (next request from the removed member fails authz).
- A sole owner cannot accidentally leave their workspace; the only exit paths are explicit ownership transfer or explicit workspace deletion.
- `audit_log` contains a row for every invite, revoke, accept, remove, leave, and ownership transfer, with actor and workspace set correctly.
- Existing single-seat users see no behavioral change until they invite someone. All existing telemetry ingest, session list, and download paths continue to work with no API-surface changes for them.

## Open questions for planning

These are implementation-shape decisions deferred to `/ce-plan`:

- Session cookie shape: extend the signed cookie to carry `{userId, activeWorkspaceId}` vs. look up active workspace on each request.
- Invite token storage: reuse `login_tokens` shape or new `workspace_invites` table (likely the latter, to carry workspace_id + invited_by + role).
- Workspace switcher UX: dropdown in app shell vs. `/workspaces` landing page.
- Rate limiting on invite sends: per-workspace quota via the existing `RateLimitDO`.
- Backfill: every existing `workspaces` row needs a `workspace_members` entry with `role=owner` for the current `owner_user_id` during migration.
- Whether to keep `workspaces.owner_user_id` as a denormalized pointer or derive "owner" purely from `workspace_members.role`.

## Dependencies and assumptions

- **Resend sender is already verified** (per `67d7d33 config: free-plan DO migration + verified Resend sender`) — invites reuse the same transactional-email path as magic links.
- **D1 free-plan limits** — adding one new table (`workspace_members`) and one new table (`workspace_invites`) stays well under the D1 row / DB-size ceiling.
- **Audit log retention** — current `audit_log` table has no retention policy; adding ~5 new event types increases volume modestly. Flag for the quota/caps work already in flight (see `docs/plans/2026-04-23-001-feat-daily-usage-caps-plan.md`).
- **No UI design exists yet for the members surface.** `docs/design/ravenscope-ui.pen` will need a new screen for workspace settings → Members.
