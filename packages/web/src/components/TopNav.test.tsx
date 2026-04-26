import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as apiModule from "../lib/api"
import type { UserMeResponse } from "../lib/api"
import { TopNav } from "./TopNav"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function wrap(me: UserMeResponse | null, ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  // Pre-seed the ["me"] cache so useMe returns immediately in tests.
  qc.setQueryData(["me"], me)
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

function meResponse(overrides: Partial<UserMeResponse> = {}): UserMeResponse {
  const active = overrides.activeWorkspace ?? {
    id: "ws-a",
    name: "Test Workspace",
    role: "owner" as const,
  }
  const workspaces =
    overrides.workspaces ?? ([active] as UserMeResponse["workspaces"])
  return {
    userId: "u-1",
    email: "owner@example.test",
    workspaceId: active.id,
    workspaceName: active.name,
    activeWorkspace: active,
    workspaces,
    ...overrides,
  }
}

describe("TopNav", () => {
  beforeEach(() => {
    // JSDOM doesn't implement hasPointerCapture/scrollIntoView which Radix
    // DropdownMenu uses internally.
    if (!Element.prototype.hasPointerCapture) {
      ;(Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture =
        () => false
    }
    if (!Element.prototype.scrollIntoView) {
      ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
    }
  })

  it("owner with 2 workspaces: dropdown lists both, active one is checked, role badges shown, API Keys tab present", async () => {
    const user = userEvent.setup()
    const me = meResponse({
      activeWorkspace: { id: "ws-a", name: "Test Workspace", role: "owner" },
      workspaces: [
        { id: "ws-a", name: "Test Workspace", role: "owner" },
        { id: "ws-b", name: "Team 254 Scouting", role: "member" },
      ],
    })
    render(wrap(me, <TopNav />))

    // API Keys nav tab visible for owner.
    expect(screen.getByRole("link", { name: /API Keys/i })).toBeDefined()
    expect(screen.getByRole("link", { name: /Sessions/i })).toBeDefined()

    await user.click(screen.getByRole("button", { name: /Switch workspace/i }))

    await waitFor(() => {
      // Both workspace entries appear in the menu.
      expect(screen.getByRole("menuitem", { name: /Test Workspace/i })).toBeDefined()
      expect(screen.getByRole("menuitem", { name: /Team 254 Scouting/i })).toBeDefined()
    })
    // Role badges.
    expect(screen.getByText("Owner")).toBeDefined()
    expect(screen.getByText("Member")).toBeDefined()

    // The active one has a check-mark (lucide-check renders an <svg class="lucide-check">).
    const activeItem = screen.getByRole("menuitem", { name: /Test Workspace/i })
    expect(activeItem.querySelector("svg")).not.toBeNull()
    // The inactive entry has no check-mark svg.
    const inactiveItem = screen.getByRole("menuitem", { name: /Team 254 Scouting/i })
    expect(inactiveItem.querySelector("svg")).toBeNull()
  })

  it("member: API Keys nav tab is absent; Sessions tab present", () => {
    const me = meResponse({
      activeWorkspace: { id: "ws-a", name: "Test Workspace", role: "member" },
      workspaces: [{ id: "ws-a", name: "Test Workspace", role: "member" }],
    })
    render(wrap(me, <TopNav />))

    expect(screen.queryByRole("link", { name: /API Keys/i })).toBeNull()
    expect(screen.getByRole("link", { name: /Sessions/i })).toBeDefined()
  })

  it("single-workspace owner: dropdown still renders with one checked entry", async () => {
    const user = userEvent.setup()
    const me = meResponse({
      activeWorkspace: { id: "ws-solo", name: "Solo Workspace", role: "owner" },
      workspaces: [{ id: "ws-solo", name: "Solo Workspace", role: "owner" }],
    })
    render(wrap(me, <TopNav />))

    const trigger = screen.getByRole("button", { name: /Switch workspace/i })
    await user.click(trigger)

    await waitFor(() => {
      const item = screen.getByRole("menuitem", { name: /Solo Workspace/i })
      expect(item).toBeDefined()
      // Check-mark present on the single active entry.
      expect(item.querySelector("svg")).not.toBeNull()
    })
  })

  it("clicking an inactive workspace calls switchWorkspace then window.location.assign('/')", async () => {
    const user = userEvent.setup()
    const switchSpy = vi
      .spyOn(apiModule, "switchWorkspace")
      .mockResolvedValue(undefined)
    // JSDOM's `location` object disallows redefining individual members.
    // Replace the whole `location` on `window` with a stub that carries an
    // `assign` spy, then restore the original after the test.
    const realLocation = window.location
    const assignSpy = vi.fn()
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...realLocation, assign: assignSpy, href: realLocation.href },
    })

    const me = meResponse({
      activeWorkspace: { id: "ws-a", name: "Test Workspace", role: "owner" },
      workspaces: [
        { id: "ws-a", name: "Test Workspace", role: "owner" },
        { id: "ws-b", name: "Team 254 Scouting", role: "member" },
      ],
    })
    render(wrap(me, <TopNav />))

    await user.click(screen.getByRole("button", { name: /Switch workspace/i }))
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: /Team 254 Scouting/i })).toBeDefined(),
    )
    await user.click(screen.getByRole("menuitem", { name: /Team 254 Scouting/i }))

    await waitFor(() => expect(switchSpy).toHaveBeenCalledWith("ws-b"))
    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith("/"))

    // Restore the real location object.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: realLocation,
    })
  })
})
