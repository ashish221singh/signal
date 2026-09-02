import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeployResponse } from '@signal/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliClient } from './client.js';
import type { CommandDeps } from './commands.js';
import { writeConfig } from './config.js';
import { buildProgram } from './index.js';
import { buildWorkflow, defaultThreshold, runSetup, toKey, trackSnippet } from './setup.js';

describe('setup — pure helpers', () => {
  it('toKey slugifies the event name', () => {
    expect(toKey('checkout_completed')).toBe('checkout-completed');
    expect(toKey('  Order Shipped!  ')).toBe('order-shipped');
    expect(toKey('###')).toBe('feedback');
  });

  it('defaultThreshold: 4 for star, 3 for emoji', () => {
    expect(defaultThreshold('star')).toBe(4);
    expect(defaultThreshold('emoji')).toBe(3);
  });

  it('buildWorkflow maps answers to a valid deploy payload', () => {
    const wf = buildWorkflow({
      eventName: 'checkout_completed',
      question: 'How was checkout?',
      ratingType: 'star',
      positiveThreshold: 4,
      chips: ['Slow', 'Confusing'],
    });
    expect(wf).toMatchObject({
      key: 'checkout-completed',
      event_name: 'checkout_completed',
      status: 'active',
      metric_type: 'CSAT',
      rating_type: 'star',
      rating_scale_max: 5,
      header_text: 'How was checkout?',
      positive_threshold: 4,
      chips_on_negative: ['Slow', 'Confusing'],
    });
  });

  it('emoji rating → scale max 3', () => {
    expect(
      buildWorkflow({
        eventName: 'e',
        question: 'q',
        ratingType: 'emoji',
        positiveThreshold: 3,
        chips: [],
      }).rating_scale_max,
    ).toBe(3);
  });

  it('trackSnippet emits the Signal.track call', () => {
    expect(trackSnippet('checkout_completed')).toBe("Signal.track('checkout_completed');");
  });
});

describe('runSetup — deploys the built workflow', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'signal-cli-'));
    process.env.SIGNAL_CONFIG_DIR = dir;
    await writeConfig({ api_url: 'http://localhost:3000', token: 'cli_test' });
  });
  afterEach(async () => {
    delete process.env.SIGNAL_CONFIG_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('sends the workflow to /deploy and prints the track() snippet', async () => {
    let sent: unknown[] | undefined;
    const out: string[] = [];
    const deps: CommandDeps = {
      out: (l) => out.push(l),
      makeClient: () =>
        ({
          deploy: async (_token: string, workflows: unknown[]): Promise<DeployResponse> => {
            sent = workflows;
            return {
              results: [
                {
                  key: 'checkout-completed',
                  action: 'created',
                  workflow_id: null,
                  status: 'active',
                  error: null,
                },
              ],
            };
          },
        }) as unknown as CliClient,
    };

    const results = await runSetup(deps, {
      eventName: 'checkout_completed',
      question: 'How was checkout?',
      ratingType: 'star',
      positiveThreshold: 4,
      chips: ['Slow'],
    });

    expect(results[0]?.action).toBe('created');
    expect(sent).toHaveLength(1);
    const sentFirst = sent?.[0] as { event_name: string } | undefined;
    expect(sentFirst?.event_name).toBe('checkout_completed');
    expect(out.join('\n')).toContain("Signal.track('checkout_completed');");
  });

  it('non-interactive: `signal setup --event … --question …` deploys via the program', async () => {
    let sent: unknown[] | undefined;
    const deps: CommandDeps = {
      out: () => {},
      makeClient: () =>
        ({
          deploy: async (_token: string, workflows: unknown[]): Promise<DeployResponse> => {
            sent = workflows;
            return {
              results: [
                {
                  key: 'order-shipped',
                  action: 'created',
                  workflow_id: null,
                  status: 'active',
                  error: null,
                },
              ],
            };
          },
        }) as unknown as CliClient,
    };

    await buildProgram(deps).parseAsync([
      'node',
      'signal',
      'setup',
      '--event',
      'order_shipped',
      '--question',
      'How was delivery?',
      '--rating',
      'emoji',
      '--chips',
      'Late,Damaged',
    ]);

    const wf = sent?.[0] as
      | { event_name: string; rating_type: string; rating_scale_max: number }
      | undefined;
    expect(wf?.event_name).toBe('order_shipped');
    expect(wf?.rating_type).toBe('emoji');
    expect(wf?.rating_scale_max).toBe(3);
  });

  it('requires a login (no token → throws)', async () => {
    await writeConfig({ api_url: 'http://localhost:3000' }); // no token
    const deps: CommandDeps = { out: () => {}, makeClient: () => ({}) as unknown as CliClient };
    await expect(
      runSetup(deps, {
        eventName: 'e',
        question: 'q',
        ratingType: 'star',
        positiveThreshold: 4,
        chips: [],
      }),
    ).rejects.toThrow(/not logged in/);
  });
});
