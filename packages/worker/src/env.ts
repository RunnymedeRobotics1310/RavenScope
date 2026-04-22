export interface Env {
  ASSETS: Fetcher
  SESSION_INGEST_DO: DurableObjectNamespace
  EMAIL_FROM: string
  // Arrive in later units:
  // DB: D1Database                 // Unit 2
  // BLOBS: R2Bucket                // Unit 5
  // SESSION_SECRET: string         // Unit 3
  // RESEND_API_KEY: string         // Unit 3
}
