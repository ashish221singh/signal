/**
 * Thin HTTP client for the Signal console API (B3-D8). The MCP server is HTTP-ONLY
 * — it never imports the DB — so every tool goes through this client, inheriting all
 * server-side validation and account isolation. Auth is a CLI token (`SIGNAL_TOKEN`)
 * sent as a Bearer against `SIGNAL_API_URL`.
 */
export interface SignalApiError {
  status: number;
  code: string;
  message: string;
  body: unknown;
}

export class SignalApiClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;

    if (!res.ok) {
      const errObj =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? (parsed as { error: { code?: string; message?: string } }).error
          : undefined;
      const err: SignalApiError = {
        status: res.status,
        code: errObj?.code ?? 'http_error',
        message: errObj?.message ?? `HTTP ${res.status}`,
        body: parsed ?? text,
      };
      throw err;
    }
    return parsed as T;
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }
  delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
