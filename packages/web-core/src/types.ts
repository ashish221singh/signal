/**
 * Config + answer types re-exported from @signal/contracts (F1-D20). The SDK
 * eligibility config (extended by B5 with positive_action/negative_action) is the
 * single source of truth; web-core reads it and a `config_version` for the
 * forward-compat handshake (F1-D10).
 *
 * NOTE: only *types* are imported from contracts — no zod at runtime, keeping the
 * core dependency-free and inside the size budget (F1-D15).
 */
import type { Action, ActionType, EligibilityConfig } from '@signal/contracts';

export type { Action, ActionType };

/** The workflow config the sheet renders. It is the B5 eligibility config plus an
 *  optional `config_version` used for the renderer↔config handshake (F1-D10). */
export type WorkflowConfig = EligibilityConfig & {
  /** Config schema version. Absent ⇒ treated as v1 (the shape web-core ships for). */
  config_version?: number;
};

/** The recorded response the core hands to the host to persist/queue (F1-D3).
 *  Kept deliberately small and transport-agnostic; the shell maps it to the wire
 *  `ResponseBody` (adding device/session/timestamps it owns). */
export interface Answer {
  trigger_id: string;
  /** The 1-based rating the user picked (emoji scale: 1..3). */
  rating_value: number;
  /** Whether the rating was positive (>= positive_threshold). */
  positive: boolean;
  /** Free-text comment from the negative branch (trimmed), if any. */
  other_text?: string;
  /** Stored image URL returned by host.requestUpload, if the user attached one. */
  other_image_url?: string;
}
