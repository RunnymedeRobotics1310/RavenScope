import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import * as Tooltip from "@radix-ui/react-tooltip"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Mock the API module before the route imports it.
vi.mock("../lib/api", () => {
  return {
    listMembers: vi.fn(),
    removeMember: vi.fn(),
    leaveWorkspace: vi.fn(),
    transferOwnership: vi.fn(),
    deleteWorkspace: vi.fn(),
    listInvites: vi.fn(),
    sendInvite: vi.fn(),
    revokeInvite: vi.fn(),
    resendInvite: vi.fn(),
    // Used by TopNav which is rendered from the settings page.
    switchWorkspace: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    fetchMe: vi.fn().mockResolvedValue(null),
  }
})

import * as api from "../lib/api"
import type { InviteDto, MemberDto, UserMeResponse } from "../lib/api"
import { WorkspaceSettings } from "./workspace-settings"

const mocked = api as unknown as {
  listMembers: ReturnType<typeof vi.fn>
  removeMember: ReturnType<typeof vi.fn>
  leaveWorkspace: ReturnType<typeof vi.fn>
  transferOwnership: ReturnType<typeof vi.fn>
  deleteWorkspace: ReturnType<typeof vi.fn>
  listInvites: ReturnType<typeof vi.fn>
  sendInvite: ReturnType<typeof vi.fn>
  revokeInvite: ReturnType<typeof vi.fn>
  resendInvite: ReturnType<typeof vi.fn>
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

beforeEach(() => {
  // Radix Dialog + Tooltip use pointer-capture / scrollIntoView which JSDOM
  // doesn't provide.
  if (!Element.prototype.hasPointerCapture) {
    ;(Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture =
      () => false
  }
  if (!Element.prototype.scrollIntoView) {
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  }
})

function meFor(role: "owner" | "member"): UserMeResponse {
  const active = { id: "ws-a", name: "Team 1310 Shop", role }
  return {
    userId: "u-1",
    email: "jeff@team1310.ca",
    workspaceId: active.id,
    workspaceName: active.name,
    activeWorkspace: active,
    workspaces: [active],
  }
}

function wrap(me: UserMeResponse | null, ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  qc.setQueryData(["me"], me)
  return (
    <QueryClientProvider client={qc}>
      <Tooltip.Provider delayDuration={0}>
        <MemoryRouter>{ui}</MemoryRouter>
      </Tooltip.Provider>
    </QueryClientProvider>
  )
}

function seedMembers(members: MemberDto[]) {
  mocked.listMembers.mockResolvedValue(members)
}
function seedInvites(invites: InviteDto[]) {
  mocked.listInvites.mockResolvedValue(invites)
}

function member(
  userId: string,
  email: string,
  role: "owner" | "member",
): MemberDto {
  return {
    userId,
    email,
    role,
    joinedAt: Date.parse("2025-01-02T00:00:00Z"),
    invitedByUserId: null,
  }
}

function invite(id: string, email: string): InviteDto {
  return {
    id,
    invitedEmail: email,
    role: "member",
    createdAt: Date.parse("2025-03-01T00:00:00Z"),
    expiresAt: Date.parse("2025-03-08T00:00:00Z"),
    invitedByUserId: null,
  }
}

describe("WorkspaceSettings — owner view", () => {
  it("renders all three sections with seeded data", async () => {
    seedMembers([
      member("u-1", "jeff@team1310.ca", "owner"),
      member("u-2", "coach@team1310.ca", "member"),
    ])
    seedInvites([invite("inv-1", "student@team1310.ca")])

    render(wrap(meFor("owner"), <WorkspaceSettings />))

    await waitFor(() =>
      expect(screen.getByText("coach@team1310.ca")).toBeDefined(),
    )
    expect(screen.getByRole("heading", { name: /Members/ })).toBeDefined()
    expect(screen.getByRole("heading", { name: /Pending invites/ })).toBeDefined()
    expect(screen.getByRole("heading", { name: /Danger zone/ })).toBeDefined()
    expect(screen.getByText("student@team1310.ca")).toBeDefined()
  })

  it("Remove member: confirmation dialog → API call on confirm", async () => {
    const user = userEvent.setup()
    seedMembers([
      member("u-1", "jeff@team1310.ca", "owner"),
      member("u-2", "coach@team1310.ca", "member"),
    ])
    seedInvites([])
    mocked.removeMember.mockResolvedValue(undefined)

    render(wrap(meFor("owner"), <WorkspaceSettings />))

    await waitFor(() =>
      expect(screen.getByText("coach@team1310.ca")).toBeDefined(),
    )
    await user.click(screen.getByRole("button", { name: /^Remove$/ }))

    // Dialog appears.
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: /Remove coach@team1310\.ca/ }),
      ).toBeDefined(),
    )
    const dialog = screen.getByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: /^Remove$/ }))

    await waitFor(() =>
      expect(mocked.removeMember).toHaveBeenCalledWith("ws-a", "u-2"),
    )
  })

  it("Make owner: strong confirmation copy → API call", async () => {
    const user = userEvent.setup()
    seedMembers([
      member("u-1", "jeff@team1310.ca", "owner"),
      member("u-2", "coach@team1310.ca", "member"),
    ])
    seedInvites([])
    mocked.transferOwnership.mockResolvedValue(undefined)

    render(wrap(meFor("owner"), <WorkspaceSettings />))

    await waitFor(() =>
      expect(screen.getByText("coach@team1310.ca")).toBeDefined(),
    )
    await user.click(screen.getByRole("button", { name: /Make owner/ }))

    await waitFor(() =>
      expect(screen.getByRole("dialog")).toBeDefined(),
    )
    const dialog = screen.getByRole("dialog")
    expect(
      within(dialog).getByText(/You will become a Member/),
    ).toBeDefined()
    await user.click(
      within(dialog).getByRole("button", { name: /Transfer ownership/ }),
    )

    await waitFor(() =>
      expect(mocked.transferOwnership).toHaveBeenCalledWith("ws-a", "u-2"),
    )
  })

  it("sole owner: Leave workspace on own row is disabled (no button, tooltip span)", async () => {
    seedMembers([member("u-1", "jeff@team1310.ca", "owner")])
    seedInvites([])

    render(wrap(meFor("owner"), <WorkspaceSettings />))

    await waitFor(() =>
      expect(screen.getByText(/jeff@team1310\.ca/)).toBeDefined(),
    )
    // The label "Leave workspace" appears but there is no button for it —
    // it's a disabled span wrapped in a tooltip trigger.
    expect(screen.queryByRole("button", { name: /Leave workspace/ })).toBeNull()
    const stub = screen.getByText("Leave workspace")
    expect(stub.textContent).toContain("Leave workspace")
  })

  it("Danger zone: typing name enables Delete → API call on confirm", async () => {
    const user = userEvent.setup()
    seedMembers([member("u-1", "jeff@team1310.ca", "owner")])
    seedInvites([])
    mocked.deleteWorkspace.mockResolvedValue(undefined)

    // Stub window.location.assign.
    const realLocation = window.location
    const assignSpy = vi.fn()
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...realLocation, assign: assignSpy, href: realLocation.href },
    })

    render(wrap(meFor("owner"), <WorkspaceSettings />))

    await waitFor(() =>
      expect(screen.getByText(/jeff@team1310\.ca/)).toBeDefined(),
    )
    // Open the delete dialog.
    const openBtn = screen
      .getAllByRole("button", { name: /Delete workspace/ })
      .find((b) => !b.closest('[role="dialog"]'))!
    await user.click(openBtn)

    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined())
    const dialog = screen.getByRole("dialog")
    const confirmBtn = within(dialog).getByRole("button", {
      name: /Delete workspace/,
    })
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true)

    const input = within(dialog).getByLabelText(/Workspace name confirmation/)
    await user.type(input, "Team 1310 Shop")
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(false)

    await user.click(confirmBtn)

    await waitFor(() =>
      expect(mocked.deleteWorkspace).toHaveBeenCalledWith("ws-a"),
    )
    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith("/"))

    Object.defineProperty(window, "location", {
      configurable: true,
      value: realLocation,
    })
  })

  it("sending an invite invalidates the list so new row is fetched", async () => {
    const user = userEvent.setup()
    seedMembers([member("u-1", "jeff@team1310.ca", "owner")])
    // First call returns empty; after mutate succeeds, react-query invalidates
    // and the second call returns the new row.
    mocked.listInvites
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([invite("inv-1", "coach@team1310.ca")])
    mocked.sendInvite.mockResolvedValue({
      id: "inv-1",
      invitedEmail: "coach@team1310.ca",
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 864e5,
    })

    render(wrap(meFor("owner"), <WorkspaceSettings />))

    await waitFor(() => expect(screen.getByText(/No pending invites/)).toBeDefined())
    await user.type(
      screen.getByPlaceholderText(/teammate@example\.com/),
      "coach@team1310.ca",
    )
    await user.click(screen.getByRole("button", { name: /Send invite/ }))

    await waitFor(() =>
      expect(mocked.sendInvite).toHaveBeenCalledWith("ws-a", "coach@team1310.ca"),
    )
    await waitFor(() =>
      expect(screen.getByText("coach@team1310.ca")).toBeDefined(),
    )
  })

  it("revoking a pending invite: confirmation → API call", async () => {
    const user = userEvent.setup()
    seedMembers([member("u-1", "jeff@team1310.ca", "owner")])
    seedInvites([invite("inv-1", "coach@team1310.ca")])
    mocked.revokeInvite.mockResolvedValue(undefined)

    render(wrap(meFor("owner"), <WorkspaceSettings />))

    await waitFor(() =>
      expect(screen.getByText("coach@team1310.ca")).toBeDefined(),
    )
    await user.click(screen.getByRole("button", { name: /^Revoke$/ }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined())
    const dialog = screen.getByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: /^Revoke$/ }))

    await waitFor(() =>
      expect(mocked.revokeInvite).toHaveBeenCalledWith("ws-a", "inv-1"),
    )
  })

  it("resending an invite fires immediately without confirmation", async () => {
    const user = userEvent.setup()
    seedMembers([member("u-1", "jeff@team1310.ca", "owner")])
    seedInvites([invite("inv-1", "coach@team1310.ca")])
    mocked.resendInvite.mockResolvedValue(undefined)

    render(wrap(meFor("owner"), <WorkspaceSettings />))

    await waitFor(() =>
      expect(screen.getByText("coach@team1310.ca")).toBeDefined(),
    )
    await user.click(screen.getByRole("button", { name: /^Resend$/ }))

    await waitFor(() =>
      expect(mocked.resendInvite).toHaveBeenCalledWith("ws-a", "inv-1"),
    )
    // No confirmation dialog surfaced between click and the API call.
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

describe("WorkspaceSettings — member view", () => {
  it("renders a minimal Leave workspace button only", async () => {
    render(wrap(meFor("member"), <WorkspaceSettings />))

    // Page heading is the workspace name (non-owners see plain text).
    expect(
      screen.getByRole("heading", { name: /Team 1310 Shop/ }),
    ).toBeDefined()
    // Members section is not rendered.
    expect(screen.queryByRole("heading", { name: /^Members$/ })).toBeNull()
    expect(screen.queryByRole("heading", { name: /Pending invites/ })).toBeNull()
    expect(screen.queryByRole("heading", { name: /Danger zone/ })).toBeNull()
    // A leave button exists.
    expect(
      screen.getByRole("button", { name: /Leave workspace/ }),
    ).toBeDefined()
    // We never fetched the owner-only lists.
    expect(mocked.listMembers).not.toHaveBeenCalled()
    expect(mocked.listInvites).not.toHaveBeenCalled()
  })
})
