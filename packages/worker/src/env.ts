export interface Env {
  ASSETS: Fetcher
  SESSION_INGEST_DO: DurableObjectNamespace
  RATE_LIMIT_DO: DurableObjectNamespace
  DB: D1Database
  BLOBS: R2Bucket
  EMAIL_FROM: string
  SESSION_SECRET: string
  RESEND_API_KEY: string
  /**
   * Operator alert address — receives one email per metric per day when a
   * quota cap is first breached (see `quota/daily-quota.ts`). Empty string
   * disables the alert; the 429 and audit log still fire normally.
   */
  OPERATOR_EMAIL: string
}
