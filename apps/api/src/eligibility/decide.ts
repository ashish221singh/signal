export interface DecisionInput {
  campaign: { minTenureDays: number | null; dailyCap: number | null };
  suppression:
    | { nextEligibleAt: Date | null; lastAction: 'dismissed' | 'submitted' | null }
    | undefined;
  repTenureDays: number | undefined;
  showsInLast24h: number;
  now: Date;
}

export type Decision =
  | { eligible: true }
  | {
      eligible: false;
      reason: 'suppressed' | 'never_reask' | 'under_tenure' | 'tenure_unknown' | 'daily_cap';
    };

export function decide(input: DecisionInput): Decision {
  const { campaign, suppression, repTenureDays, showsInLast24h, now } = input;

  if (suppression) {
    if (suppression.nextEligibleAt === null) {
      return { eligible: false, reason: 'never_reask' };
    }
    if (suppression.nextEligibleAt.getTime() > now.getTime()) {
      return { eligible: false, reason: 'suppressed' };
    }
  }
  if (campaign.minTenureDays !== null) {
    if (repTenureDays === undefined) {
      return { eligible: false, reason: 'tenure_unknown' };
    }
    if (repTenureDays < campaign.minTenureDays) {
      return { eligible: false, reason: 'under_tenure' };
    }
  }
  if (campaign.dailyCap !== null && showsInLast24h >= campaign.dailyCap) {
    return { eligible: false, reason: 'daily_cap' };
  }

  return { eligible: true };
}
