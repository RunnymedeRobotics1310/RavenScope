import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import type { KeyTreeNode } from "../lib/api"
import { KeyTree } from "./KeyTree"

function leaf(path: string, name: string, ntType = "double", sampleCount = 1): KeyTreeNode {
  return {
    path,
    name,
    children: [],
    ntType,
    sampleCount,
    firstTs: "2026-04-22T18:00:00.000Z",
    lastTs: "2026-04-22T18:00:01.000Z",
  }
}

function branch(path: string, name: string, children: KeyTreeNode[]): KeyTreeNode {
  return { path, name, children }
}

describe("KeyTree", () => {
  it("renders the empty-state card when there are no keys", () => {
    render(<KeyTree nodes={[]} />)
    expect(screen.getByText(/No keys captured/i)).toBeDefined()
  })

  it("renders a 3-level tree with expand/collapse at nested levels", async () => {
    const user = userEvent.setup()
    const nodes: KeyTreeNode[] = [
      branch("/SmartDashboard", "SmartDashboard", [
        branch("/SmartDashboard/Drivetrain", "Drivetrain", [
          leaf("/SmartDashboard/Drivetrain/Pose", "Pose", "double[]", 1247),
        ]),
      ]),
    ]
    render(<KeyTree nodes={nodes} />)

    // Root is auto-open; child branch "Drivetrain" is initially closed.
    expect(screen.getByText("Drivetrain")).toBeDefined()
    expect(screen.queryByText("Pose")).toBeNull()

    await user.click(screen.getByText("Drivetrain"))
    expect(screen.getByText("Pose")).toBeDefined()
    expect(screen.getByText("double[]")).toBeDefined()
    expect(screen.getByText(/1,247 samples/)).toBeDefined()
  })

  it("filter auto-expands ancestors so nested hits become visible", () => {
    const nodes: KeyTreeNode[] = [
      branch("/SmartDashboard", "SmartDashboard", [
        branch("/SmartDashboard/Drivetrain", "Drivetrain", [
          leaf("/SmartDashboard/Drivetrain/Pose", "Pose"),
          leaf("/SmartDashboard/Drivetrain/Velocity", "Velocity"),
        ]),
        branch("/SmartDashboard/Arm", "Arm", [leaf("/SmartDashboard/Arm/Angle", "Angle")]),
      ]),
    ]
    render(<KeyTree nodes={nodes} search="pose" />)
    // Pose visible without any click (filter forced its ancestors open).
    expect(screen.queryAllByText("Pose").length).toBeGreaterThan(0)
    // Siblings whose paths don't contain "pose" are hidden.
    expect(screen.queryByText("Velocity")).toBeNull()
    expect(screen.queryByText("Angle")).toBeNull()
  })

  it("does not collapse a single-segment path like '/SmartDashboard/.schema/foo'", () => {
    const nodes: KeyTreeNode[] = [
      branch("/SmartDashboard", "SmartDashboard", [
        branch("/SmartDashboard/.schema", ".schema", [
          leaf("/SmartDashboard/.schema/foo", "foo"),
        ]),
      ]),
    ]
    render(<KeyTree nodes={nodes} />)
    // Root is open by default, so .schema should be visible.
    expect(screen.getByText(".schema")).toBeDefined()
  })
})
