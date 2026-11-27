/**
 * Store credentials, read from the environment here rather than in `config/env.ts`, the way `fileStore.ts`
 * reads its own. Every one of them is optional, and the rule when they are missing is the same everywhere:
 * we refuse to verify. A purchase we cannot check is not a purchase we grant Premium for.
 */
import { log } from '../utils/logger';
import type { StoreEnvironment } from './storeTypes';

export type EnvSource = Record<string, string | undefined>;

export interface PlayCredentials {
  clientEmail: string;
  privateKey: string;
  packageName: string;
  /** Offer tags that mark a free trial in the Play Console, so a trial is read from the offer, not guessed. */
  trialOfferTags: string[];
}

export interface AppStoreCredentials {
  keyId: string;
  issuerId: string;
  privateKey: string;
  bundleId: string;
  /** Which world this deployment belongs to. A receipt from the other one is refused. */
  environment: StoreEnvironment;
}

/** What a Play Pub/Sub push must prove before we read a single byte of it. */
export interface RtdnCredentials {
  /** The audience configured on the Pub/Sub push subscription's OIDC token. */
  audience: string;
  /** The service account Pub/Sub signs as. Anyone else's token is refused. */
  serviceAccountEmail: string;
}

/** A PEM in an env var usually arrives with its newlines escaped. */
const unescape = (k: string) => k.replace(/\\n/g, '\n').trim();

const csv = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * The Play package name. `config/env.ts` defaults it to `com.saathi.app`, which is NOT the id the Android
 * app is built with (`com.multiware.saathi`), so an unset variable would make every verification 404.
 * Refusing is still the safe failure, but it is a silent one, hence the warning.
 */
export function playPackageName(src: EnvSource): string {
  const name = src['PLAY_PACKAGE_NAME']?.trim();
  if (!name) {
    log.warn('PLAY_PACKAGE_NAME is not set: it must be the Android applicationId (com.multiware.saathi), or every Play verification is refused');
    return '';
  }
  return name;
}

/**
 * Either the whole service-account JSON in one variable (easiest on Heroku) or the two fields separately.
 * Null when none is configured, which turns Play verification into a refusal.
 */
export function playCredentials(src: EnvSource): PlayCredentials | null {
  const packageName = playPackageName(src);
  const trialOfferTags = csv(src['PLAY_TRIAL_OFFER_TAGS']).length ? csv(src['PLAY_TRIAL_OFFER_TAGS']) : ['trial'];
  let clientEmail = src['PLAY_SERVICE_ACCOUNT_EMAIL']?.trim() ?? '';
  let privateKey = src['PLAY_SERVICE_ACCOUNT_PRIVATE_KEY'] ? unescape(src['PLAY_SERVICE_ACCOUNT_PRIVATE_KEY']) : '';
  const json = src['PLAY_SERVICE_ACCOUNT_JSON']?.trim();
  if (json) {
    try {
      const j = JSON.parse(json) as Record<string, string>;
      clientEmail = j['client_email'] ?? '';
      privateKey = unescape(j['private_key'] ?? '');
    } catch {
      log.warn('PLAY_SERVICE_ACCOUNT_JSON is not valid JSON: Play purchases cannot be verified');
      return null;
    }
  }
  if (!clientEmail || !privateKey) return null;
  if (!packageName) return null;
  return { clientEmail, privateKey, packageName, trialOfferTags };
}

/**
 * An App Store Connect in-app purchase key. All four parts are needed: without any one of them we cannot
 * sign a request, so there is nothing to fall back to.
 */
export function appStoreCredentials(src: EnvSource): AppStoreCredentials | null {
  const keyId = src['APP_STORE_KEY_ID']?.trim() ?? '';
  const issuerId = src['APP_STORE_ISSUER_ID']?.trim() ?? '';
  const privateKey = src['APP_STORE_PRIVATE_KEY'] ? unescape(src['APP_STORE_PRIVATE_KEY']) : '';
  const bundleId = src['APP_STORE_BUNDLE_ID']?.trim() ?? '';
  if (!keyId || !issuerId || !privateKey || !bundleId) return null;
  return { keyId, issuerId, privateKey, bundleId, environment: appStoreEnvironment(src) };
}

/**
 * Which world this deployment is. Explicit when set; otherwise production servers are production and
 * everything else is sandbox, so a developer's machine never has to be told twice and a live server never
 * guesses its way into trusting a test purchase.
 */
export function appStoreEnvironment(src: EnvSource): StoreEnvironment {
  const v = src['APP_STORE_ENVIRONMENT']?.trim().toLowerCase();
  if (v === 'sandbox' || v === 'production') return v;
  return src['NODE_ENV'] === 'production' ? 'production' : 'sandbox';
}

export function rtdnCredentials(src: EnvSource): RtdnCredentials | null {
  const audience = src['PLAY_RTDN_AUDIENCE']?.trim() ?? '';
  const serviceAccountEmail = src['PLAY_RTDN_SERVICE_ACCOUNT_EMAIL']?.trim().toLowerCase() ?? '';
  if (!audience || !serviceAccountEmail) return null;
  return { audience, serviceAccountEmail };
}

/**
 * The certificates Apple's notification signatures must chain up to — Apple Root CA G3, as PEM or as
 * base64 DER, several allowed (Apple rotates). There is deliberately no built-in default: a trust anchor
 * guessed wrong is either a webhook that never works or one that trusts the wrong signer, and both are
 * worse than a refusal with an explanation. See qa/wiring/store.md for the two commands that produce it.
 */
export function appStoreTrustAnchors(src: EnvSource): string[] {
  const raw = src['APP_STORE_ROOT_CERTS']?.trim();
  if (!raw) return [];
  const pems: string[] = [];
  // PEM blocks, however they were pasted (real newlines, escaped newlines, or several in one variable).
  const text = raw.replace(/\\n/g, '\n');
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (blocks) pems.push(...blocks);
  else {
    // Bare base64 DER, one per comma or line.
    for (const part of text.split(/[,\s]+/).filter(Boolean)) {
      pems.push(`-----BEGIN CERTIFICATE-----\n${part.replace(/(.{64})/g, '$1\n').trim()}\n-----END CERTIFICATE-----`);
    }
  }
  return pems;
}
