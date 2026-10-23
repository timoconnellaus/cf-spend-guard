const API = "https://api.cloudflare.com/client/v4";

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Thin client for the Cloudflare REST and GraphQL APIs. */
export class CloudflareClient {
  constructor(
    private readonly token: string,
    // Wrapped: calling a stored `fetch` as a method throws "Illegal invocation" in workerd.
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new CloudflareApiError(`${method} ${path}: HTTP ${res.status}, non-JSON response`, res.status);
    }
    if (!res.ok || json.success === false) {
      const errors = (json.errors ?? []).map((e: any) => `${e.code ?? ""} ${e.message}`.trim()).join("; ");
      throw new CloudflareApiError(`${method} ${path}: HTTP ${res.status} ${errors}`.trim(), res.status);
    }
    return json.result as T;
  }

  /** Pages through a list endpoint that uses page/per_page. */
  async list<T>(path: string, perPage = 50): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page < 100; page++) {
      const batch = await this.request<T[]>("GET", `${path}${sep}page=${page}&per_page=${perPage}`);
      out.push(...batch);
      if (batch.length < perPage) break;
    }
    return out;
  }

  async graphql<T>(query: string): Promise<T> {
    const res = await this.fetchImpl(`${API}/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json.errors?.length) {
      const detail = (json.errors ?? []).map((e: any) => e.message).join("; ");
      const prefix = res.ok ? "GraphQL" : `GraphQL: HTTP ${res.status}`;
      throw new CloudflareApiError(detail ? `${prefix}: ${detail}` : prefix, res.status);
    }
    return json.data as T;
  }

  async resolveAccountId(configured?: string): Promise<string> {
    if (configured) return configured;
    const accounts = await this.request<{ id: string; name: string }[]>("GET", "/accounts?per_page=50");
    if (accounts.length === 1) return accounts[0].id;
    if (accounts.length === 0) throw new Error("The API token cannot see any accounts. Check its permissions.");
    throw new Error(
      `The API token can see ${accounts.length} accounts; set CF_ACCOUNT_ID to one of: ` +
        accounts.map((a) => `${a.id} (${a.name})`).join(", "),
    );
  }
}
