/**
 * Where an uploaded document actually lives.
 *
 * The routes only ever see the `FileStore` interface and `getFileStore()`, so the real storage can be
 * swapped without touching them: a driver registers itself by name and `FILE_STORE_DRIVER` picks it.
 * The local-disk driver below is the one that works today; an S3 driver slots in beside it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface FileStoreConfig {
  driver: string;
  /** Local driver: the folder files are written to. Deliberately outside the repo. */
  root: string;
  /** Biggest single file, in decoded bytes. */
  maxBytes: number;
  allowedMimeTypes: string[];
}

export interface PutInput {
  /** Owner-scoped prefix, e.g. `dietitians/<userId>`. Keys of one scope are never readable from another. */
  scope: string;
  mime: string;
  data: Buffer;
}
export interface StoredFile {
  key: string;
  mime: string;
  bytes: number;
  /** Lets a later upload of the same file be recognised without keeping the bytes around. */
  sha256: string;
  driver: string;
}
export interface FetchedFile extends StoredFile {
  data: Buffer;
}

export interface FileStore {
  readonly driver: string;
  /** Stores the bytes and returns the key to keep. The caller's filename is never used. */
  put(input: PutInput): Promise<StoredFile>;
  /** Null when the key is unknown or unsafe. */
  get(key: string): Promise<FetchedFile | null>;
  remove(key: string): Promise<void>;
}

// ---------- what may be uploaded ----------

/** One extension per type, both ways: the key carries the type, so nothing else has to store it. */
const MIME_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const EXT_MIME: Record<string, string> = Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m]));

export const SUPPORTED_MIME_TYPES = Object.keys(MIME_EXT);
export const DEFAULT_MAX_BYTES = 600_000;

export const normaliseMime = (mime: string): string => mime.trim().toLowerCase().split(';')[0]!.trim();
export const extensionForMime = (mime: string): string | null => MIME_EXT[normaliseMime(mime)] ?? null;
export const mimeForExtension = (ext: string): string | null => EXT_MIME[ext.trim().toLowerCase().replace(/^\./, '')] ?? null;

export type UploadProblem = 'empty' | 'too_big' | 'mime_not_allowed';

/** Pure gate for an upload: size and type only, before a single byte is written. */
export function checkUpload(file: { mime: string; bytes: number }, cfg: Pick<FileStoreConfig, 'maxBytes' | 'allowedMimeTypes'>): UploadProblem | null {
  const mime = normaliseMime(file.mime);
  if (!Number.isFinite(file.bytes) || file.bytes <= 0) return 'empty';
  if (file.bytes > cfg.maxBytes) return 'too_big';
  if (!cfg.allowedMimeTypes.map(normaliseMime).includes(mime) || !MIME_EXT[mime]) return 'mime_not_allowed';
  return null;
}

/** Message for her, naming the limit that was hit. */
export function uploadProblemMessage(p: UploadProblem, cfg: Pick<FileStoreConfig, 'maxBytes'>): string {
  if (p === 'empty') return 'That file looks empty. Pick it again.';
  if (p === 'too_big') return `That file is too large. The limit is ${Math.floor(cfg.maxBytes / 1000)} KB.`;
  return 'Send a PDF or a photo (JPEG, PNG or WebP).';
}

// ---------- keys ----------

const SCOPE_RE = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/i;
const KEY_RE = /^[a-z0-9][a-z0-9_/-]*\.[a-z0-9]{2,8}$/i;

/** A key we are willing to touch: no traversal, no absolute path, no surprises from an old record. */
export function isSafeKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0 || key.length > 200) return false;
  if (key.includes('..') || key.includes('//') || key.startsWith('/') || key.includes('\\') || key.includes('\0')) return false;
  if (!KEY_RE.test(key)) return false;
  return mimeForExtension(path.extname(key)) !== null;
}

/** The owner prefix of a key, or null when the key is unsafe or has none. */
export function keyScope(key: string): string | null {
  if (!isSafeKey(key)) return null;
  const at = key.lastIndexOf('/');
  return at > 0 ? key.slice(0, at) : null;
}

/** The isolation rule: a document is readable only through the scope it was stored under. */
export const keyBelongsTo = (key: string, scope: string): boolean => keyScope(key) === scope;

/** A fresh key. Nothing from the uploader's filename reaches it: random name, extension from the type. */
export function newKey(scope: string, mime: string): string {
  if (!SCOPE_RE.test(scope)) throw new Error('Invalid file scope');
  const ext = extensionForMime(mime);
  if (!ext) throw new Error(`Unsupported media type: ${mime}`);
  return `${scope}/${randomUUID()}.${ext}`;
}

/** Scope prefix for one dietitian's documents. */
export const dietitianScope = (userId: string): string => `dietitians/${String(userId).toLowerCase()}`;

// ---------- configuration ----------

const csv = (v: string | undefined, fallback: string[]): string[] => {
  const out = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return out.length ? out : fallback;
};
const int = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

/**
 * Read from the environment rather than config/env.ts, so this slice carries its own settings. The
 * default root is a temporary folder: a real deployment sets FILE_STORE_ROOT to a persistent volume
 * or switches the driver to S3.
 */
export function readFileStoreConfig(env: NodeJS.ProcessEnv = process.env): FileStoreConfig {
  return {
    driver: (env.FILE_STORE_DRIVER ?? 'local').trim().toLowerCase(),
    root: env.FILE_STORE_ROOT?.trim() || path.join(tmpdir(), 'saathi-files'),
    maxBytes: int(env.FILE_STORE_MAX_BYTES, DEFAULT_MAX_BYTES),
    allowedMimeTypes: csv(env.FILE_STORE_MIME_TYPES, SUPPORTED_MIME_TYPES),
  };
}

// ---------- local disk driver ----------

export function localDiskFileStore(cfg: FileStoreConfig): FileStore {
  const root = path.resolve(cfg.root);
  /** Resolve inside the root and prove it stayed there, whatever the key claimed. */
  const fileOf = (key: string): string | null => {
    if (!isSafeKey(key)) return null;
    const full = path.resolve(root, key);
    return full === root || full.startsWith(root + path.sep) ? full : null;
  };
  return {
    driver: 'local',
    async put({ scope, mime, data }) {
      const problem = checkUpload({ mime, bytes: data.byteLength }, cfg);
      if (problem) throw new Error(`File rejected: ${problem}`);
      const key = newKey(scope, mime);
      const full = fileOf(key)!;
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, data, { mode: 0o600 });
      return { key, mime: normaliseMime(mime), bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex'), driver: 'local' };
    },
    async get(key) {
      const full = fileOf(key);
      if (!full) return null;
      try {
        const s = await stat(full);
        if (!s.isFile()) return null;
        const data = await readFile(full);
        return {
          key, data, bytes: data.byteLength, mime: mimeForExtension(path.extname(key))!,
          sha256: createHash('sha256').update(data).digest('hex'), driver: 'local',
        };
      } catch {
        return null;
      }
    },
    async remove(key) {
      const full = fileOf(key);
      if (full) await rm(full, { force: true });
    },
  };
}

// ---------- driver registry ----------

export type FileStoreDriver = (cfg: FileStoreConfig) => FileStore;

const drivers = new Map<string, FileStoreDriver>([['local', localDiskFileStore]]);

/** How another driver joins: `registerFileStoreDriver('s3', s3FileStore)` at start-up. */
export function registerFileStoreDriver(name: string, driver: FileStoreDriver): void {
  drivers.set(name.trim().toLowerCase(), driver);
}
export const fileStoreDrivers = (): string[] => [...drivers.keys()];

export function makeFileStore(cfg: FileStoreConfig = readFileStoreConfig()): FileStore {
  const driver = drivers.get(cfg.driver);
  if (!driver) throw new Error(`Unknown FILE_STORE_DRIVER "${cfg.driver}". Known drivers: ${fileStoreDrivers().join(', ')}`);
  return driver(cfg);
}

let current: { store: FileStore; cfg: FileStoreConfig } | undefined;

/** The one store the routes use. Built on first use so a driver registered at start-up is picked up. */
export function getFileStore(): FileStore {
  current ??= (() => {
    const cfg = readFileStoreConfig();
    return { store: makeFileStore(cfg), cfg };
  })();
  return current.store;
}
export function getFileStoreConfig(): FileStoreConfig {
  current ??= (() => {
    const cfg = readFileStoreConfig();
    return { store: makeFileStore(cfg), cfg };
  })();
  return current.cfg;
}
/** Tests and start-up: forget the built store so the next call reads the environment again. */
export function resetFileStore(): void {
  current = undefined;
}
