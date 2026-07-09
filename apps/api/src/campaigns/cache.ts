export interface CachedCampaign {
  id: string;
  screenId: string;
  clientIds: string[];
  metricType: 'CSAT' | 'CES';
  ratingType: 'star' | 'emoji' | 'effort_scale';
  ratingScaleMax: number;
  headerText: string;
  positiveThreshold: number;
  chipsOnNegative: string[];
  otherRequiresText: boolean;
  otherAllowsImage: boolean;
  onPositiveAction: 'none' | 'play_store_review';
  askFrequency: 'after_7_days' | 'after_30_days' | 'after_60_days';
  minTenureDays: number | null;
  createdAt: Date;
}

export type CampaignLoader = () => Promise<CachedCampaign[]>;

export class CampaignCache {
  private campaigns: CachedCampaign[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly load: CampaignLoader) {}

  async refresh(): Promise<void> {
    this.campaigns = await this.load();
  }

  match(screenId: string, clientId: string): CachedCampaign | undefined {
    return this.campaigns
      .filter((c) => c.screenId === screenId && c.clientIds.includes(clientId))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
  }

  startAutoRefresh(intervalMs = 60_000, onError: (e: unknown) => void = () => {}): void {
    this.timer = setInterval(() => void this.refresh().catch(onError), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
