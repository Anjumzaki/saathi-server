/**
 * The S3 driver for uploaded documents (a licence, a certificate, a government ID).
 *
 * It joins through the registry in `fileStore.ts` and nothing in there, or in any route, changes: the
 * keys are the ones `newKey()` forms, so `keyBelongsTo()` still decides who may read what, and `get()`
 * hands the bytes back to the server, which serves them to the one person entitled to see them. The
 * bucket itself is never readable: objects are private, encrypted at rest, and no ACL is ever sent.
 *
 * With no bucket configured the driver quietly becomes the local-disk one, so switching
 * FILE_STORE_DRIVER=s3 before the bucket exists cannot lose an applicant's licence.
 */
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { log } from '../utils/logger';
import {
  checkUpload, isSafeKey, localDiskFileStore, mimeForExtension, newKey, normaliseMime,
  registerFileStoreDriver, type FileStore, type FileStoreConfig,
} from './fileStore';

export interface S3Settings {
  bucket: string;
  region: string | undefined;
  /** Folder inside the bucket. Never part of the stored key, so keys stay identical to the local driver's. */
  prefix: string;
  /** Set for an S3-compatible service (Spaces, MinIO, Ceph). */
  endpoint: string | undefined;
  serverSideEncryption: 'AES256' | 'aws:kms';
  kmsKeyId: string | undefined;
}

/** Only the two calls this driver makes, so a test can stand in for the client without the network. */
export interface S3Like {
  send(command: unknown): Promise<{ Body?: unknown; ContentType?: string; ContentLength?: number }>;
}

export interface S3Deps {
  client?: S3Like;
  /** Explicit null forces the local-disk fallback; absent reads the environment. */
  settings?: S3Settings | null;
}

const trimmed = (v: string | undefined): string | undefined => {
  const s = v?.trim();
  return s ? s : undefined;
};

/** Null when there is no bucket to write to: that is the signal to stay on local disk. */
export function readS3Settings(env: NodeJS.ProcessEnv = process.env): S3Settings | null {
  const bucket = trimmed(env.FILE_STORE_S3_BUCKET);
  if (!bucket) return null;
  const kmsKeyId = trimmed(env.FILE_STORE_S3_KMS_KEY_ID);
  const asked = trimmed(env.FILE_STORE_S3_SSE)?.toLowerCase();
  return {
    bucket,
    region: trimmed(env.FILE_STORE_S3_REGION) ?? trimmed(env.AWS_REGION),
    // Leading and trailing slashes would make an object called "/x" or a folder with an empty name.
    prefix: (trimmed(env.FILE_STORE_S3_PREFIX) ?? '').replace(/^\/+|\/+$/g, ''),
    endpoint: trimmed(env.FILE_STORE_S3_ENDPOINT),
    // A key means KMS, whatever else was asked for; otherwise the bucket's own AES-256.
    serverSideEncryption: kmsKeyId || asked === 'aws:kms' || asked === 'kms' ? 'aws:kms' : 'AES256',
    kmsKeyId,
  };
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** The bytes of a GetObject body: a real stream, or whatever a stub chose to hand back. */
async function bodyBytes(body: unknown): Promise<Buffer | null> {
  if (!body) return null;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  const asSdk = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof asSdk.transformToByteArray === 'function') return Buffer.from(await asSdk.transformToByteArray());
  const asIterable = body as AsyncIterable<Uint8Array>;
  if (typeof asIterable[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const c of asIterable) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  }
  return null;
}

/** An object that is not there, as against a bucket or a credential that is wrong: only the first is a null. */
function isMissing(e: unknown): boolean {
  const err = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const name = err?.name ?? err?.Code ?? '';
  return name === 'NoSuchKey' || name === 'NotFound' || err?.$metadata?.httpStatusCode === 404;
}

function realClient(s: S3Settings): S3Like {
  // The SDK's `send` is generic over each command; this driver only ever passes its own three.
  return new S3Client({
    ...(s.region ? { region: s.region } : {}),
    ...(s.endpoint ? { endpoint: s.endpoint, forcePathStyle: true } : {}),
  }) as unknown as S3Like;
}

export function s3FileStore(cfg: FileStoreConfig, deps: S3Deps = {}): FileStore {
  const settings = 'settings' in deps ? deps.settings : readS3Settings();
  if (!settings) {
    log.warn('FILE_STORE_DRIVER is s3 but FILE_STORE_S3_BUCKET is not set: documents are staying on local disk');
    return localDiskFileStore(cfg);
  }
  const client = deps.client ?? realClient(settings);
  const objectName = (key: string): string => (settings.prefix ? `${settings.prefix}/${key}` : key);

  return {
    driver: 's3',
    async put({ scope, mime, data }) {
      const problem = checkUpload({ mime, bytes: data.byteLength }, cfg);
      if (problem) throw new Error(`File rejected: ${problem}`);
      const key = newKey(scope, mime);
      const digest = sha256(data);
      await client.send(
        new PutObjectCommand({
          Bucket: settings.bucket,
          Key: objectName(key),
          Body: data,
          ContentLength: data.byteLength,
          ContentType: normaliseMime(mime),
          // Encrypted at rest, and no ACL: the object is reachable only by this server's credentials.
          ServerSideEncryption: settings.serverSideEncryption,
          ...(settings.kmsKeyId ? { SSEKMSKeyId: settings.kmsKeyId } : {}),
          Metadata: { sha256: digest },
        }),
      );
      return { key, mime: normaliseMime(mime), bytes: data.byteLength, sha256: digest, driver: 's3' };
    },
    async get(key) {
      if (!isSafeKey(key)) return null;
      let data: Buffer | null;
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: settings.bucket, Key: objectName(key) }));
        data = await bodyBytes(out.Body);
      } catch (e) {
        if (isMissing(e)) return null;
        throw e;
      }
      if (!data) return null;
      // The type comes from the key, as on local disk, so a wrong ContentType on the object cannot change it.
      return { key, data, bytes: data.byteLength, mime: mimeForExtension(path.extname(key))!, sha256: sha256(data), driver: 's3' };
    },
    async remove(key) {
      if (!isSafeKey(key)) return;
      try {
        await client.send(new DeleteObjectCommand({ Bucket: settings.bucket, Key: objectName(key) }));
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
    },
  };
}

registerFileStoreDriver('s3', (cfg) => s3FileStore(cfg));
