import { getEnv } from '../config/env';
import { FeeConfigModel, PackageConfig } from '../models/PackageConfig';
import { TtlCache } from './configCache';

export interface FeeConfig {
  playFeePercent: number;
  platformFeePercent: number;
  payoutDelayHours: number;
  refundWindowHours: number;
  premiumDiscountPercent: number;
  followUpDiscountPercent: number;
}

export const DEFAULT_FEE_CONFIG: FeeConfig = {
  playFeePercent: 15,
  platformFeePercent: 20,
  payoutDelayHours: 24,
  refundWindowHours: 72,
  premiumDiscountPercent: 30,
  followUpDiscountPercent: 50,
};

const ttl = () => getEnv().CONFIG_CACHE_TTL_SECONDS * 1000;

let feeCache: TtlCache<FeeConfig> | undefined;
let pkgCache: TtlCache<unknown[]> | undefined;

export function getFeeConfig(): Promise<FeeConfig> {
  feeCache ??= new TtlCache<FeeConfig>(async () => {
    const d = await FeeConfigModel.findOne({ key: 'default' }).lean();
    return {
      playFeePercent: d?.playFeePercent ?? DEFAULT_FEE_CONFIG.playFeePercent,
      platformFeePercent: d?.platformFeePercent ?? DEFAULT_FEE_CONFIG.platformFeePercent,
      payoutDelayHours: d?.payoutDelayHours ?? DEFAULT_FEE_CONFIG.payoutDelayHours,
      refundWindowHours: d?.refundWindowHours ?? DEFAULT_FEE_CONFIG.refundWindowHours,
      premiumDiscountPercent: d?.premiumDiscountPercent ?? DEFAULT_FEE_CONFIG.premiumDiscountPercent,
      followUpDiscountPercent: d?.followUpDiscountPercent ?? DEFAULT_FEE_CONFIG.followUpDiscountPercent,
    };
  }, ttl());
  return feeCache.get();
}
export const invalidateFeeConfig = () => feeCache?.invalidate();

export async function getActivePackages(): Promise<unknown[]> {
  pkgCache ??= new TtlCache<unknown[]>(() => PackageConfig.find({ active: true }).sort({ sortOrder: 1 }).lean(), ttl());
  return pkgCache.get();
}
export const invalidatePackages = () => pkgCache?.invalidate();
