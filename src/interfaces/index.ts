import type { PlanContent } from '../schemas/plan';
import type { PlayVerification } from '../services/entitlement';
import type { StoreVerification } from '../services/storeTypes';

/** `text` is always required: some clients, and our own log fallback, never render the html. */
export interface MailMessage { to: string; subject: string; text: string; html?: string | undefined }
export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

export interface SmsProvider {
  /**
   * False when no SMS credentials are configured. The route reads this BEFORE it issues a code, so a
   * server with no Twilio account says "not available" instead of pretending a text is on its way.
   */
  readonly available: boolean;
  send(msg: { to: string; text: string }): Promise<void>;
}

export interface VerifiedIdentity {
  provider: 'google' | 'apple';
  subject: string;
  email?: string | undefined;
  emailVerified?: boolean | undefined;
  name?: string | undefined;
}
export interface IdTokenVerifyOptions {
  /** The nonce the app generated for this sign-in, to be matched against the token's own claim. */
  nonce?: string | undefined;
  /**
   * Apple hands the name to the phone on the very first sign-in and never again, so the phone sends it
   * with that one request. It is not proof of anything and is used only when the account is created.
   */
  fullName?: string | undefined;
}
export interface IdTokenVerifier {
  /** False when this provider has no client id on this server: every verify() is refused. */
  readonly configured: boolean;
  verify(idToken: string, opts?: IdTokenVerifyOptions): Promise<VerifiedIdentity>;
}

export interface PlayBilling {
  /**
   * kind "subscription" for Premium, "product" for one-off dietitian plan purchases.
   *
   * `StoreVerification` adds only optional fields to `PlayVerification`, so the development stub still
   * satisfies this: the real client (services/playBilling.ts) fills in the rest of what Google said.
   * It must NOT acknowledge the purchase — that is `acknowledge`, called once the entitlement is stored.
   */
  verify(args: { productId: string; purchaseToken: string; kind: 'subscription' | 'product' }): Promise<StoreVerification>;
  /**
   * Tells Google we have honoured the purchase. Optional because only the real Play client has anything to
   * do here, and deliberately separate from `verify`: an unacknowledged purchase is refunded by Google
   * after three days, which is the right outcome if we never managed to store the entitlement.
   */
  acknowledge?(args: { productId: string; purchaseToken: string; kind: 'subscription' | 'product' }): Promise<void>;
  /**
   * Refund and revoke a purchase. Play refunds by order, so the order id is wanted; with only a product id
   * the client looks the order up from the token. With neither it refuses rather than pretending.
   */
  refund(args: { purchaseToken: string; productId?: string | undefined; orderId?: string | undefined }): Promise<void>;
}

export interface AppStoreBilling {
  /** transactionId = the StoreKit originalTransactionId. Same verification shape as Play. */
  verify(args: { productId: string; transactionId: string }): Promise<StoreVerification>;
}

export interface AiPlanDraft extends PlanContent {
  title: string;
  /** True for the stub's canned sample. */
  isSample: boolean;
  source: 'stub' | 'anthropic' | 'openai';
  warnings: string[];
}
export interface PlanReadInput {
  text?: string | undefined;
  fileRef?: string | undefined;
  /** The document itself (PDF or image), base64. Nothing is stored. */
  file?: { mediaType: string; dataBase64: string } | undefined;
  locale?: string | undefined;
}
export interface AiPlanReader {
  read(input: PlanReadInput): Promise<AiPlanDraft>;
}

export interface Services {
  mailer: Mailer;
  sms: SmsProvider;
  googleVerifier: IdTokenVerifier;
  appleVerifier: IdTokenVerifier;
  playBilling: PlayBilling;
  appStoreBilling: AppStoreBilling;
  aiPlanReader: AiPlanReader;
}
