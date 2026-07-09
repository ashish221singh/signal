import { CreateBucketCommand, PutBucketPolicyCommand, S3Client } from '@aws-sdk/client-s3';
import { uploadTicketSchema } from '@signal/contracts';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/env.js';
import { startTestDb } from './testDb.js';

const APP_KEY = 'test-app-key';
const BUCKET = 'signal-feedback-images';
const ACCESS_KEY = 'signal';
const SECRET_KEY = 'signal_local_dev';
const REGION = 'us-east-1';
const AUTH = { 'x-signal-app-key': APP_KEY };

describe('/v1/sdk/uploads (real MinIO)', () => {
  let container: StartedTestContainer;
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let endpoint: string;

  beforeAll(async () => {
    db = await startTestDb();

    container = await new GenericContainer('minio/minio')
      .withCommand(['server', '/data'])
      .withExposedPorts(9000)
      .withEnvironment({ MINIO_ROOT_USER: ACCESS_KEY, MINIO_ROOT_PASSWORD: SECRET_KEY })
      .start();

    endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;

    // Create the bucket up front via the aws-sdk (path-style for MinIO) and make
    // objects anonymously readable so a plain GET of `object_url` works.
    const admin = new S3Client({
      region: REGION,
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    });
    await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
    await admin.send(
      new PutBucketPolicyCommand({
        Bucket: BUCKET,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { AWS: ['*'] },
              Action: ['s3:GetObject'],
              Resource: [`arn:aws:s3:::${BUCKET}/*`],
            },
          ],
        }),
      }),
    );
    admin.destroy();

    const env = parseEnv({
      NODE_ENV: 'test',
      SIGNAL_APP_KEYS: APP_KEY,
      S3_ENDPOINT: endpoint,
      S3_REGION: REGION,
      S3_BUCKET: BUCKET,
      S3_ACCESS_KEY: ACCESS_KEY,
      S3_SECRET_KEY: SECRET_KEY,
      S3_PUBLIC_URL: `${endpoint}/${BUCKET}`,
    });
    app = await buildApp(env, { db: db.db, closeDb: async () => {} });
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (container) await container.stop();
    if (db) await db.stop();
  });

  it('rejects a request with no app key with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sdk/uploads',
      payload: { content_type: 'image/png' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('presigns a PNG upload and the URL round-trips real bytes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sdk/uploads',
      headers: AUTH,
      payload: { content_type: 'image/png' },
    });
    expect(res.statusCode).toBe(200);
    const ticket = res.json();
    expect(uploadTicketSchema.safeParse(ticket).success).toBe(true);

    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

    const put = await fetch(ticket.upload_url, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: bytes,
    });
    expect(put.status).toBe(200);

    const get = await fetch(ticket.object_url);
    expect(get.status).toBe(200);
    const got = new Uint8Array(await get.arrayBuffer());
    expect(Array.from(got)).toEqual(Array.from(bytes));
  });

  it('rejects a non-image content type with 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sdk/uploads',
      headers: AUTH,
      payload: { content_type: 'application/pdf' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBeDefined();
  });
});
