export interface DecisionInput {
  workflow: { minSessionAgeDays: number | null; samplingRate: number };
  suppression:
    | { nextEligibleAt: Date | null; lastAction: 'dismissed' | 'submitted' | null }
    | undefined;
  sessionAgeDays: number | undefined;
  now: Date;
  /**
   * Injected RNG returning [0,1) (B2-D4). Defaults to `Math.random` in production;
   * tests stub it for deterministic sampled/not-sampled outcomes.
   */
  rng?: () => number;
}

/**
 * A not-eligible decision carries `record` (B2-D4): when `false` the caller must
 * write NO trigger_log/suppression row — a not-sampled ask must be invisible and
 * must not consume the user's cooldown. Suppression/tenure rejections keep the
 * historical behaviour of writing nothing either, so they are `record:false` too;
 * only an ELIGIBLE decision leads to a claim + trigger write.
 */
export type Decision =
  | { eligible: true }
  | {
      eligible: false;
      reason: 'suppressed' | 'never_reask' | 'under_session_age' | 'session_age_unknown';
      record: false;
    }
  | { eligible: false; reason: 'not_sampled'; record: false };

/**
 * Gate order (B2-D4): cooldown/suppression → session-age → sample. Sampling runs
 * LAST so it only ever skips an otherwise-eligible ask, and it never touches the
 * cooldown (the caller writes nothing on `not_sampled`).
 */
export function decide(input: DecisionInput): Decision {
  const { workflow, suppression, sessionAgeDays, now } = input;
  const rng = input.rng ?? Math.random;

  if (suppression) {
    if (suppression.nextEligibleAt === null) {
      return { eligible: false, reason: 'never_reask', record: false };
    }
    if (suppression.nextEligibleAt.getTime() > now.getTime()) {
      return { eligible: false, reason: 'suppressed', record: false };
    }
  }

  if (workflow.minSessionAgeDays !== null) {
    if (sessionAgeDays === undefined) {
      return { eligible: false, reason: 'session_age_unknown', record: false };
    }
    if (sessionAgeDays < workflow.minSessionAgeDays) {
      return { eligible: false, reason: 'under_session_age', record: false };
    }
  }

  // Sampling gate (B2-D4): pass with probability `samplingRate`. A rate >= 1
  // always fires; a not-sampled trigger writes nothing.
  if (workflow.samplingRate < 1 && rng() >= workflow.samplingRate) {
    return { eligible: false, reason: 'not_sampled', record: false };
  }

  return { eligible: true };
}
