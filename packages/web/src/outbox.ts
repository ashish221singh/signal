/**
 * Durable response/dismiss outbox (F2-D18). Responses are precious: they are
 * written to an IndexedDB store FIRST, then flushed to `/v1/sdk/response` (or
 * `/dismiss`) with retry + exponential backoff. Idempotency is the server's job
 * (dedup on `trigger_id`), so a double-flush is a benign 200/204.
 *
 * Flush triggers: on construction (page load), `online`, `visibilitychange`
 * (→visible), and a best-effort keepalive flush on `pagehide`. Records are dropped
 * after `maxAttempts` (8) or `maxAge` (7d), logged, never infinite-looped.
 *
 * The last-ditch unload flush uses `fetch(..., { keepalive: true })` rather than
 * `navigator.sendBeacon`: the backend authenticates only via the
 * `X-Signal-App-Key` HEADER (see apps/api publishableKeyAuth) and `sendBeacon`
 * cannot set request headers, so a beacon would 401. `keepalive` fetch is the
 * modern replacement that survives unload AND can carry the header.
 *
 * Storage fallback (F2-D12): if IndexedDB is unavailable (private mode / blocked)
 * the outbox degrades to an in-memory queue (same flush loop + keepalive on
 * unload), logging the degraded mode. The public surface is identical either way.
 */
import { debug } from './log.js';

export type OutboxEndpoint = 'response' | 'dismiss';

export interface OutboxRecord {
  id: string;
  endpoint: OutboxEndpoint;
  payload: unknown;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
}

export interface OutboxConfig {
  apiUrl: string;
  publishableKey: string;
  maxAttempts?: number;
  maxAgeMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  fetchImpl?: typeof fetch;
}

const DB_NAME = 'signal';
const STORE = 'outbox';
const DB_VERSION = 1;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Backoff schedule (ms) indexed by prior attempts, capped at the last value. */
const BACKOFF_MS = [0, 1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000];

function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)] ?? 3_600_000;
}

/** Abstract storage so IndexedDB and the in-memory fallback share the flush loop. */
interface Store {
  readonly durable: boolean;
  put(record: OutboxRecord): Promise<void>;
  all(): Promise<OutboxRecord[]>;
  delete(id: string): Promise<void>;
}

class MemoryStore implements Store {
  readonly durable = false;
  private map = new Map<string, OutboxRecord>();
  async put(record: OutboxRecord): Promise<void> {
    this.map.set(record.id, record);
  }
  async all(): Promise<OutboxRecord[]> {
    return [...this.map.values()];
  }
  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

class IdbStore implements Store {
  readonly durable = true;
  private constructor(private readonly db: IDBDatabase) {}

  static open(): Promise<IdbStore> {
    return new Promise((resolve, reject) => {
      const idb = globalThis.indexedDB;
      if (!idb) {
        reject(new Error('indexedDB unavailable'));
        return;
      }
      const req = idb.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(new IdbStore(req.result));
      req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    });
  }

  async put(record: OutboxRecord): Promise<void> {
    const tx = this.db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async all(): Promise<OutboxRecord[]> {
    const tx = this.db.transaction(STORE, 'readonly');
    return (await promisify(tx.objectStore(STORE).getAll())) as OutboxRecord[];
  }

  async delete(id: string): Promise<void> {
    const tx = this.db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
}

export class Outbox {
  private storePromise: Promise<Store>;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly maxAgeMs: number;
  private flushing = false;
  private listenersBound = false;

  constructor(private readonly config: OutboxConfig) {
    this.now = config.now ?? (() => Date.now());
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    this.maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.storePromise = IdbStore.open().catch((err) => {
      debug('IndexedDB unavailable — outbox degraded to in-memory + beacon', err);
      return new MemoryStore();
    });
    this.bindLifecycle();
  }

  /** True once the durable store resolved (test convenience). */
  async isDurable(): Promise<boolean> {
    return (await this.storePromise).durable;
  }

  private url(endpoint: OutboxEndpoint): string {
    return `${this.config.apiUrl.replace(/\/$/, '')}/v1/sdk/${endpoint}`;
  }

  private idFor(record: { endpoint: OutboxEndpoint; payload: unknown }): string {
    // Idempotency subject is the server trigger_id; use it as the record id so a
    // duplicate enqueue for the same trigger+endpoint coalesces client-side too.
    const triggerId =
      record.payload && typeof record.payload === 'object'
        ? (record.payload as { trigger_id?: unknown }).trigger_id
        : undefined;
    const tid = typeof triggerId === 'string' ? triggerId : Math.random().toString(36).slice(2);
    return `${record.endpoint}:${tid}`;
  }

  /** Enqueue durably, then kick a flush. Resolves once persisted/queued (F2-D18). */
  async enqueue(endpoint: OutboxEndpoint, payload: unknown): Promise<void> {
    const store = await this.storePromise;
    const record: OutboxRecord = {
      id: this.idFor({ endpoint, payload }),
      endpoint,
      payload,
      attempts: 0,
      nextAttemptAt: this.now(),
      createdAt: this.now(),
    };
    await store.put(record);
    // Fire-and-forget the flush; the response is already durable.
    void this.flush();
  }

  /** Attempt to send every due record once. Safe to call concurrently. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const store = await this.storePromise;
      const records = await store.all();
      const now = this.now();
      for (const record of records) {
        // Drop stale records (F2-D18).
        if (now - record.createdAt > this.maxAgeMs) {
          debug('outbox: dropping aged-out record', record.id);
          await store.delete(record.id);
          continue;
        }
        if (record.nextAttemptAt > now) continue;
        const ok = await this.send(record);
        if (ok) {
          await store.delete(record.id);
          continue;
        }
        const attempts = record.attempts + 1;
        if (attempts >= this.maxAttempts) {
          debug('outbox: dropping record after max attempts', record.id);
          await store.delete(record.id);
          continue;
        }
        await store.put({
          ...record,
          attempts,
          nextAttemptAt: now + backoffFor(attempts),
        });
      }
    } finally {
      this.flushing = false;
    }
  }

  /** POST one record. Returns true when the server accepted (2xx) or permanently
   *  rejected it (4xx that won't succeed on retry — dedup/validation): either way
   *  it should leave the queue. Network/5xx/429 → retry. */
  private async send(record: OutboxRecord): Promise<boolean> {
    if (!this.fetchImpl) return false;
    try {
      const res = await this.fetchImpl(this.url(record.endpoint), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Signal-App-Key': this.config.publishableKey,
        },
        body: JSON.stringify(record.payload),
        keepalive: true,
      });
      if (res.status >= 200 && res.status < 300) return true;
      // 404 unknown_trigger / 422 validation are permanent — retrying can't help.
      if (res.status === 404 || res.status === 422) {
        debug('outbox: permanent rejection, dropping', record.id, res.status);
        return true;
      }
      // 401/429/5xx → retry later.
      return false;
    } catch (err) {
      debug('outbox: send failed, will retry', record.id, err);
      return false;
    }
  }

  /** Best-effort flush on page unload using keepalive fetch (F2-D18/D12). Unlike
   *  sendBeacon this can carry the X-Signal-App-Key header the backend requires. */
  private unloadFlush(records: OutboxRecord[]): void {
    if (!this.fetchImpl) return;
    const now = this.now();
    for (const record of records) {
      if (record.nextAttemptAt > now) continue;
      try {
        void this.fetchImpl(this.url(record.endpoint), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Signal-App-Key': this.config.publishableKey,
          },
          body: JSON.stringify(record.payload),
          keepalive: true,
        });
      } catch (err) {
        debug('outbox: unload flush failed', err);
      }
    }
  }

  private bindLifecycle(): void {
    if (this.listenersBound) return;
    this.listenersBound = true;
    const g = globalThis as unknown as {
      addEventListener?: (t: string, cb: () => void) => void;
      document?: { visibilityState?: string };
    };
    if (typeof g.addEventListener !== 'function') return;
    g.addEventListener('online', () => void this.flush());
    g.addEventListener('visibilitychange', () => {
      if (g.document?.visibilityState === 'visible') void this.flush();
    });
    g.addEventListener('pagehide', () => {
      // Last-ditch: keepalive-flush anything still queued (survives unload).
      void this.storePromise.then((store) => store.all()).then((r) => this.unloadFlush(r));
    });
  }
}
