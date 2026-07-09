export interface DecisionInput {
  campaign: { minTenureDays: number | null };
  suppression:
    | { nextEligibleAt: Date | null; lastAction: 'dismissed' | 'submitted' | null }
    | undefined;
  repTenureDays: number | undefined;
  now: Date;
}

export type Decision =
  | { eligible: true }
  | {
      eligible: false;
      reason: 'suppressed' | 'never_reask' | 'under_tenure' | 'tenure_unknown';
    };

export function decide(input: DecisionInput): Decision {
  const { campaign, suppression, repTenureDays, now } = input;

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

  return { eligible: true };
}
