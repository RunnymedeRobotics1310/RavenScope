import type { Env } from "../env"

export class SessionIngestDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(_request: Request): Promise<Response> {
    return new Response("Not implemented", { status: 501 })
  }
}
