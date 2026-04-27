import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"
import pkg from "./package.json" with { type: "json" }

export default defineConfig({
  plugins: [react()],
  // Mirror vite.config.ts so __APP_VERSION__ resolves under tests too.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: "jsdom",
    globals: false,
  },
})
