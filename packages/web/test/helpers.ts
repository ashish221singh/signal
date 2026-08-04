import type { EligibilityConfig } from '@signal/contracts';

/** A minimal, valid eligibility config the sheet can mount. */
export function makeConfig(overrides: Partial<EligibilityConfig> = {}): EligibilityConfig {
  return {
    trigger_id: '11111111-1111-4111-8111-111111111111',
    campaign_id: '22222222-2222-4222-8222-222222222222',
    metric_type: 'CSAT',
    header: 'How was checkout?',
    rating_type: 'emoji',
    rating_scale_max: 3,
    positive_threshold: 3,
    chips_on_negative: [],
    other_requires_text: false,
    other_allows_image: false,
    positive_action: { type: 'none' },
    negative_action: { type: 'none' },
    skip_enabled: true,
    ...overrides,
  };
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** A scripted fetch: matches on url substring → returns a canned Response. */
export function makeFetch(
  routes: Array<{
    match: (url: string, init?: RequestInit) => boolean;
    respond: (url: string, init?: RequestInit) => { status: number; body?: unknown };
  }>,
): { fetch: typeof fetch; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers as Record<string, string>) ?? {};
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method: init?.method ?? 'GET', headers, body });
    const route = routes.find((r) => r.match(url, init));
    if (!route) {
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => '',
      } as Response;
    }
    const { status, body: respBody } = route.respond(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => respBody ?? {},
      text: async () => JSON.stringify(respBody ?? {}),
    } as Response;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/** Wait a real tick so fire-and-forget promises (outbox flush, which drives async
 *  IndexedDB requests via the event loop) settle. A macrotask is required because
 *  IndexedDB success callbacks fire on the task queue, not the microtask queue. */
export function flushMicrotasks(ms = 15): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
