/**
 * Pure slug helper (M2, Task 14). Derives a target's `screen_id` from its
 * display name server-side so the SDK integration key is deterministic and not
 * PM-typed.
 *
 * Rules:
 * - lowercase the whole string;
 * - replace every run of non-alphanumeric characters with a single `_`;
 * - trim leading/trailing `_`.
 *
 * Digits are preserved. An input with no alphanumeric characters (e.g. `"!!!"`)
 * slugifies to `''`; the caller treats an empty slug as an invalid name.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
