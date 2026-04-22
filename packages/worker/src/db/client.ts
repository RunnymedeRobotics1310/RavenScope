import { drizzle } from "drizzle-orm/d1"
import type { Env } from "../env"
import { schema } from "./schema"

export function createDb(env: Env) {
  return drizzle(env.DB, { schema })
}

export type Db = ReturnType<typeof createDb>
export * as tables from "./schema"
