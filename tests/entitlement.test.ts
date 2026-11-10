import { describe, expect, it } from 'vitest';
import { effectiveStatus, entitlementFromPlay, isPremiumActive } from '../src/services/entitlement';

const now = new Date('2026-06-01T00:00:00Z');
const later = new Date('2026-07-01T00:00:00Z');
const earlier = new Date('2026-05-01T00:00:00Z');

describe('premium entitlement', () => {
  it('none / missing is not premium', () => {
    expect(isPremiumActive(null, now)).toBe(false);
    expect(isPremiumActive({ status: 'none' }, now)).toBe(false);
  });
  it('trial and active count until they lapse', () => {
    expect(isPremiumActive({ status: 'trialing', trialEndsAt: later }, now)).toBe(true);
    expect(isPremiumActive({ status: 'trialing', trialEndsAt: earlier }, now)).toBe(false);
    expect(isPremiumActive({ status: 'active', expiresAt: later }, now)).toBe(true);
    expect(isPremiumActive({ status: 'active', expiresAt: earlier }, now)).toBe(false);
    expect(isPremiumActive({ status: 'active' }, now)).toBe(false);
  });
  it('canceled keeps access until expiry', () => {
    expect(isPremiumActive({ status: 'canceled', expiresAt: later }, now)).toBe(true);
    expect(isPremiumActive({ status: 'canceled', expiresAt: earlier }, now)).toBe(false);
  });
  it('reports lapsed entitlements as expired', () => {
    expect(effectiveStatus({ status: 'active', expiresAt: earlier }, now)).toBe('expired');
    expect(effectiveStatus({ status: 'active', expiresAt: later }, now)).toBe('active');
  });
  it('maps Play verification results', () => {
    expect(entitlementFromPlay({ valid: true, expiresAt: later, autoRenewing: true }, 'monthly', now)).toMatchObject({ status: 'active', plan: 'monthly', source: 'google_play' });
    expect(entitlementFromPlay({ valid: true, expiresAt: later, isTrial: true }, 'yearly', now)).toMatchObject({ status: 'trialing', trialEndsAt: later });
    expect(entitlementFromPlay({ valid: true, expiresAt: later, autoRenewing: false }, 'monthly', now).status).toBe('canceled');
    expect(entitlementFromPlay({ valid: false }, 'monthly', now).status).toBe('expired');
    expect(entitlementFromPlay({ valid: true, expiresAt: earlier }, 'monthly', now).status).toBe('expired');
  });
});
