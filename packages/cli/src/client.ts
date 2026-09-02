import type { DeployResponse, DeviceCodeResponse, DeviceTokenResponse } from '@signal/contracts';

/**
 * CLI HTTP client (B3-D9). Talks to the Signal console/CLI API over HTTP. Auth is a
 * CLI token (Bearer) for the console endpoints; the device-flow + password-login
 * endpoints are public. Injectable `fetchImpl` so the e2e test can route into an
 * ephemeral Fastify app.
 */
export interface CliApiError {
  status: number;
  code: string;
  message: string;
}

export class CliClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async req<T>(
    method: string,
    path: string,
    opts: { body?: unknown; token?: string } = {},
  ) {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const errObj =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? (parsed as { error: { code?: string; message?: string } }).error
          : undefined;
      const err: CliApiError = {
        status: res.status,
        code: errObj?.code ?? 'http_error',
        message: errObj?.message ?? `HTTP ${res.status}`,
      };
      throw err;
    }
    return parsed as T;
  }

  // ── device flow ──
  startDevice(): Promise<DeviceCodeResponse> {
    return this.req<DeviceCodeResponse>('POST', '/v1/cli/device/code');
  }

  /** Poll once. Returns the token or a status string the caller loops on. */
  async pollDevice(
    deviceCode: string,
  ): Promise<
    | { status: 'approved'; result: DeviceTokenResponse }
    | { status: 'pending' | 'denied' | 'expired' }
  > {
    try {
      const result = await this.req<DeviceTokenResponse>('POST', '/v1/cli/device/token', {
        body: { device_code: deviceCode },
      });
      return { status: 'approved', result };
    } catch (e) {
      const err = e as CliApiError;
      if (err.code === 'authorization_pending') return { status: 'pending' };
      if (err.code === 'access_denied') return { status: 'denied' };
      if (err.code === 'expired_token' || err.code === 'invalid_grant')
        return { status: 'expired' };
      throw err;
    }
  }

  // ── interim password login ──
  passwordLogin(email: string, password: string): Promise<DeviceTokenResponse> {
    return this.req<DeviceTokenResponse>('POST', '/v1/cli/login', { body: { email, password } });
  }

  // ── console ──
  listWorkflows(token: string, includeArchived = false): Promise<unknown[]> {
    const q = includeArchived ? '?include=archived' : '';
    return this.req<unknown[]>('GET', `/v1/console/workflows${q}`, { token });
  }

  deploy(token: string, workflows: unknown[]): Promise<DeployResponse> {
    return this.req<DeployResponse>('POST', '/v1/console/deploy', { body: { workflows }, token });
  }

  /** Create an empty draft workflow (for the `signal setup` wizard). */
  createWorkflow(token: string): Promise<{ id: string }> {
    return this.req<{ id: string }>('POST', '/v1/console/workflows', { body: {}, token });
  }

  /** Patch a draft's builder fields. */
  patchWorkflow(token: string, id: string, patch: Record<string, unknown>): Promise<unknown> {
    return this.req('PATCH', `/v1/console/workflows/${id}`, { body: patch, token });
  }

  /** Publish a draft → active. Throws CliApiError (e.g. code `incomplete`) on failure. */
  publishWorkflow(token: string, id: string): Promise<{ status?: string }> {
    return this.req('POST', `/v1/console/workflows/${id}/publish`, { body: {}, token });
  }

  listCliTokens(token: string): Promise<{ tokens: { name: string; scopes: string[] }[] }> {
    return this.req('GET', '/v1/console/cli-tokens', { token });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
