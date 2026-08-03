import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../env.js';

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function makeS3(env: Env): S3Client {
  return new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: true, // MinIO
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  });
}

/**
 * Per-account S3 key prefix (B4-D1). Every object an account uploads lives under
 * `acct/<accountId>/…`, giving hard object isolation across tenants. The presign
 * only ever issues a key inside the caller's own prefix, and `/response`
 * validates a supplied `other_image_url` sits under it before storage (a forged
 * URL for another account's prefix is rejected).
 */
export function accountPrefix(accountId: string): string {
  return `acct/${accountId}/`;
}

export async function presignUpload(
  s3: S3Client,
  env: Env,
  accountId: string,
  contentType: string,
): Promise<{ upload_url: string; object_url: string; key: string }> {
  const key = `${accountPrefix(accountId)}feedback/${randomUUID()}.${EXT[contentType] ?? 'bin'}`;
  const upload_url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: 300 },
  );
  return { upload_url, object_url: `${env.S3_PUBLIC_URL}/${key}`, key };
}

/**
 * True when `url` is a well-formed object URL under the caller's account prefix,
 * i.e. `${S3_PUBLIC_URL}/acct/<accountId>/…` (B4-D1). Used to reject a forged
 * cross-account image URL on `/response`. A null/empty URL is treated as "no
 * image supplied" and is allowed by the caller.
 */
export function isUrlUnderAccountPrefix(env: Env, accountId: string, url: string): boolean {
  const expectedBase = `${env.S3_PUBLIC_URL.replace(/\/$/, '')}/${accountPrefix(accountId)}`;
  return url.startsWith(expectedBase);
}
