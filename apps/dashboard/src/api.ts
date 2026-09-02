// Thin API client (F3, Clerk). Requests carry the Clerk session token as a Bearer
// header; the API verifies it and maps it to a Signal account. Every helper throws
// on non-2xx with the server error code.

declare global {
  interface Window {
    Clerk?: { session?: { getToken: () => Promise<string | null> } };
  }
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
  const token = await window.Clerk?.session?.getToken();
  const res = await fetch(path, {
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
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

/** Per-event feedback roll-up for the dashboard, over a rolling window. */
export async function getEventsOverview(days: PeriodDays): Promise<EventRow[]> {
  const { events } = await req<{ events: EventRow[] }>(`/v1/console/events/overview?days=${days}`);
  return events;
}

export interface ReasonChip {
  chip: string;
  count: number;
  share: number;
}
export interface EventReasons {
  total_chip_responses: number;
  chips: ReasonChip[];
}
export interface ResponseItem {
  id: string;
  rating_value: number;
  chip_selected: string | null;
  other_text: string | null;
  device_os: string | null;
  app_version: string | null;
  responded_at: string;
}
export interface ResponseFeed {
  items: ResponseItem[];
  next_cursor: string | null;
}

/** Per-event drill-down: ranked reason chips. */
export function getEventReasons(eventName: string): Promise<EventReasons> {
  return req<EventReasons>(`/v1/console/events/${encodeURIComponent(eventName)}/reasons`);
}

/** Per-event drill-down: recent responses feed. */
export function getEventResponses(eventName: string, limit = 20): Promise<ResponseFeed> {
  return req<ResponseFeed>(
    `/v1/console/events/${encodeURIComponent(eventName)}/responses?limit=${limit}`,
  );
}
