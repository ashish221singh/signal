/**
 * Config validation + normalisation (F1-D10, D20, and the "Config" edge cases).
 * The core fails CLOSED: on missing/malformed required fields it does not mount
 * and the host is dismissed with `config_invalid`. Unknown *optional* fields are
 * ignored (forward-compat); only an unknown/missing *required* field fails.
 */
import type { MachineConfig } from './machine.js';
import type { Action, WorkflowConfig } from './types.js';

/** The min config version this bundle understands (F1-D10). */
export const SUPPORTED_CONFIG_VERSION = 1;

export interface NormalizedConfig extends MachineConfig {
  trigger_id: string;
  header: string;
  ratingType: 'emoji' | 'star' | 'effort_scale' | 'unknown';
  skip_enabled: boolean;
}

export type ConfigResult = { ok: true; config: NormalizedConfig } | { ok: false; reason: string };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isValidAction(v: unknown): v is Action {
  if (typeof v !== 'object' || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return t === 'none' || t === 'thanks' || t === 'redirect' || t === 'store_review';
}

/**
 * Validate + normalise the raw config. Clamps `positive_threshold` into the
 * rating range; maps an unknown rating type to the emoji fallback (render what we
 * understand, log, never crash). Returns a fail-closed result on required-field
 * problems.
 */
export function normalizeConfig(raw: WorkflowConfig): ConfigResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'config is not an object' };
  }

  // Forward-compat handshake (F1-D10): a newer config_version is fine as long as
  // the required fields below are still present/valid; we ignore unknown fields.
  const version = typeof raw.config_version === 'number' ? raw.config_version : 1;

  if (!isNonEmptyString(raw.trigger_id)) return { ok: false, reason: 'missing trigger_id' };
  if (!isNonEmptyString(raw.header)) return { ok: false, reason: 'missing header (question)' };

  if (typeof raw.rating_scale_max !== 'number' || !Number.isFinite(raw.rating_scale_max)) {
    return { ok: false, reason: 'missing/invalid rating_scale_max' };
  }
  if (typeof raw.positive_threshold !== 'number' || !Number.isFinite(raw.positive_threshold)) {
    return { ok: false, reason: 'missing/invalid positive_threshold' };
  }
  if (!isValidAction(raw.positive_action)) return { ok: false, reason: 'invalid positive_action' };
  if (!isValidAction(raw.negative_action)) return { ok: false, reason: 'invalid negative_action' };

  // v1 ratings: a 3-point emoji scale (default) or a 5-point star scale. Unknown
  // rating types render the emoji fallback (edge case) rather than failing closed.
  const rawRatingType = raw.rating_type;
  const knownType =
    rawRatingType === 'emoji' || rawRatingType === 'star' || rawRatingType === 'effort_scale';
  const ratingType: NormalizedConfig['ratingType'] = knownType ? rawRatingType : 'unknown';

  // Star renders a 1..5 scale; emoji / effort_scale / unknown fall back to the
  // 3-point emoji renderer, so bounds are 1..3 for those.
  const rating_min = 1;
  const rating_max = ratingType === 'star' ? 5 : 3;

  // Clamp threshold into range (edge case: out-of-range threshold).
  const positive_threshold = Math.min(
    Math.max(Math.round(raw.positive_threshold), rating_min),
    rating_max,
  );

  const config: NormalizedConfig = {
    trigger_id: raw.trigger_id,
    header: raw.header,
    ratingType,
    positive_threshold,
    rating_min,
    rating_max,
    other_requires_text: raw.other_requires_text === true,
    other_allows_image: raw.other_allows_image === true,
    positive_action: raw.positive_action,
    negative_action: raw.negative_action,
    skip_enabled: raw.skip_enabled === true,
  };

  // A config_version newer than we support is allowed (forward-compat); we only
  // log via the return path. The caller may inspect version if it wants.
  void version;
  void SUPPORTED_CONFIG_VERSION;

  return { ok: true, config };
}
