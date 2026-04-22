import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Bytes of the Go-encoded golden WPILog + its source JSONL, exposed as
// miniflare bindings (base64-encoded) so wpilog encoder tests can assert
// byte-for-byte equality without needing filesystem access at runtime.
// Miniflare's `bindings` field accepts JSON-only values, so we base64
// the binary fixtures here and decode inside the tests.
const FIXTURE_DIR = path.join(__dirname, "src/wpilog/fixtures")
const sampleJsonlB64 = readFileSync(
  path.join(FIXTURE_DIR, "sample-session.jsonl"),
).toString("base64")
const sampleWpilogB64 = readFileSync(
  path.join(FIXTURE_DIR, "sample-session.wpilog"),
).toString("base64")

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
            r2Buckets: ["BLOBS"],
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
              FIXTURE_SAMPLE_JSONL_B64: sampleJsonlB64,
              FIXTURE_SAMPLE_WPILOG_B64: sampleWpilogB64,
            },
          },
        },
      },
    },
  }
})
