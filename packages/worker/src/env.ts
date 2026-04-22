export interface Env {
  ASSETS: Fetcher
  SESSION_INGEST_DO: DurableObjectNamespace
  RATE_LIMIT_DO: DurableObjectNamespace
  DB: D1Database
  BLOBS: R2Bucket
  EMAIL_FROM: string
  SESSION_SECRET: string
  RESEND_API_KEY: string
}
