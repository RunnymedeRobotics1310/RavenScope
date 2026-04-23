import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EditableText } from "./EditableText"

// vitest with globals: false doesn't auto-unmount between tests — left-
// over DOM makes getByRole('button') find prior renders too.
afterEach(cleanup)

describe("EditableText", () => {
  it("shows the value as a clickable trigger in read mode", () => {
    render(
      <EditableText
        value="Ontario District"
        placeholder="event name"
        ariaLabel="Edit event name"
        onCommit={vi.fn()}
      />,
    )
    expect(screen.getByRole("button", { name: /Edit event name/i })).toBeDefined()
    expect(screen.getByText("Ontario District")).toBeDefined()
  })

  it("shows the placeholder when value is null", () => {
    render(<EditableText value={null} placeholder="Add event name" onCommit={vi.fn()} />)
    expect(screen.getByText("Add event name")).toBeDefined()
  })

  it("opens input on click, commits on Enter", async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(<EditableText value="old" placeholder="event name" onCommit={onCommit} />)
    await user.click(screen.getByRole("button"))
    const input = screen.getByRole("textbox") as HTMLInputElement
    await user.tripleClick(input)
    await user.keyboard("Ontario District")
    await user.keyboard("{Enter}")
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("Ontario District"))
  })

  it("Escape cancels without committing", async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<EditableText value="old" placeholder="p" onCommit={onCommit} />)
    await user.click(screen.getByRole("button"))
    await user.keyboard("{Escape}")
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByText("old")).toBeDefined()
  })

  it("committing an empty input saves null (clear)", async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(<EditableText value="old" placeholder="p" onCommit={onCommit} />)
    await user.click(screen.getByRole("button"))
    await user.tripleClick(screen.getByRole("textbox"))
    await user.keyboard("{Backspace}{Enter}")
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith(null))
  })
})
