import type { WorkflowAction } from '../db/schema.js';

export interface CachedWorkflow {
  id: string;
  accountId: string;
  eventName: string;
  samplingRate: number;
  minSessionAgeDays: number | null;
  metricType: 'CSAT' | 'CES';
  ratingType: 'star' | 'emoji' | 'effort_scale';
  ratingScaleMax: number;
  headerText: string;
  positiveThreshold: number;
  chipsOnNegative: string[];
  otherRequiresText: boolean;
  otherAllowsImage: boolean;
  positiveAction: WorkflowAction;
  negativeAction: WorkflowAction;
  askFrequency: 'after_7_days' | 'after_30_days' | 'after_60_days';
  createdAt: Date;
}

export type WorkflowLoader = () => Promise<CachedWorkflow[]>;

/** Index key: an account cannot see another account's (event) workflow (B2-D6). */
function key(accountId: string, eventName: string): string {
  return `${accountId} ${eventName}`;
}

export class WorkflowCache {
  private byAccountEvent = new Map<string, CachedWorkflow[]>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly load: WorkflowLoader) {}

  async refresh(): Promise<void> {
    const rows = await this.load();
    const next = new Map<string, CachedWorkflow[]>();
    for (const w of rows) {
      const k = key(w.accountId, w.eventName);
      const bucket = next.get(k);
      if (bucket) bucket.push(w);
      else next.set(k, [w]);
    }
    this.byAccountEvent = next;
  }

  /**
   * Match by (accountId, eventName) (B2-D6). Ties break to the oldest workflow
   * (B2-D3 runtime tie-break). A key for account A can never match account B's
   * workflow — the isolation test asserts this on the hot path.
   */
  match(accountId: string, eventName: string): CachedWorkflow | undefined {
    const bucket = this.byAccountEvent.get(key(accountId, eventName));
    if (!bucket || bucket.length === 0) return undefined;
    return [...bucket].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
  }

  startAutoRefresh(intervalMs = 60_000, onError: (e: unknown) => void = () => {}): void {
    this.timer = setInterval(() => void this.refresh().catch(onError), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
