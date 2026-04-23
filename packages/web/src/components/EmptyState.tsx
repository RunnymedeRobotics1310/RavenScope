import type { ReactNode } from "react"

interface EmptyStateProps {
  title: string
  description?: string
  action?: ReactNode
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-8 text-center border border-border">
      <h3 className="font-display font-medium text-[18px] text-primary mb-2">{title}</h3>
      {description && (
        <p className="text-secondary text-[14px] max-w-md mb-6 leading-relaxed">
          {description}
        </p>
      )}
      {action}
    </div>
  )
}
