import { describe, expect, it } from 'vitest';
import { mintPreviewToken, verifyPreviewToken } from './token.js';

const SECRET = 'a-test-secret-at-least-16-chars';

describe('preview token (F2-D16)', () => {
  it('round-trips valid claims', () => {
    const now = 1_700_000_000_000;
    const { token, expiresAt } = mintPreviewToken(
      { account_id: 'acct-1', workflow_id: 'wf-1' },
      SECRET,
      1800,
      now,
    );
    const claims = verifyPreviewToken(token, SECRET, now);
    expect(claims).toMatchObject({
      account_id: 'acct-1',
      workflow_id: 'wf-1',
      mode: 'preview',
    });
    expect(expiresAt.getTime()).toBe(now + 1800 * 1000);
  });

  it('rejects an expired token', () => {
    const now = 1_700_000_000_000;
    const { token } = mintPreviewToken({ account_id: 'a', workflow_id: 'w' }, SECRET, 1800, now);
    // 31 minutes later — past the 30-min TTL.
    expect(verifyPreviewToken(token, SECRET, now + 31 * 60 * 1000)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const { token } = mintPreviewToken({ account_id: 'a', workflow_id: 'w' }, SECRET);
    const [, sig] = token.split('.');
    const forged = `${Buffer.from(
      JSON.stringify({ account_id: 'evil', workflow_id: 'w', mode: 'preview', exp: 9_999_999_999 }),
    ).toString('base64url')}.${sig}`;
    expect(verifyPreviewToken(forged, SECRET)).toBeNull();
  });

  it('rejects a wrong-secret signature', () => {
    const { token } = mintPreviewToken({ account_id: 'a', workflow_id: 'w' }, SECRET);
    expect(verifyPreviewToken(token, 'a-different-secret-16chars')).toBeNull();
  });

  it('rejects garbage', () => {
    expect(verifyPreviewToken('not-a-token', SECRET)).toBeNull();
    expect(verifyPreviewToken('', SECRET)).toBeNull();
    expect(verifyPreviewToken('.', SECRET)).toBeNull();
  });
});
