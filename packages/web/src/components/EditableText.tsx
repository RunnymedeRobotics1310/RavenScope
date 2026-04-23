import { Pencil } from "lucide-react"
import { useEffect, useRef, useState } from "react"

interface EditableTextProps {
  /** Current stored value (null = unset). */
  value: string | null
  /** Shown when value is null/empty and not being edited. */
  placeholder: string
  /** Called on commit. Return a Promise for pending UI. May throw to
   *  show an error message. */
  onCommit: (next: string | null) => Promise<void>
  /** Max characters allowed; enforced in the input. */
  maxLength?: number
  /** Tailwind classes for the display-mode text. */
  className?: string
  /** aria-label for the trigger button. Default "Edit <placeholder>". */
  ariaLabel?: string
}

/**
 * Click-to-edit text field. Shows the current value (or placeholder) and
 * an edit pencil on hover; click reveals an input. Enter or blur commits,
 * Escape cancels. Empty string commits as null so "clear it" is a valid
 * action.
 */
export function EditableText({
  value,
  placeholder,
  onCommit,
  maxLength = 200,
  className = "",
  ariaLabel,
}: EditableTextProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const committingRef = useRef(false)

  useEffect(() => {
    setDraft(value ?? "")
  }, [value])

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  async function commit() {
    if (committingRef.current) return
    const trimmed = draft.trim()
    const next = trimmed.length === 0 ? null : trimmed
    if ((value ?? null) === next) {
      setEditing(false)
      setError(null)
      return
    }
    committingRef.current = true
    setSaving(true)
    setError(null)
    try {
      await onCommit(next)
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed")
    } finally {
      setSaving(false)
      committingRef.current = false
    }
  }

  function cancel() {
    setDraft(value ?? "")
    setEditing(false)
    setError(null)
  }

  if (editing) {
    return (
      <span className="inline-flex flex-col gap-1">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            // onBlur and Enter can both race to commit; committingRef guards.
            void commit()
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              void commit()
            } else if (e.key === "Escape") {
              e.preventDefault()
              cancel()
            }
          }}
          disabled={saving}
          maxLength={maxLength}
          placeholder={placeholder}
          className={`bg-surface border border-border px-2 py-1 text-primary focus:outline-none focus:border-accent disabled:opacity-50 ${className}`}
        />
        {error && <span className="text-[12px] text-accent">{error}</span>}
      </span>
    )
  }

  const hasValue = value != null && value.length > 0
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      aria-label={ariaLabel ?? `Edit ${placeholder}`}
      className={`group inline-flex items-center gap-2 text-left hover:bg-surface px-2 py-1 -mx-2 -my-1 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent transition-colors ${className}`}
    >
      <span className={hasValue ? "" : "text-muted italic"}>
        {hasValue ? value : placeholder}
      </span>
      <Pencil
        size={12}
        className="text-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
      />
    </button>
  )
}
