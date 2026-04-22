import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/*
 * Test pool uses an inline Miniflare config rather than reading wrangler.toml so that
 * tests don't require the web/dist assets bundle to exist. Production deploys continue
 * to read wrangler.toml in full (including [assets] and [[d1_databases]]).
 *
 * Migrations are read from ./migrations at config-evaluation time and passed as a
 * TEST_MIGRATIONS binding that test/apply-migrations.ts applies via applyD1Migrations.
 */
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"))

  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          main: "./src/index.ts",
          singleWorker: true,
          miniflare: {
            compatibilityDate: "2026-04-17",
            compatibilityFlags: ["nodejs_compat"],
            d1Databases: ["DB"],
            durableObjects: {
              SESSION_INGEST_DO: { className: "SessionIngestDO", useSQLite: true },
              RATE_LIMIT_DO: { className: "RateLimitDO", useSQLite: true },
            },
            bindings: {
              EMAIL_FROM: "no-reply@test.ravenscope.local",
              SESSION_SECRET: JSON.stringify({
                v1: "dGVzdC1zZWNyZXQtMzItYnl0ZXMtbG9uZy1mb3ItaG1hYy1rZXk=",
              }),
              RESEND_API_KEY: "re_test_key",
              TEST_MIGRATIONS: migrations,
            },
          },
        },
      },
    },
  }
})
