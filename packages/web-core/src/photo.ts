/**
 * Client-side photo guardrails (F1-D7). Type allow-list (jpg/png/webp), downscale
 * to a max dimension, and a post-downscale size cap. Everything here is pure DOM
 * (canvas) — the actual upload is the host's job via requestUpload.
 */

export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_DIMENSION = 1600; // px, longest edge
export const MAX_BYTES = 5 * 1024 * 1024; // 5 MB after downscale

export type PhotoResult =
  | { ok: true; file: File }
  | { ok: false; reason: 'type' | 'too_large' | 'decode' };

function isAllowedType(type: string): boolean {
  return (ALLOWED_TYPES as readonly string[]).includes(type);
}

/**
 * Validate + (if needed) downscale an image file. Returns a File ready for
 * host.requestUpload, or a rejection reason. In non-DOM/test environments where
 * canvas isn't available, we skip downscale and enforce only type + raw size.
 */
export async function processPhoto(file: File): Promise<PhotoResult> {
  if (!isAllowedType(file.type)) return { ok: false, reason: 'type' };

  // If canvas isn't available (e.g. happy-dom without image decode), fall back to
  // a raw size check so oversized files are still rejected.
  const canDecode =
    typeof document !== 'undefined' &&
    typeof (globalThis as { createImageBitmap?: unknown }).createImageBitmap === 'function' &&
    typeof HTMLCanvasElement !== 'undefined';

  if (!canDecode) {
    if (file.size > MAX_BYTES) return { ok: false, reason: 'too_large' };
    return { ok: true, file };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, reason: 'decode' };
  }

  const { width, height } = bitmap;
  const longest = Math.max(width, height);
  const scale = longest > MAX_DIMENSION ? MAX_DIMENSION / longest : 1;

  if (scale === 1 && file.size <= MAX_BYTES) {
    bitmap.close?.();
    return { ok: true, file };
  }

  const targetW = Math.round(width * scale);
  const targetH = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close?.();
    if (file.size > MAX_BYTES) return { ok: false, reason: 'too_large' };
    return { ok: true, file };
  }
  ctx.drawImage(bitmap, 0, 0, targetW, targetH);
  bitmap.close?.();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85);
  });
  if (!blob) return { ok: false, reason: 'decode' };
  if (blob.size > MAX_BYTES) return { ok: false, reason: 'too_large' };

  const out = new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' });
  return { ok: true, file: out };
}
