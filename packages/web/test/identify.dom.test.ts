// @vitest-environment happy-dom
import type { Answer } from '@signal/web-core';
import { describe, expect, it, vi } from 'vitest';
import type { Outbox } from '../src/outbox.js';
import { createWebHost } from '../src/webHost.js';

/**
 * F5 end-user identity: the client's own name/email ride along the response wire so
 * the dashboard can show WHO left the feedback. The id is the client's own id.
 */
describe('webHost — end-user traits on the response (F5)', () => {
  function hostWith(traits: { userName?: string; userEmail?: string }) {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const host = createWebHost({
      apiUrl: 'https://api.test',
      publishableKey: 'pk',
      outbox: { enqueue } as unknown as Outbox,
      userId: 'usr_123',
      eventName: 'checkout_completed',
      triggerId: 'trig',
      shownAt: '2026-01-01T00:00:00Z',
      now: () => 0,
      ...traits,
    });
    return { host, enqueue };
  }
  const answer: Answer = { trigger_id: 'trig', rating_value: 5, positive: true };

  it('forwards user_name/user_email onto the response body', async () => {
    const { host, enqueue } = hostWith({ userName: 'John Doe', userEmail: 'john@acme.com' });
    await host.submit(answer);
    expect(enqueue).toHaveBeenCalledWith(
      'response',
      expect.objectContaining({ user_name: 'John Doe', user_email: 'john@acme.com' }),
    );
  });

  it('sends null traits for an anonymous user (no identify)', async () => {
    const { host, enqueue } = hostWith({});
    await host.submit(answer);
    expect(enqueue).toHaveBeenCalledWith(
      'response',
      expect.objectContaining({ user_name: null, user_email: null }),
    );
  });
});
