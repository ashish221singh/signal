import { and, eq } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { deviceAuthorizations } from '../db/schema.js';
import type { TokenService } from '../tokens/service.js';
import { generateDeviceCode, generateUserCode, hashDeviceCode } from './deviceCode.js';

/** Device-flow parameters (B3-D3). */
export const DEVICE_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const DEVICE_POLL_INTERVAL_S = 5;

export interface DeviceCodeGrant {
  deviceCode: string;
  userCode: string;
  expiresInS: number;
  intervalS: number;
}

/** Outcome of a poll (B3-D3): pending until approved, then the token exactly once. */
export type PollResult =
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'not_found' }
  | { status: 'approved'; token: string; scopes: string[]; expiresAt: Date };

/**
 * Device-authorization service (B3-D3): the OAuth 2.0 Device Authorization Grant.
 * `requestCode` mints a (device_code, user_code) pair; the session-guarded approval
 * page calls `approve`/`deny` (binding the account); the CLI polls `token`.
 *
 * The token is issued into `cli_tokens` at APPROVE time, and the resulting plaintext
 * is stashed transiently in-process keyed by the row id, to be handed back exactly
 * once on the next successful poll. This keeps the plaintext off the DB entirely.
 */
export class DeviceService {
  // device-auth row id → the plaintext token minted at approval, pending pickup.
  private pendingTokens = new Map<string, { token: string; scopes: string[]; expiresAt: Date }>();

  constructor(
    private readonly db: Db,
    private readonly tokens: TokenService,
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  async requestCode(): Promise<DeviceCodeGrant> {
    const deviceCode = generateDeviceCode();
    const userCode = generateUserCode();
    const expiresAt = new Date(this.clock.now().getTime() + DEVICE_CODE_TTL_MS);
    await this.db.insert(deviceAuthorizations).values({
      deviceCodeHash: hashDeviceCode(deviceCode),
      userCode,
      expiresAt,
    });
    return {
      deviceCode,
      userCode,
      expiresInS: Math.floor(DEVICE_CODE_TTL_MS / 1000),
      intervalS: DEVICE_POLL_INTERVAL_S,
    };
  }

  /** Look up a pending authorization by its human user_code (for the approval page). */
  async findPendingByUserCode(
    userCode: string,
  ): Promise<{ id: string; status: 'pending'; expired: boolean } | { status: 'not_found' }> {
    const [row] = await this.db
      .select()
      .from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.userCode, userCode))
      .limit(1);
    if (!row) return { status: 'not_found' };
    const expired = row.expiresAt.getTime() <= this.clock.now().getTime();
    return { id: row.id, status: 'pending', expired: expired || row.status !== 'pending' };
  }

  /**
   * Approve a pending authorization by user_code, binding `accountId` and minting
   * the CLI token now (stashed for one-time pickup). Returns whether it succeeded.
   */
  async approve(userCode: string, accountId: string): Promise<boolean> {
    const [row] = await this.db
      .select()
      .from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.userCode, userCode))
      .limit(1);
    if (!row) return false;
    if (row.status !== 'pending') return false;
    if (row.expiresAt.getTime() <= this.clock.now().getTime()) {
      await this.db
        .update(deviceAuthorizations)
        .set({ status: 'expired' })
        .where(eq(deviceAuthorizations.id, row.id));
      return false;
    }

    const { token, meta } = await this.tokens.issue(accountId, `device-${row.userCode}`);
    const [updated] = await this.db
      .update(deviceAuthorizations)
      .set({ status: 'approved', accountId })
      .where(and(eq(deviceAuthorizations.id, row.id), eq(deviceAuthorizations.status, 'pending')))
      .returning({ id: deviceAuthorizations.id });
    if (!updated) return false; // lost a race
    this.pendingTokens.set(row.id, {
      token,
      scopes: meta.scopes,
      expiresAt: new Date(meta.expires_at),
    });
    return true;
  }

  /** Deny a pending authorization by user_code. */
  async deny(userCode: string): Promise<boolean> {
    const [row] = await this.db
      .update(deviceAuthorizations)
      .set({ status: 'denied' })
      .where(
        and(
          eq(deviceAuthorizations.userCode, userCode),
          eq(deviceAuthorizations.status, 'pending'),
        ),
      )
      .returning({ id: deviceAuthorizations.id });
    return Boolean(row);
  }

  /**
   * Poll with the device_code (B3-D3). Returns `pending` until approved; on the
   * FIRST poll after approval, returns the token exactly once. The token is stashed
   * in-process at approval and dropped here on pickup, so a re-poll finds nothing
   * stashed and returns `not_found` (the token has already been issued — the CLI
   * must not receive it twice). Expiry is checked lazily on poll.
   */
  async token(deviceCode: string): Promise<PollResult> {
    const [row] = await this.db
      .select()
      .from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.deviceCodeHash, hashDeviceCode(deviceCode)))
      .limit(1);
    if (!row) return { status: 'not_found' };

    const now = this.clock.now();
    if (row.status === 'denied') return { status: 'denied' };
    if (row.status === 'expired') return { status: 'expired' };
    if (row.status === 'pending') {
      if (row.expiresAt.getTime() <= now.getTime()) {
        await this.db
          .update(deviceAuthorizations)
          .set({ status: 'expired' })
          .where(eq(deviceAuthorizations.id, row.id));
        return { status: 'expired' };
      }
      return { status: 'pending' };
    }
    // approved: hand back the stashed token exactly once.
    const stashed = this.pendingTokens.get(row.id);
    if (!stashed) return { status: 'not_found' }; // already collected
    this.pendingTokens.delete(row.id);
    return {
      status: 'approved',
      token: stashed.token,
      scopes: stashed.scopes,
      expiresAt: stashed.expiresAt,
    };
  }
}
