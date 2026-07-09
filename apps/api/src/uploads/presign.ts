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

export async function presignUpload(
  s3: S3Client,
  env: Env,
  contentType: string,
): Promise<{ upload_url: string; object_url: string; key: string }> {
  const key = `feedback/${randomUUID()}.${EXT[contentType] ?? 'bin'}`;
  const upload_url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: 300 },
  );
  return { upload_url, object_url: `${env.S3_PUBLIC_URL}/${key}`, key };
}
