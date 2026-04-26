# RavenScope User Guide

End-to-end walkthrough for FRC teams using the hosted RavenScope
instance at **[ravenscope.team1310.ca](https://ravenscope.team1310.ca)**.

If you're self-hosting RavenScope, the URLs below change to your own
host but everything else is identical.

---

## 1. Sign in

RavenScope uses passwordless email sign-in. There are no passwords to
remember, reset, or rotate.

1. Visit [ravenscope.team1310.ca](https://ravenscope.team1310.ca).
2. Enter your email address and click **Send sign-in link**.
3. Check your inbox for an email from RavenScope. Click the link
   inside (it's valid for 15 minutes and works only once).
4. You're signed in. The first sign-in for an email also creates a
   **workspace** for you, named after your email — rename it any time
   from **Workspace settings**.

The session cookie lasts 30 days. Sign out from the avatar menu in
the top-right at any time.

> **Lost access to your email?** RavenScope has no password reset
> path because there's no password. If your email account is gone for
> good, contact a RavenScope operator with D1 access and they can
> remove the user record so you can sign up fresh from a different
> address.

---

## 2. Set up your workspace

Each user starts in a single-member workspace they own, named after
their email address. To make it your team's home, rename it and
invite the rest of the team.

### Rename your workspace

Workspace owners can rename the workspace at any time:

1. Click the workspace name in the top-right to open the workspace
   switcher.
2. Click **Workspace settings**.
3. The workspace name appears as a large heading at the top of the
   page. Click it and edit in place (e.g. change `you@team1310.ca`
   to `Team 1310`). Press **Enter** or click outside the field to
   save.

The new name shows up everywhere immediately — the top-right
switcher, invite emails for any pending invites, and audit log
entries. Members (non-owners) see the same heading as plain text
without the edit affordance.

### Invite teammates

1. From the workspace switcher (top-right), open **Workspace
   settings**.
2. Under **Members**, enter a teammate's email and click **Invite**.
3. They receive an email with a link. Clicking it signs them in (or
   signs them up) and adds them to your workspace as a **member**.
4. Invites expire after 7 days. You can resend or revoke a pending
   invite from the same screen.

### Member roles

- **Owner** — can invite, remove members, transfer ownership, delete
  the workspace, and manage API keys. Every workspace has at least
  one owner. The user who created the workspace is the initial owner.
- **Member** — can view and download sessions, save and use shared
  viewer layouts, and use the embedded viewer. Cannot invite, manage
  members, or manage API keys.

### Transfer ownership

From **Workspace settings → Members**, click **Make owner** next to
any member. The previous owner is demoted to member automatically.

### Leave a workspace

From **Workspace settings**, click **Leave workspace**. Owners can't
leave the last owner-member behind — transfer ownership first.

### Delete a workspace

Owners can delete the workspace from **Workspace settings → Danger
zone**. This is permanent and removes every session, batch, API key,
and viewer layout. Members are removed; user accounts survive.

---

## 3. Send match data with RavenLink

[RavenLink](https://github.com/RunnymedeRobotics1310/RavenLink) is the
driver-station companion that captures NetworkTables data and uploads
it to RavenScope. Out of the box, RavenLink already points at
`ravenscope.team1310.ca` — you only need to give it your workspace's
API key.

1. **Mint an API key** in RavenScope:
   - Sign in as an owner of your workspace.
   - Click **API Keys** in the top navigation.
   - Click **Create API key**, give it a name (e.g. "DS laptop"),
     and click **Create**.
   - The plaintext key (`rsk_live_…`) is displayed **once**. Copy it
     immediately — you can't view it again.
2. **Paste the key into RavenLink**. From RavenLink's dashboard
   (`http://localhost:8080` while RavenLink is running):
   - Open the **Config** tab.
   - Set `ravenscope.api_key` to the value you copied.
   - Click **Save**. RavenLink restarts itself with the new config.

That's it. Drive a match (or a practice session); the file lands in
your RavenScope **Sessions** list within a few seconds of the match
ending.

> **Lost a key?** Revoke it from the API Keys page and mint a new
> one. Revoked keys stop working immediately.

---

## 4. View sessions

The **Sessions** page lists every session uploaded to your workspace,
newest first. Each row shows session ID, team number, match label
(when present), event name (when present), and start time.

- **Filter and search** — type in the search box to filter by event,
  match label, or session ID.
- **Sort** — click any column header to sort by that field.
- **Open in viewer** — click **Open viewer** on a session to load it
  in the embedded AdvantageScope Lite instance. The whole regular
  AdvantageScope feature set is available except for video, Hoot
  format, and pop-out windows (these are documented omissions of the
  Lite build — see [ATTRIBUTION](../ATTRIBUTION.md)).
- **Download .wpilog** — click **Download** to grab a WPILog file
  for use in the desktop AdvantageScope app or any WPILib tool. The
  file is regenerated from the original JSONL batches and is
  byte-identical to RavenLink's local export.
- **Edit metadata** — click the event name field on the session
  detail page to attach a custom event name when FMS metadata is
  missing (e.g., for practice matches).
- **Delete** — owners can delete a session from its detail page.
  This removes the row, batches, and cached WPILog from R2.

---

## 5. Shared viewer layouts

Set up a tab arrangement once, save it as a named layout, and your
teammates load it with one click on any device.

### Save your current layout

1. Open any session in the viewer.
2. Arrange tabs, sidebar widths, and field selections to taste.
3. Open the **Layouts** menu in the viewer header → **Save current as
   new layout…**
4. Name it (e.g. "Match review", "Auto debug") and click **Save**.

The layout is now visible to every member of your workspace.

### Load a teammate's layout

In the **Layouts** menu, hover **Load layout…** and pick one. The
viewer applies it immediately — no reload.

### Pick your default

Each user picks their own default layout. From the **Layouts** menu,
hover **Set as my default** and pick one. The next time you open the
viewer (any session, any device, any browser), that layout loads
automatically.

> **One-layout shortcut.** If your workspace has exactly one saved
> layout and you haven't picked a default, that layout is treated as
> your default automatically. New teammates land on it without
> needing to set anything. The behavior dissolves as soon as a second
> layout exists.

### Manage layouts

From **Layouts → Manage layouts…**, you can rename or delete any
workspace layout. Deleting a layout someone else has chosen as their
default silently demotes them to last-used — it doesn't break
anything for them.

### Last-used as fallback

If you haven't picked a default and there's no single-layout
shortcut, the viewer remembers your last-used layout per device.
Adjust the sidebar, switch tabs, and the next time you open the
viewer it picks up where you left off — across browsers, devices,
and incognito sessions.

---

## 6. Common questions

**Can my whole team see each other's sessions?**
Yes — every workspace member sees every session in that workspace.
Use separate workspaces if you want hard isolation.

**How long is data retained?**
Indefinitely on the hosted instance. Owners can delete individual
sessions or the entire workspace at any time.

**Does RavenScope record video?**
No. RavenScope ingests NetworkTables data only. RavenLink can
control OBS for local match recording but the video stays on the
driver-station laptop — RavenScope doesn't host video.

**Is my data shared with anyone?**
No. Workspace data is visible only to its members. Operators with
Cloudflare D1 access can technically see raw data for support
purposes; ask for the privacy policy if that matters for your team.

**What about FMS / FRC-API enrichment?**
RavenScope shows only the FMS metadata RavenLink captures during the
match. There's no FRC-API join, tournament/match enrichment, or
playoff bracket integration. If you want that, see
[RavenBrain](https://github.com/RunnymedeRobotics1310/RavenBrain).

**Can I run RavenScope on my own infrastructure?**
Yes — see [DEVELOPMENT.md](DEVELOPMENT.md) for the Cloudflare
deployment walkthrough. The codebase is BSD-3-Clause; you can
self-host without restrictions.

**I see "Embedded AdvantageScope Lite is beta-track" — what does that
mean?**
The embedded viewer pins a pre-release AdvantageScope `v27.x` Lite
build (2027 season target). It's stable enough for daily use but a
few AdvantageScope features (video tab, Phoenix Diagnostics, Hoot
format, XR, pop-out windows, layout JSON export) are intentionally
absent in the Lite distribution. Use the desktop AdvantageScope on a
downloaded `.wpilog` if you need any of those.

---

## Reporting issues

File issues at the [RavenScope GitHub
repository](https://github.com/RunnymedeRobotics1310/RavenScope/issues).
Please include the session ID (when relevant), your browser, and
what you were doing when the problem occurred.

For privacy-sensitive reports, reach out to a RavenScope operator
directly rather than filing a public issue.
