/**
 * Pure state machine (F1-D4) — no DOM, no host, fully unit-testable. It owns the
 * flow rating → detail → submitting → done, the branch guard, and every dismissal
 * path. The view layer reads `state` and calls the transition methods; side
 * effects (host.submit / openUrl / openReview) are executed by the caller from the
 * emitted `effect`, never here.
 */
import type { Action } from './types.js';

export type SheetState = 'rating' | 'detail' | 'submitting' | 'done' | 'dismissed';

/** What the `done` state resolves to, derived from the branch's post-submit Action. */
export type ResolvedAction =
  | { kind: 'close' }
  | { kind: 'thanks'; message: string }
  | { kind: 'redirect'; url: string; message?: string }
  | { kind: 'store_review' };

/** Config slice the machine needs (a structural subset of WorkflowConfig). */
export interface MachineConfig {
  positive_threshold: number;
  rating_min: number;
  rating_max: number;
  /** Reason chips offered in the negative branch (empty ⇒ no chips). */
  chips: string[];
  other_requires_text: boolean;
  other_allows_image: boolean;
  positive_action: Action;
  negative_action: Action;
}

export interface MachineContext {
  rating: number | null;
  positive: boolean;
  comment: string;
  imageUrl: string | null;
  /** The reason chip the user selected (single-select), if any. */
  chip: string | null;
  /** Set once submit resolves; drives the done view. */
  resolved: ResolvedAction | null;
  /** True while a submit is in flight (guards double-submit). */
  submitting: boolean;
  /** Set when host.submit hard-fails so the view can show a retry. */
  submitError: boolean;
}

/** `>= threshold` decides the branch (F1-D4). Threshold is clamped into range by
 *  the caller (config normalisation), so this is a plain comparison. */
export function isPositive(rating: number, threshold: number): boolean {
  return rating >= threshold;
}

/** The negative branch has nothing to collect ⇒ skip `detail` (F1-D12). Reason
 *  chips also count as something to collect (chips render in the detail step). */
export function negativeHasCapture(cfg: MachineConfig): boolean {
  return cfg.other_requires_text || cfg.other_allows_image || cfg.chips.length > 0;
}

function resolveAction(action: Action): ResolvedAction {
  switch (action.type) {
    case 'thanks':
      return { kind: 'thanks', message: action.message ?? 'Thanks for your feedback!' };
    case 'redirect':
      // A well-formed redirect always carries a url (validated in contracts); if
      // somehow absent, degrade to a plain close rather than a broken redirect.
      return action.url
        ? { kind: 'redirect', url: action.url, message: action.message }
        : { kind: 'close' };
    case 'store_review':
      return { kind: 'store_review' };
    default:
      return { kind: 'close' };
  }
}

export class SheetMachine {
  state: SheetState = 'rating';
  readonly ctx: MachineContext = {
    rating: null,
    positive: false,
    comment: '',
    imageUrl: null,
    chip: null,
    resolved: null,
    submitting: false,
    submitError: false,
  };

  constructor(private readonly cfg: MachineConfig) {}

  /** Pick a rating in the rating step. Returns the next state so the view can
   *  render/transition. Idempotent-ish: re-selecting while past `rating` is ignored. */
  selectRating(rating: number): SheetState {
    if (this.state !== 'rating') return this.state;
    const clamped = Math.min(Math.max(rating, this.cfg.rating_min), this.cfg.rating_max);
    this.ctx.rating = clamped;
    this.ctx.positive = isPositive(clamped, this.cfg.positive_threshold);
    return this.state;
  }

  /** Advance from the rating step once a rating is chosen. Positive → straight to
   *  submitting (no detail). Negative → detail, unless there's nothing to capture
   *  (F1-D12), in which case straight to submitting. */
  advanceFromRating(): SheetState {
    if (this.state !== 'rating' || this.ctx.rating === null) return this.state;
    if (this.ctx.positive) {
      this.state = 'submitting';
    } else if (negativeHasCapture(this.cfg)) {
      this.state = 'detail';
    } else {
      this.state = 'submitting';
    }
    return this.state;
  }

  setComment(text: string): void {
    this.ctx.comment = text;
  }

  /** Select/clear the reason chip (single-select; passing the current chip clears it). */
  setChip(chip: string | null): void {
    this.ctx.chip = chip;
  }

  setImageUrl(url: string | null): void {
    this.ctx.imageUrl = url;
  }

  /** Whether the detail step allows submitting (comment required-and-present rule). */
  canSubmitDetail(): boolean {
    if (this.cfg.other_requires_text) {
      return this.ctx.comment.trim().length > 0;
    }
    return true;
  }

  /** Move detail → submitting. Blocked if a required comment is empty/whitespace. */
  advanceFromDetail(): SheetState {
    if (this.state !== 'detail') return this.state;
    if (!this.canSubmitDetail()) return this.state;
    this.state = 'submitting';
    return this.state;
  }

  /** Guard for the caller before invoking host.submit exactly once (F1 double-submit). */
  beginSubmit(): boolean {
    if (this.state !== 'submitting' || this.ctx.submitting) return false;
    this.ctx.submitting = true;
    this.ctx.submitError = false;
    return true;
  }

  /** Submit resolved (queued/persisted) → resolve the post-submit action → done. */
  submitResolved(): ResolvedAction {
    this.ctx.submitting = false;
    const action = this.ctx.positive ? this.cfg.positive_action : this.cfg.negative_action;
    const resolved = resolveAction(action);
    this.ctx.resolved = resolved;
    this.state = 'done';
    return resolved;
  }

  /** Submit hard-failed → stay in submitting, flag error so the view offers retry. */
  submitFailed(): void {
    this.ctx.submitting = false;
    this.ctx.submitError = true;
  }

  /** Dismiss is reachable from every non-terminal state (F1-D4). */
  dismiss(): SheetState {
    this.state = 'dismissed';
    return this.state;
  }
}
