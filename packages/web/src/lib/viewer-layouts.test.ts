import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyLayoutToIframe, captureCurrentState } from "./viewer-layouts"

/**
 * captureCurrentState(iframe) is the trickiest surface in U4 — it
 * emits a postMessage to the iframe's contentWindow and resolves when
 * a matching reply lands. Rejects on timeout or cross-origin noise.
 *
 * The test harness simulates the iframe by giving the returned
 * contentWindow's postMessage a handler that echoes a state-response
 * back into the parent via window.postMessage.
 */
function makeFakeIframe(
  handler: (data: unknown) => unknown | "no-reply",
): HTMLIFrameElement {
  const iframe = document.createElement("iframe")
  // Fake the contentWindow to intercept postMessage calls. We can't
  // reassign a real iframe's contentWindow, so stub the getter.
  const fakeWin = {
    postMessage(data: unknown) {
      const reply = handler(data)
      if (reply === "no-reply") return
      // Dispatch a MessageEvent on the actual window, setting
      // event.source to our fake contentWindow so the handler's
      // event.source check passes.
      const ev = new MessageEvent("message", {
        data: reply,
        origin: window.location.origin,
        source: fakeWin as unknown as MessageEventSource,
      })
      window.dispatchEvent(ev)
    },
  } as Partial<Window>
  Object.defineProperty(iframe, "contentWindow", {
    configurable: true,
    get: () => fakeWin,
  })
  return iframe
}

describe("captureCurrentState", () => {
  beforeEach(() => {
    vi.useRealTimers()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("resolves with the state the iframe echoes back", async () => {
    const state = { tabs: { selected: 1, tabs: [] }, sidebar: { width: 200, expanded: [] } }
    const iframe = makeFakeIframe((data) => {
      const msg = data as { type?: string; kind?: string; reqId?: string }
      if (msg.type !== "ravenscope:viewer" || msg.kind !== "get-state") return "no-reply"
      return {
        type: "ravenscope:viewer",
        kind: "state-response",
        reqId: msg.reqId,
        state,
      }
    })
    await expect(captureCurrentState(iframe)).resolves.toEqual(state)
  })

  it("rejects with capture_timeout when the iframe never responds", async () => {
    vi.useFakeTimers()
    const iframe = makeFakeIframe(() => "no-reply")
    const promise = captureCurrentState(iframe)
    // Attach the rejection assertion eagerly so the fake-timer advance
    // does not surface as an unhandled rejection.
    const assertion = expect(promise).rejects.toThrow("capture_timeout")
    await vi.advanceTimersByTimeAsync(3100)
    await assertion
  })

  it("ignores responses carrying a different reqId", async () => {
    vi.useFakeTimers()
    const iframe = makeFakeIframe((data) => {
      const msg = data as { type?: string; kind?: string }
      if (msg.kind !== "get-state") return "no-reply"
      // Send a state-response with the wrong reqId; it should be ignored.
      return {
        type: "ravenscope:viewer",
        kind: "state-response",
        reqId: "wrong",
        state: { decoy: true },
      }
    })
    const promise = captureCurrentState(iframe)
    const assertion = expect(promise).rejects.toThrow("capture_timeout")
    // Let the mismatched response drain...
    await vi.advanceTimersByTimeAsync(10)
    // ...and then the real timeout should fire.
    await vi.advanceTimersByTimeAsync(3100)
    await assertion
  })

  it("ignores responses whose event.source is a different window", async () => {
    vi.useFakeTimers()
    const iframe = makeFakeIframe(() => "no-reply")
    const promise = captureCurrentState(iframe)
    const assertion = expect(promise).rejects.toThrow("capture_timeout")
    // Simulate noise from an unrelated window.
    const ev = new MessageEvent("message", {
      data: {
        type: "ravenscope:viewer",
        kind: "state-response",
        reqId: "any",
        state: { decoy: true },
      },
      origin: window.location.origin,
      source: window as unknown as MessageEventSource,
    })
    window.dispatchEvent(ev)
    await vi.advanceTimersByTimeAsync(3100)
    await assertion
  })
})

describe("applyLayoutToIframe", () => {
  it("posts an apply-state message to the iframe contentWindow", () => {
    const received: unknown[] = []
    const iframe = document.createElement("iframe")
    const fakeWin = {
      postMessage(data: unknown) {
        received.push(data)
      },
    } as Partial<Window>
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      get: () => fakeWin,
    })
    const state = { marker: "apply" }
    applyLayoutToIframe(iframe, state)
    expect(received).toEqual([
      { type: "ravenscope:viewer", kind: "apply-state", state },
    ])
  })
})
