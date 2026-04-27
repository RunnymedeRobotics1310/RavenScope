import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import pkg from "./package.json" with { type: "json" }

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Surfaced in the SPA via the __APP_VERSION__ global. Single source
  // of truth is packages/web/package.json — bump there to roll the
  // displayed version (e.g. tooltip on the brand mark in TopNav).
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
})
