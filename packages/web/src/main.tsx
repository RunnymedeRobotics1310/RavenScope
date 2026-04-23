// eslint-disable-next-line no-console
console.log("[ravenscope] main.tsx: module loaded")

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app"
import { ErrorBoundary } from "./components/ErrorBoundary"
import "./index.css"

// eslint-disable-next-line no-console
console.log("[ravenscope] main.tsx: imports resolved")

const rootElement = document.getElementById("root")
if (!rootElement) throw new Error("#root not found in index.html")

// Synchronously overwrite the static 'Loading…' placeholder so we can
// tell at a glance whether the module ran, even before React finishes
// rendering or throws.
rootElement.textContent = "[ravenscope] JS executed; mounting React…"

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

// eslint-disable-next-line no-console
console.log("[ravenscope] main.tsx: React render() scheduled")
