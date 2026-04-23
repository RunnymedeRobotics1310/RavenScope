import { render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ErrorBoundary } from "./ErrorBoundary"

// React (in dev) logs caught errors to console.error. Silence them so the
// test output stays clean — the boundary itself also logs via
// componentDidCatch, which the silencing covers.
let consoleSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  consoleSpy.mockRestore()
})

function Boom({ when }: { when: boolean }) {
  if (when) throw new Error("kaboom — fixture failure")
  return <span>All good</span>
}

describe("ErrorBoundary", () => {
  it("renders its children verbatim when no error is thrown", () => {
    render(
      <ErrorBoundary>
        <Boom when={false} />
      </ErrorBoundary>,
    )
    expect(screen.getByText("All good")).toBeDefined()
    expect(screen.queryByText(/Something broke/i)).toBeNull()
  })

  it("catches a render error and shows a readable fallback + stack", () => {
    render(
      <ErrorBoundary>
        <Boom when />
      </ErrorBoundary>,
    )
    expect(screen.getByText(/Something broke/i)).toBeDefined()
    expect(screen.getByText(/kaboom — fixture failure/)).toBeDefined()
    // The reload button is present so the user can recover.
    expect(screen.getByRole("button", { name: /reload/i })).toBeDefined()
  })
})
