import * as RadixTooltip from "@radix-ui/react-tooltip"
import type { ReactNode } from "react"

interface TooltipProps {
  label: string
  children: ReactNode
  side?: "top" | "right" | "bottom" | "left"
}

/**
 * Small wrapper around Radix Tooltip with the RavenScope styling baked in.
 * Provider is mounted once globally in app.tsx so every Tooltip in the tree
 * shares a delay and group behaviour.
 */
export function Tooltip({ label, children, side = "top" }: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 px-2 py-1 text-[12px] font-display font-medium text-primary bg-surface border border-border shadow-lg"
        >
          {label}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  )
}
