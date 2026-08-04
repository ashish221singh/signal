import { describe, expect, it } from 'vitest';
import {
  ACTION_MESSAGE_MAX,
  ACTION_URL_MAX,
  actionSchema,
  DEFAULT_THANKS_MESSAGE,
} from './index.js';

describe('actionSchema', () => {
  it('accepts `none` and strips stray fields (B5-D2)', () => {
    const r = actionSchema.safeParse({ type: 'none', message: 'ignored', url: 'https://x.com' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ type: 'none' });
  });

  it('accepts `store_review` and strips stray fields', () => {
    const r = actionSchema.safeParse({ type: 'store_review', url: 'https://x.com' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ type: 'store_review' });
  });

  it('applies the default thank-you message when `thanks` has no message', () => {
    const r = actionSchema.safeParse({ type: 'thanks' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ type: 'thanks', message: DEFAULT_THANKS_MESSAGE });
  });

  it('applies the default when `thanks` message is blank', () => {
    const r = actionSchema.safeParse({ type: 'thanks', message: '   ' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.message).toBe(DEFAULT_THANKS_MESSAGE);
  });

  it('keeps a provided `thanks` message', () => {
    const r = actionSchema.safeParse({ type: 'thanks', message: 'You rock' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ type: 'thanks', message: 'You rock' });
  });

  it('rejects a `redirect` with no url', () => {
    expect(actionSchema.safeParse({ type: 'redirect' }).success).toBe(false);
  });

  it('rejects a non-https redirect url (http/javascript/relative)', () => {
    expect(actionSchema.safeParse({ type: 'redirect', url: 'http://x.com' }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'redirect', url: 'javascript:alert(1)' }).success).toBe(
      false,
    );
    expect(actionSchema.safeParse({ type: 'redirect', url: '/relative/path' }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'redirect', url: 'not a url' }).success).toBe(false);
  });

  it('accepts a valid https redirect and keeps an optional message', () => {
    const r = actionSchema.safeParse({
      type: 'redirect',
      url: 'https://support.example.com/help',
      message: 'Sorry about that',
    });
    expect(r.success).toBe(true);
    if (r.success)
      expect(r.data).toEqual({
        type: 'redirect',
        url: 'https://support.example.com/help',
        message: 'Sorry about that',
      });
  });

  it('rejects an unknown action type (closed enum)', () => {
    expect(actionSchema.safeParse({ type: 'play_store_review' }).success).toBe(false);
  });

  it('rejects an over-long message and an over-long url', () => {
    expect(
      actionSchema.safeParse({ type: 'thanks', message: 'x'.repeat(ACTION_MESSAGE_MAX + 1) })
        .success,
    ).toBe(false);
    expect(
      actionSchema.safeParse({
        type: 'redirect',
        url: `https://x.com/${'a'.repeat(ACTION_URL_MAX)}`,
      }).success,
    ).toBe(false);
  });

  it('is idempotent — re-parsing a normalized action returns it unchanged', () => {
    for (const a of [
      { type: 'none' as const },
      { type: 'store_review' as const },
      { type: 'thanks' as const, message: 'Hi' },
      { type: 'redirect' as const, url: 'https://x.com/' },
    ]) {
      const once = actionSchema.parse(a);
      expect(actionSchema.parse(once)).toEqual(once);
    }
  });
});
