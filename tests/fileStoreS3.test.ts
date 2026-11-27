import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dietitianScope, keyBelongsTo, makeFileStore, readFileStoreConfig, resetFileStore } from '../src/services/fileStore';
import { readS3Settings, s3FileStore, type S3Like, type S3Settings } from '../src/services/fileStoreS3';
import { fileStoreWarnings, loadEnv } from '../src/config/env';

const SCOPE = dietitianScope('64b7f1c2d3e4f5a6b7c8d9e0');
const OTHER = dietitianScope('64b7f1c2d3e4f5a6b7c8d9e1');

const cfg = (root: string) => ({ driver: 's3', root, maxBytes: 1000, allowedMimeTypes: ['application/pdf', 'image/jpeg'] });
const settings = (over: Partial<S3Settings> = {}): S3Settings => ({
  bucket: 'saathi-docs', region: 'eu-west-1', prefix: '', endpoint: undefined,
  serverSideEncryption: 'AES256', kmsKeyId: undefined, ...over,
});

interface Sent {
  name: string;
  input: Record<string, unknown>;
}

/** Stands in for the real client: remembers every command and keeps the objects in a map. */
function stubClient(): { client: S3Like; sent: Sent[]; objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  const sent: Sent[] = [];
  const client: S3Like = {
    async send(command: unknown) {
      const c = command as { constructor: { name: string }; input: Record<string, unknown> };
      sent.push({ name: c.constructor.name, input: c.input });
      const key = String(c.input['Key']);
      if (c.constructor.name === 'PutObjectCommand') {
        objects.set(key, Buffer.from(c.input['Body'] as Buffer));
        return {};
      }
      if (c.constructor.name === 'DeleteObjectCommand') {
        objects.delete(key);
        return {};
      }
      const data = objects.get(key);
      if (!data) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      // The real SDK hands back a stream with this helper on it.
      return { Body: { transformToByteArray: async () => new Uint8Array(data) } };
    },
  };
  return { client, sent, objects };
}

let root = '';
beforeAll(async () => { root = await mkdtemp(path.join(tmpdir(), 'saathi-s3-test-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); resetFileStore(); });

describe('the S3 driver', () => {
  it('puts, gets and deletes the same bytes, under a key the local driver would have made', async () => {
    const { client, objects } = stubClient();
    const store = s3FileStore(cfg(root), { client, settings: settings() });
    expect(store.driver).toBe('s3');

    const data = Buffer.from('%PDF-1.4 licence');
    const stored = await store.put({ scope: SCOPE, mime: 'application/pdf', data });
    expect(stored).toMatchObject({ mime: 'application/pdf', bytes: data.byteLength, driver: 's3' });
    expect(stored.key.startsWith(`${SCOPE}/`)).toBe(true);
    expect(stored.key.endsWith('.pdf')).toBe(true);
    // The isolation rule the routes rely on still holds, because the key is formed the same way.
    expect(keyBelongsTo(stored.key, SCOPE)).toBe(true);
    expect(keyBelongsTo(stored.key, OTHER)).toBe(false);

    const got = await store.get(stored.key);
    expect(got?.data.equals(data)).toBe(true);
    expect(got).toMatchObject({ mime: 'application/pdf', bytes: data.byteLength, driver: 's3', sha256: stored.sha256 });

    await store.remove(stored.key);
    expect(objects.size).toBe(0);
    expect(await store.get(stored.key)).toBeNull();
  });

  it('keeps every object private and encrypted, and never sends an ACL', async () => {
    const { client, sent } = stubClient();
    const store = s3FileStore(cfg(root), { client, settings: settings() });
    await store.put({ scope: SCOPE, mime: 'image/jpeg', data: Buffer.from('jpegbytes') });
    const put = sent.find((s) => s.name === 'PutObjectCommand')!;
    expect(put.input['Bucket']).toBe('saathi-docs');
    expect(put.input['ServerSideEncryption']).toBe('AES256');
    expect(put.input['ContentType']).toBe('image/jpeg');
    expect(put.input['ACL']).toBeUndefined();
    expect(JSON.stringify(Object.keys(put.input))).not.toContain('ACL');
  });

  it('uses the KMS key when there is one', async () => {
    const { client, sent } = stubClient();
    const store = s3FileStore(cfg(root), { client, settings: settings({ serverSideEncryption: 'aws:kms', kmsKeyId: 'arn:aws:kms:key/1' }) });
    await store.put({ scope: SCOPE, mime: 'image/jpeg', data: Buffer.from('jpegbytes') });
    expect(sent[0]!.input).toMatchObject({ ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'arn:aws:kms:key/1' });
  });

  it('a prefix moves the object, not the key', async () => {
    const { client, sent } = stubClient();
    const store = s3FileStore(cfg(root), { client, settings: settings({ prefix: 'live' }) });
    const stored = await store.put({ scope: SCOPE, mime: 'application/pdf', data: Buffer.from('pdf') });
    expect(sent[0]!.input['Key']).toBe(`live/${stored.key}`);
    expect(stored.key).not.toContain('live/');
    // And it reads back through the same mapping.
    expect((await store.get(stored.key))?.data.toString()).toBe('pdf');
  });

  it('refuses a file over the limit or of a type we do not serve, before anything is sent', async () => {
    const { client, sent } = stubClient();
    const store = s3FileStore(cfg(root), { client, settings: settings() });
    await expect(store.put({ scope: SCOPE, mime: 'application/pdf', data: Buffer.alloc(1001) })).rejects.toThrow(/too_big/);
    await expect(store.put({ scope: SCOPE, mime: 'application/zip', data: Buffer.from('x') })).rejects.toThrow();
    await expect(store.put({ scope: SCOPE, mime: 'application/pdf', data: Buffer.alloc(0) })).rejects.toThrow(/empty/);
    expect(sent).toEqual([]);
  });

  it('answers null for a key it does not have and for one it should never touch', async () => {
    const { client, sent } = stubClient();
    const store = s3FileStore(cfg(root), { client, settings: settings() });
    expect(await store.get(`${SCOPE}/0f1e2d3c-1111-2222-3333-444455556666.pdf`)).toBeNull();
    for (const bad of ['../../etc/passwd', '/etc/passwd.pdf', `${SCOPE}/../x.pdf`, 'x.exe', '']) {
      expect(await store.get(bad), bad).toBeNull();
    }
    await expect(store.remove('../nope.pdf')).resolves.toBeUndefined();
    // An unsafe key never reaches the bucket at all.
    expect(sent.filter((s) => s.name !== 'GetObjectCommand')).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it('does not hide a wrong bucket or a bad credential as a missing document', async () => {
    const client: S3Like = { async send() { throw Object.assign(new Error('no'), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 403 } }); } };
    const store = s3FileStore(cfg(root), { client, settings: settings() });
    await expect(store.get(`${SCOPE}/0f1e2d3c-1111-2222-3333-444455556666.pdf`)).rejects.toThrow(/no/);
  });
});

describe('with no bucket configured', () => {
  it('keeps using local disk rather than losing a licence', async () => {
    const store = s3FileStore(cfg(root), { settings: null });
    expect(store.driver).toBe('local');
    const stored = await store.put({ scope: SCOPE, mime: 'application/pdf', data: Buffer.from('on disk') });
    expect(stored.driver).toBe('local');
    expect((await store.get(stored.key))?.data.toString()).toBe('on disk');
  });
  it('reads nothing out of an environment without a bucket', () => {
    expect(readS3Settings({})).toBeNull();
    expect(readS3Settings({ FILE_STORE_S3_BUCKET: '  ' })).toBeNull();
  });
  it('and the registry still answers for the s3 driver', () => {
    const store = makeFileStore({ ...readFileStoreConfig({ FILE_STORE_DRIVER: 's3' }), root });
    // Registered, built, and quietly local until a bucket exists.
    expect(store.driver).toBe('local');
    resetFileStore();
  });
});

describe('S3 settings from the environment', () => {
  it('reads the bucket, region, prefix and endpoint', () => {
    const s = readS3Settings({
      FILE_STORE_S3_BUCKET: ' saathi-docs ', FILE_STORE_S3_REGION: 'me-south-1',
      FILE_STORE_S3_PREFIX: '/live/', FILE_STORE_S3_ENDPOINT: 'https://fra1.digitaloceanspaces.com',
    });
    expect(s).toMatchObject({ bucket: 'saathi-docs', region: 'me-south-1', prefix: 'live', endpoint: 'https://fra1.digitaloceanspaces.com' });
  });
  it('falls back to AWS_REGION, and encrypts with AES256 unless a KMS key says otherwise', () => {
    expect(readS3Settings({ FILE_STORE_S3_BUCKET: 'b', AWS_REGION: 'eu-west-1' })?.region).toBe('eu-west-1');
    expect(readS3Settings({ FILE_STORE_S3_BUCKET: 'b' })?.serverSideEncryption).toBe('AES256');
    expect(readS3Settings({ FILE_STORE_S3_BUCKET: 'b', FILE_STORE_S3_KMS_KEY_ID: 'k' })?.serverSideEncryption).toBe('aws:kms');
    expect(readS3Settings({ FILE_STORE_S3_BUCKET: 'b', FILE_STORE_S3_SSE: 'aws:kms' })?.serverSideEncryption).toBe('aws:kms');
  });
});

describe('the file store in production configuration', () => {
  const prod = { NODE_ENV: 'production', RESEND_API_KEY: 're_x', MONGODB_URI: 'mongodb://h/db', JWT_ACCESS_SECRET: 'x'.repeat(40), JWT_REFRESH_SECRET: 'y'.repeat(40), OTP_PEPPER: 'z'.repeat(40) };

  it('says plainly when an uploaded licence would not survive a restart', () => {
    expect(fileStoreWarnings({}).join(' ')).toContain('lost on the next restart');
    expect(fileStoreWarnings({ FILE_STORE_ROOT: '/srv/saathi-files' })).toEqual([]);
    // Nothing to warn about once the documents are in a bucket.
    expect(fileStoreWarnings({ FILE_STORE_DRIVER: 's3' })).toEqual([]);
  });
  it('refuses to start on S3 with no bucket, which would quietly fall back to disk', () => {
    expect(() => loadEnv({ ...prod, FILE_STORE_DRIVER: 's3' })).toThrow(/FILE_STORE_S3_BUCKET/);
    expect(() => loadEnv({ ...prod, FILE_STORE_DRIVER: 's3', FILE_STORE_S3_BUCKET: 'saathi-docs' })).not.toThrow();
  });
  it('carries the file-store settings, whatever case the driver was written in', () => {
    const env = loadEnv({ FILE_STORE_DRIVER: 'S3', FILE_STORE_ROOT: '/srv/files', FILE_STORE_MAX_BYTES: '8000000', FILE_STORE_MIME_TYPES: 'application/pdf, image/jpeg' });
    expect(env).toMatchObject({ FILE_STORE_DRIVER: 's3', FILE_STORE_ROOT: '/srv/files', FILE_STORE_MAX_BYTES: 8_000_000 });
    expect(env.FILE_STORE_MIME_TYPES).toEqual(['application/pdf', 'image/jpeg']);
  });
});
