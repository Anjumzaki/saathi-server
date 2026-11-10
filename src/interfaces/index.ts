import type { PlanContent } from '../schemas/plan';
import type { PlayVerification } from '../services/entitlement';

export interface Mailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

export interface SmsProvider {
  send(msg: { to: string; text: string }): Promise<void>;
}

export interface VerifiedIdentity {
  provider: 'google' | 'apple';
  subject: string;
  email?: string | undefined;
  emailVerified?: boolean | undefined;
  name?: string | undefined;
}
export interface IdTokenVerifier {
  verify(idToken: string): Promise<VerifiedIdentity>;
}

export interface PlayBilling {
  /** kind "subscription" for Premium, "product" for one-off dietitian plan purchases. */
  verify(args: { productId: string; purchaseToken: string; kind: 'subscription' | 'product' }): Promise<PlayVerification>;
  /** Refund / revoke a purchase (TODO real implementation: Google Play Developer API voided purchases). */
  refund(args: { purchaseToken: string }): Promise<void>;
}

export interface AppStoreBilling {
  /** transactionId = the StoreKit originalTransactionId. Same verification shape as Play. */
  verify(args: { productId: string; transactionId: string }): Promise<PlayVerification>;
}

export interface AiPlanDraft extends PlanContent {
  title: string;
  /** True for the stub's canned sample. */
  isSample: boolean;
  source: 'stub' | 'anthropic';
  warnings: string[];
}
export interface AiPlanReader {
  read(input: { text?: string | undefined; fileRef?: string | undefined; locale?: string | undefined }): Promise<AiPlanDraft>;
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
