import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app"
import { ErrorBoundary } from "./components/ErrorBoundary"
import "./index.css"

const rootElement = document.getElementById("root")
if (!rootElement) throw new Error("#root not found in index.html")

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
