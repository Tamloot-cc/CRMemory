export type CRMemoryClientOptions = {
  /** e.g. "http://localhost:8787" */
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
};

export type HealthResponse = {
  status: 'ok' | 'error';
  version: string;
  database: 'ok' | 'unreachable';
};

export class CRMemoryClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CRMemoryClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Server and database status. Does not need an API key. */
  async health(): Promise<HealthResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/health`);
    return (await response.json()) as HealthResponse;
  }

  protected headers(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }
}
