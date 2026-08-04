/**
 * Debug logging (F2-D10). The SDK never throws into the host app; anything that
 * would degrade the host is swallowed and surfaced here at `debug`. A single dev
 * warning is used for the track-before-init misuse (see index.ts).
 */
export function debug(...args: unknown[]): void {
  if (typeof console !== 'undefined' && typeof console.debug === 'function') {
    console.debug('[signal]', ...args);
  }
}

export function warnOnce(message: string): void {
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(`[signal] ${message}`);
  }
}
