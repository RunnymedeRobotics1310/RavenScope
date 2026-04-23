import { Component, type ErrorInfo, type ReactNode } from "react"

interface State {
  error: Error | null
}

/**
 * Top-level error boundary. Catches any React render/lifecycle error and
 * paints a readable message so we never silently show a blank page.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("RavenScope UI error:", error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-page text-primary p-8 font-mono text-[13px]">
          <div className="max-w-3xl mx-auto flex flex-col gap-4">
            <h1 className="font-display text-[24px] font-medium text-accent">
              Something broke
            </h1>
            <p className="text-secondary">
              The RavenScope UI hit an unrecoverable error. Full detail is in the
              browser console; a short summary is below.
            </p>
            <pre className="bg-surface border border-border p-4 overflow-auto whitespace-pre-wrap">
              {this.state.error.name}: {this.state.error.message}
              {this.state.error.stack ? "\n\n" + this.state.error.stack : ""}
            </pre>
            <button
              onClick={() => {
                this.setState({ error: null })
                window.location.href = "/"
              }}
              className="self-start bg-accent text-accent-fg px-5 py-2.5 text-[13px] font-display font-medium"
            >
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
