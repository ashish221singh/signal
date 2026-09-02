// Thin API client. Same-origin in production and dev (Vite proxies /v1 → API),
// so cookies flow automatically; `credentials: 'include'` covers the cross-origin
// dev case too. Every helper throws on non-2xx with the server error code.

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'editor';
  provider?: 'google' | 'password';
}

/** One row of the per-event roll-up (GET /v1/console/events/overview). */
export interface EventRow {
  event_name: string;
  triggers: number;
  responses: number;
  response_rate: number | null;
  positive_score: number | null;
}

export type PeriodDays = 7 | 30 | 90;

class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    throw new ApiError(
      res.status,
      body.error?.code ?? 'error',
      body.error?.message ?? res.statusText,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Current session user, or null when unauthenticated (401). */
export async function getMe(): Promise<SessionUser | null> {
  try {
    return await req<SessionUser>('/v1/console/auth/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export async function logout(): Promise<void> {
  await req<void>('/v1/console/auth/logout', { method: 'POST' });
}

/** Per-event feedback roll-up for the dashboard, over a rolling window. */
export async function getEventsOverview(days: PeriodDays): Promise<EventRow[]> {
  const { events } = await req<{ events: EventRow[] }>(`/v1/console/events/overview?days=${days}`);
  return events;
}

/** Full-page navigation into the Google OAuth flow (returns to `next`). */
export function googleLoginUrl(next = '/app/dashboard'): string {
  return `/v1/console/auth/google?next=${encodeURIComponent(next)}`;
}
