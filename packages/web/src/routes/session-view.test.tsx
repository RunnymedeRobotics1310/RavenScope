import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SessionView } from "./session-view"

/**
 * SessionView mounts an iframe whose src is byte-equal to the value
 * produced by sessionViewerUrl(id). If this assertion drifts, the auto-
 * open contract between the web app and the AS Lite patch (?log=...)
 * has broken.
 */
describe("SessionView", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => {
      // session detail is used for the title but its absence shouldn't
      // crash the component.
      return new Response(null, { status: 401 })
    }) as typeof globalThis.fetch
  })

  afterEach(() => {
    cleanup()
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  function renderAt(path: string) {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    })
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/sessions/:id/view" element={<SessionView />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it("iframe src matches sessionViewerUrl contract (/v/:id/?log=...)", () => {
    renderAt("/sessions/abc-123/view")
    const iframe = screen.getByTitle("AdvantageScope viewer") as HTMLIFrameElement
    expect(iframe.getAttribute("src")).toBe("/v/abc-123/?log=session.wpilog")
  })

  it("iframe is sandboxed to allow-scripts + allow-same-origin (no downloads, no popups)", () => {
    renderAt("/sessions/xyz/view")
    const iframe = screen.getByTitle("AdvantageScope viewer") as HTMLIFrameElement
    const sandbox = iframe.getAttribute("sandbox") ?? ""
    expect(sandbox).toContain("allow-scripts")
    expect(sandbox).toContain("allow-same-origin")
    expect(sandbox).not.toContain("allow-downloads")
    expect(sandbox).not.toContain("allow-popups")
    expect(sandbox).not.toContain("allow-forms")
  })

  it("Back link points to the session detail page", () => {
    renderAt("/sessions/abc-123/view")
    const back = screen.getByRole("link", { name: /back/i }) as HTMLAnchorElement
    expect(back.getAttribute("href")).toBe("/sessions/abc-123")
  })

  it("url-encodes the :id param into the iframe src", () => {
    // Test that unusual id chars still produce a valid URL.
    renderAt("/sessions/a%20b/view")
    const iframe = screen.getByTitle("AdvantageScope viewer") as HTMLIFrameElement
    // react-router decodes %20 → space in useParams(), and our helper
    // then encodeURIComponent-s it back to %20.
    expect(iframe.getAttribute("src")).toBe("/v/a%20b/?log=session.wpilog")
  })
})
