import { render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "./app"

/**
 * Smoke test: mount <App/> under jsdom and assert the UI paints
 * something — the original "blank page" bug would have been caught here
 * because a throwing App would leave #root empty.
 *
 * /api/auth/me is stubbed to 401 so the AuthGate redirects to /sign-in;
 * we then assert the sign-in form is visible.
 */
describe("App smoke", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    // Ensure the initial route starts at `/` so AuthGate engages.
    window.history.replaceState(null, "", "/")
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.endsWith("/api/auth/me")) {
        return new Response(null, { status: 401 })
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
    }) as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it("mounts without throwing and renders the sign-in page when unauthenticated", async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /sign in/i })).toBeDefined()
    })
    // The email input is on the page.
    expect(screen.getByLabelText(/email/i)).toBeDefined()
    // Submit button is present with the exact mockup label.
    expect(screen.getByRole("button", { name: /send me a sign-in link/i })).toBeDefined()
  })
})
