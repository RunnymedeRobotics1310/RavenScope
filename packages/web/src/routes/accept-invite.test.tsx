import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../lib/api", () => ({
  acceptInvite: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
  fetchMe: vi.fn(),
}))

import * as api from "../lib/api"
import { AcceptInvite } from "./accept-invite"

const mocked = api as unknown as {
  acceptInvite: ReturnType<typeof vi.fn>
  logout: ReturnType<typeof vi.fn>
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function wrap(initialRoute: string, ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialRoute]}>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

function stubLocation() {
  const real = window.location
  const assignSpy = vi.fn()
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...real, assign: assignSpy, href: real.href },
  })
  return {
    assignSpy,
    restore: () =>
      Object.defineProperty(window, "location", {
        configurable: true,
        value: real,
      }),
  }
}

describe("AcceptInvite", () => {
  it("happy path: acceptInvite resolves → window.location.assign('/')", async () => {
    mocked.acceptInvite.mockResolvedValue(undefined)
    const loc = stubLocation()

    render(wrap("/accept-invite?token=abc", <AcceptInvite />))

    await waitFor(() =>
      expect(mocked.acceptInvite).toHaveBeenCalledWith("abc"),
    )
    await waitFor(() => expect(loc.assignSpy).toHaveBeenCalledWith("/"))

    loc.restore()
  })

  it("expired token renders the 'expired' error copy", async () => {
    mocked.acceptInvite.mockRejectedValue(new Error("token_expired"))

    render(wrap("/accept-invite?token=abc", <AcceptInvite />))

    await waitFor(() =>
      expect(screen.getByText(/This invite has expired/)).toBeDefined(),
    )
  })

  it("email_mismatch shows a Sign out affordance", async () => {
    mocked.acceptInvite.mockRejectedValue(new Error("email_mismatch"))
    const loc = stubLocation()

    render(wrap("/accept-invite?token=abc", <AcceptInvite />))

    await waitFor(() =>
      expect(screen.getByText(/Wrong account signed in/)).toBeDefined(),
    )
    const signOut = screen.getByRole("button", {
      name: /Sign out and try again/,
    })

    const user = userEvent.setup()
    await user.click(signOut)
    await waitFor(() => expect(mocked.logout).toHaveBeenCalled())
    await waitFor(() => expect(loc.assignSpy).toHaveBeenCalled())

    loc.restore()
  })

  it("already_member shows 'You're already a member' with a link to home", async () => {
    mocked.acceptInvite.mockRejectedValue(new Error("already_member"))

    render(wrap("/accept-invite?token=abc", <AcceptInvite />))

    await waitFor(() =>
      expect(
        screen.getByText(/You're already a member of this workspace/),
      ).toBeDefined(),
    )
    const link = screen.getByRole("link", { name: /Go to your workspace/ })
    expect(link.getAttribute("href")).toBe("/")
  })

  it("missing token renders 'Missing token' without hitting the API", async () => {
    render(wrap("/accept-invite", <AcceptInvite />))
    await waitFor(() =>
      expect(screen.getByText(/Missing token/)).toBeDefined(),
    )
    expect(mocked.acceptInvite).not.toHaveBeenCalled()
  })
})
