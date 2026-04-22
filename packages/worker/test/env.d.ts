import type { D1Migration } from "@cloudflare/vitest-pool-workers/config"
import type { Env } from "../src/env"

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[]
    FIXTURE_SAMPLE_JSONL_B64: string
    FIXTURE_SAMPLE_WPILOG_B64: string
  }
}
