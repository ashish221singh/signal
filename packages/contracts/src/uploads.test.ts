import { describe, expect, it } from 'vitest';
import { uploadRequestSchema, uploadTicketSchema } from './index.js';

describe('uploadRequestSchema', () => {
  it('accepts a valid image content type', () => {
    expect(uploadRequestSchema.safeParse({ content_type: 'image/png' }).success).toBe(true);
    expect(uploadRequestSchema.safeParse({ content_type: 'image/jpeg' }).success).toBe(true);
    expect(uploadRequestSchema.safeParse({ content_type: 'image/webp' }).success).toBe(true);
  });
  it('rejects a non-image content type', () => {
    expect(uploadRequestSchema.safeParse({ content_type: 'application/pdf' }).success).toBe(false);
    expect(uploadRequestSchema.safeParse({ content_type: 'text/plain' }).success).toBe(false);
    expect(uploadRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('uploadTicketSchema', () => {
  it('accepts a well-formed ticket', () => {
    const r = uploadTicketSchema.safeParse({
      upload_url: 'https://s3.example.com/bucket/feedback/x.png?sig=abc',
      object_url: 'https://cdn.example.com/bucket/feedback/x.png',
      key: 'feedback/x.png',
    });
    expect(r.success).toBe(true);
  });
  it('rejects a ticket with a non-URL upload_url', () => {
    const r = uploadTicketSchema.safeParse({
      upload_url: 'not-a-url',
      object_url: 'https://cdn.example.com/bucket/feedback/x.png',
      key: 'feedback/x.png',
    });
    expect(r.success).toBe(false);
  });
});
