import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config"

/*
 * Test pool uses an inline Miniflare config rather than reading wrangler.toml so that
 * tests don't require the web/dist assets bundle to exist. Production deploys continue
 * to read wrangler.toml in full (including the [assets] binding).
 */
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        main: "./src/index.ts",
        miniflare: {
          compatibilityDate: "2026-04-17",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            SESSION_INGEST_DO: { className: "SessionIngestDO", useSQLite: true },
          },
          bindings: {
            EMAIL_FROM: "no-reply@test.ravenscope.local",
          },
        },
      },
    },
  },
})
