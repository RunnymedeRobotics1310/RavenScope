export interface Env {
  ASSETS: Fetcher
  SESSION_INGEST_DO: DurableObjectNamespace
  DB: D1Database
  EMAIL_FROM: string
  // Arrive in later units:
  // BLOBS: R2Bucket                // Unit 5
  // SESSION_SECRET: string         // Unit 3
  // RESEND_API_KEY: string         // Unit 3
}
