import { describe, expect, it } from 'vitest';
import type { Action } from '../src/index.js';
import {
  isPositive,
  type MachineConfig,
  negativeHasCapture,
  SheetMachine,
} from '../src/machine.js';

const none: Action = { type: 'none' };
const thanks: Action = { type: 'thanks', message: 'Cheers!' };
const redirect: Action = { type: 'redirect', url: 'https://example.com/x' };
const review: Action = { type: 'store_review' };

function cfg(over: Partial<MachineConfig> = {}): MachineConfig {
  return {
    positive_threshold: 3,
    rating_min: 1,
    rating_max: 3,
    other_requires_text: false,
    other_allows_image: false,
    positive_action: none,
    negative_action: none,
    ...over,
  };
}

describe('guards', () => {
  it('isPositive is >= threshold', () => {
    expect(isPositive(3, 3)).toBe(true);
    expect(isPositive(2, 3)).toBe(false);
    expect(isPositive(1, 3)).toBe(false);
  });

  it('negativeHasCapture reflects text/image config', () => {
    expect(negativeHasCapture(cfg())).toBe(false);
    expect(negativeHasCapture(cfg({ other_requires_text: true }))).toBe(true);
    expect(negativeHasCapture(cfg({ other_allows_image: true }))).toBe(true);
  });
});

describe('rating → branch', () => {
  it('positive rating goes straight to submitting (skips detail)', () => {
    const m = new SheetMachine(cfg({ positive_action: thanks }));
    m.selectRating(3);
    expect(m.ctx.positive).toBe(true);
    expect(m.advanceFromRating()).toBe('submitting');
  });

  it('negative rating with capture goes to detail', () => {
    const m = new SheetMachine(cfg({ other_requires_text: true }));
    m.selectRating(1);
    expect(m.ctx.positive).toBe(false);
    expect(m.advanceFromRating()).toBe('detail');
  });

  it('negative rating with NO capture skips detail (F1-D12)', () => {
    const m = new SheetMachine(cfg());
    m.selectRating(2); // threshold 3 ⇒ negative
    expect(m.advanceFromRating()).toBe('submitting');
  });

  it('threshold=1 makes every rating positive', () => {
    const m = new SheetMachine(cfg({ positive_threshold: 1 }));
    m.selectRating(1);
    expect(m.ctx.positive).toBe(true);
  });

  it('clamps a rating outside the range', () => {
    const m = new SheetMachine(cfg());
    m.selectRating(99);
    expect(m.ctx.rating).toBe(3);
    m.state = 'rating';
    const m2 = new SheetMachine(cfg());
    m2.selectRating(-5);
    expect(m2.ctx.rating).toBe(1);
  });
});

describe('detail step', () => {
  it('required comment blocks submit until non-whitespace present', () => {
    const m = new SheetMachine(cfg({ other_requires_text: true }));
    m.selectRating(1);
    m.advanceFromRating();
    expect(m.canSubmitDetail()).toBe(false);
    m.setComment('   \n  ');
    expect(m.canSubmitDetail()).toBe(false); // whitespace-only rejected
    m.setComment('real feedback');
    expect(m.canSubmitDetail()).toBe(true);
    expect(m.advanceFromDetail()).toBe('submitting');
  });

  it('optional comment allows submit when empty', () => {
    const m = new SheetMachine(cfg({ other_allows_image: true }));
    m.selectRating(1);
    m.advanceFromRating();
    expect(m.canSubmitDetail()).toBe(true);
  });
});

describe('submit + resolve action', () => {
  it('guards double-submit', () => {
    const m = new SheetMachine(cfg({ positive_action: none }));
    m.selectRating(3);
    m.advanceFromRating();
    expect(m.beginSubmit()).toBe(true);
    expect(m.beginSubmit()).toBe(false);
  });

  it('resolves positive action to close/thanks/redirect/store_review', () => {
    const close = new SheetMachine(cfg({ positive_action: none }));
    close.selectRating(3);
    close.advanceFromRating();
    close.beginSubmit();
    expect(close.submitResolved()).toEqual({ kind: 'close' });

    const th = new SheetMachine(cfg({ positive_action: thanks }));
    th.selectRating(3);
    th.advanceFromRating();
    th.beginSubmit();
    expect(th.submitResolved()).toEqual({ kind: 'thanks', message: 'Cheers!' });

    const rd = new SheetMachine(cfg({ positive_action: redirect }));
    rd.selectRating(3);
    rd.advanceFromRating();
    rd.beginSubmit();
    expect(rd.submitResolved()).toEqual({ kind: 'redirect', url: 'https://example.com/x' });

    const rv = new SheetMachine(cfg({ positive_action: review }));
    rv.selectRating(3);
    rv.advanceFromRating();
    rv.beginSubmit();
    expect(rv.submitResolved()).toEqual({ kind: 'store_review' });
  });

  it('resolves the NEGATIVE action on the negative branch', () => {
    const m = new SheetMachine(cfg({ negative_action: thanks, other_requires_text: true }));
    m.selectRating(1);
    m.advanceFromRating();
    m.setComment('x');
    m.advanceFromDetail();
    m.beginSubmit();
    expect(m.submitResolved()).toEqual({ kind: 'thanks', message: 'Cheers!' });
    expect(m.state).toBe('done');
  });

  it('submitFailed flags an error and stays out of done', () => {
    const m = new SheetMachine(cfg());
    m.selectRating(3);
    m.advanceFromRating();
    m.beginSubmit();
    m.submitFailed();
    expect(m.ctx.submitError).toBe(true);
    expect(m.state).toBe('submitting');
    // Can retry: beginSubmit succeeds again after a failure.
    expect(m.beginSubmit()).toBe(true);
  });
});

describe('dismiss from any state', () => {
  for (const enter of ['rating', 'detail', 'submitting'] as const) {
    it(`dismiss is reachable from ${enter}`, () => {
      const m = new SheetMachine(cfg({ other_requires_text: true }));
      if (enter !== 'rating') {
        m.selectRating(1);
        m.advanceFromRating();
      }
      if (enter === 'submitting') {
        m.setComment('x');
        m.advanceFromDetail();
      }
      expect(m.state).toBe(enter);
      expect(m.dismiss()).toBe('dismissed');
    });
  }
});
