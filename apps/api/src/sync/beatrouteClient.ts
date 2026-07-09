export type SourceClient = { id: string; name: string; status: 'active' | 'inactive' };

export class BeatRouteError extends Error {
  constructor(
    public readonly step: 'token' | 'clients',
    message: string,
  ) {
    super(message);
    this.name = 'BeatRouteError';
  }
}

export interface BeatRouteConfig {
  tokenUrl: string;
  clientsUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

type SourceClientRow = { id?: string; client_id?: string; name: string; status: string };

export class BeatRouteClient {
  constructor(private readonly cfg: BeatRouteConfig) {}

  async fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      scope: this.cfg.scope,
    });
    const res = await fetch(this.cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new BeatRouteError('token', `token endpoint returned ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) {
      throw new BeatRouteError('token', 'no access_token in response');
    }
    return json.access_token;
  }

  async fetchClients(token: string): Promise<SourceClient[]> {
    const res = await fetch(this.cfg.clientsUrl, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new BeatRouteError('clients', `clients endpoint returned ${res.status}`);
    }
    const json = (await res.json()) as SourceClientRow[];
    return json.map((c) => {
      const id = c.id ?? c.client_id;
      if (!id) {
        throw new BeatRouteError('clients', 'client row missing id and client_id');
      }
      return {
        id,
        name: c.name,
        status: c.status === 'inactive' ? 'inactive' : 'active',
      };
    });
  }
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 200): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw last;
}
