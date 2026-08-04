import { describe, expect, it } from 'vitest';
import {
  ALL_CLI_SCOPES,
  CLI_TOKEN_PATTERN,
  cliScopeSchema,
  cliTokenCreateSchema,
  deployItemResultSchema,
  deployRequestSchema,
  deployWorkflowSchema,
  deviceCodeResponseSchema,
  seenEventSchema,
} from '../index.js';

describe('cliScopeSchema', () => {
  it('accepts the four defined scopes', () => {
    for (const s of ALL_CLI_SCOPES) {
      expect(cliScopeSchema.safeParse(s).success).toBe(true);
    }
  });
  it('rejects an unknown scope', () => {
    expect(cliScopeSchema.safeParse('workflows:delete').success).toBe(false);
  });
});

describe('CLI_TOKEN_PATTERN', () => {
  it('matches cli_<32 base62>', () => {
    expect(CLI_TOKEN_PATTERN.test(`cli_${'a'.repeat(32)}`)).toBe(true);
  });
  it('rejects a wrong prefix or length', () => {
    expect(CLI_TOKEN_PATTERN.test('pk_live_abc')).toBe(false);
    expect(CLI_TOKEN_PATTERN.test(`cli_${'a'.repeat(31)}`)).toBe(false);
  });
});

describe('cliTokenCreateSchema', () => {
  it('accepts a name with optional scopes', () => {
    expect(cliTokenCreateSchema.safeParse({ name: 'ci' }).success).toBe(true);
    expect(
      cliTokenCreateSchema.safeParse({ name: 'ci', scopes: ['deploy', 'workflows:read'] }).success,
    ).toBe(true);
  });
  it('rejects a blank name and an empty scopes array', () => {
    expect(cliTokenCreateSchema.safeParse({ name: '  ' }).success).toBe(false);
    expect(cliTokenCreateSchema.safeParse({ name: 'x', scopes: [] }).success).toBe(false);
  });
});

describe('deviceCodeResponseSchema', () => {
  it('accepts a full device-code handshake', () => {
    expect(
      deviceCodeResponseSchema.safeParse({
        device_code: 'dc',
        user_code: 'ABCD-1234',
        verification_uri: 'http://localhost:3000/cli/approve',
        interval: 5,
        expires_in: 600,
      }).success,
    ).toBe(true);
  });
});

describe('deployWorkflowSchema', () => {
  const valid = {
    key: 'checkout-csat',
    event_name: 'checkout_completed',
    metric_type: 'CSAT',
    rating_type: 'star',
    rating_scale_max: 5,
    header_text: 'How was it?',
    positive_threshold: 4,
  };
  it('accepts a valid item and defaults status to active', () => {
    const parsed = deployWorkflowSchema.parse(valid);
    expect(parsed.status).toBe('active');
  });
  it('rejects an unsafe key', () => {
    expect(deployWorkflowSchema.safeParse({ ...valid, key: 'has space' }).success).toBe(false);
  });
  it('requires an event_name', () => {
    const { event_name: _omit, ...rest } = valid;
    expect(deployWorkflowSchema.safeParse(rest).success).toBe(false);
  });
  it('accepts agent-friendly branched actions (onPositive/onNegative)', () => {
    const parsed = deployWorkflowSchema.parse({
      ...valid,
      onPositive: { type: 'thanks' },
      onNegative: { type: 'redirect', url: 'https://support.example.com' },
    });
    expect(parsed.onPositive).toEqual({ type: 'thanks', message: 'Thanks for your feedback!' });
    expect(parsed.onNegative).toEqual({
      type: 'redirect',
      url: 'https://support.example.com',
    });
  });
  it('rejects a redirect onNegative with no url', () => {
    expect(
      deployWorkflowSchema.safeParse({ ...valid, onNegative: { type: 'redirect' } }).success,
    ).toBe(false);
  });
});

describe('deployRequestSchema', () => {
  it('accepts an empty workflows array (prunes everything code-managed)', () => {
    expect(deployRequestSchema.safeParse({ workflows: [] }).success).toBe(true);
  });
});

describe('deployItemResultSchema', () => {
  it('accepts an event_conflict failure with a conflict body', () => {
    expect(
      deployItemResultSchema.safeParse({
        key: 'k',
        action: 'failed',
        workflow_id: null,
        status: null,
        error: {
          code: 'event_conflict',
          message: 'another workflow owns this event',
          conflict: {
            id: '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e',
            header: 'Old',
            event_name: 'checkout_completed',
          },
        },
      }).success,
    ).toBe(true);
  });
});

describe('seenEventSchema', () => {
  it('accepts a surfaced event', () => {
    expect(
      seenEventSchema.safeParse({
        event_name: 'checkout_completed',
        first_seen_at: '2026-08-03T00:00:00.000Z',
        last_seen_at: '2026-08-03T00:00:00.000Z',
        hit_count: 3,
      }).success,
    ).toBe(true);
  });
});
