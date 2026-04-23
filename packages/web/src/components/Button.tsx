import type { ButtonHTMLAttributes, ReactNode } from "react"

type Variant = "primary" | "secondary" | "ghost" | "destructive"

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  children: ReactNode
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90 font-display font-medium",
  secondary:
    "bg-page text-primary border border-border hover:bg-surface font-display font-medium",
  ghost: "text-secondary hover:text-primary font-display font-medium",
  destructive:
    "text-accent hover:bg-surface font-display font-medium border border-transparent",
}

export function Button({
  variant = "primary",
  className = "",
  children,
  ...rest
}: ButtonProps) {
  const padding = variant === "ghost" ? "px-3 py-2" : "px-5 py-2.5"
  return (
    <button
      className={`${VARIANT_CLASSES[variant]} ${padding} text-[13px] transition-opacity disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}
