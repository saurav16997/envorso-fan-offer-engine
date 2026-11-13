import type { CommercialEvidence, Policy } from './types.js';

export const HOUR_MS = 3_600_000;
export const HARD_PROMO_MAX_PERCENT = 15;
export const INITIAL_POLICY: Policy = {
  version: 'hypothesis-v0.1', minimumWaitHours: 4, maximumInactivityHours: 168,
  kickoffCutoffHours: 2, promoWaitHours: 24, promoPercent: 10,
  promoSoldBelowPercent: 60, protectYieldAtPercent: 80, promoKickoffMoreThanHours: 48,
  contactCooldownHours: 168, evidenceMaxAgeHours: 1,
  quietHours: { startHour: 9, endHour: 20 },
};

export function timestamp(value: unknown): number {
  const parts = typeof value === 'string'
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value) : null;
  if (!parts) {
    throw new Error(`Expected an explicit-offset timestamp: ${value}`);
  }
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day ||
      hour > 23 || minute > 59 || second > 59 ||
      (parts[8] !== 'Z' && (Number(parts[8]!.slice(1, 3)) > 23 || Number(parts[8]!.slice(4, 6)) > 59))) {
    throw new Error(`Invalid calendar timestamp: ${value}`);
  }
  const result = Date.parse(value as string);
  if (!Number.isFinite(result)) throw new Error(`Invalid timestamp: ${value}`);
  return result;
}

export function validatePolicy(value: unknown): asserts value is Policy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid policy object');
  const fields = value as Record<string, unknown>;
  if (typeof fields.version !== 'string' || !fields.version.trim()) throw new Error('Policy requires a version');
  for (const name of ['minimumWaitHours', 'maximumInactivityHours', 'kickoffCutoffHours', 'promoWaitHours',
    'promoPercent', 'promoSoldBelowPercent', 'protectYieldAtPercent', 'promoKickoffMoreThanHours',
    'contactCooldownHours', 'evidenceMaxAgeHours']) {
    const field = fields[name];
    if (typeof field !== 'number' || !Number.isFinite(field) || field < 0 || field > Number.MAX_SAFE_INTEGER / HOUR_MS) {
      throw new Error(`Invalid policy value: ${name}`);
    }
  }
  if (!fields.quietHours || typeof fields.quietHours !== 'object' || Array.isArray(fields.quietHours)) {
    throw new Error('Invalid policy quiet hours');
  }
  const policy = value as Policy;
  if (!Number.isInteger(policy.promoPercent) || policy.promoPercent < 1 ||
      policy.promoPercent > HARD_PROMO_MAX_PERCENT ||
      policy.promoWaitHours < policy.minimumWaitHours ||
      policy.maximumInactivityHours <= policy.minimumWaitHours ||
      policy.promoSoldBelowPercent > policy.protectYieldAtPercent ||
      policy.protectYieldAtPercent > 100 ||
      !Number.isInteger(policy.quietHours.startHour) || !Number.isInteger(policy.quietHours.endHour) ||
      policy.quietHours.startHour < 0 || policy.quietHours.endHour > 24 ||
      policy.quietHours.startHour >= policy.quietHours.endHour) {
    throw new Error('Invalid policy boundaries or promo cap');
  }
}

export function cents(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Money must be nonnegative integer cents');
  return value;
}

/** Round down the discount so rounding can never exceed any percentage cap. */
export function quoteDiscount(subtotalCents: number, percent: number, policy: Policy,
  commercial: Pick<CommercialEvidence, 'minimumNetCents' | 'maximumDiscountCents' | 'maximumPercent'>): number {
  validatePolicy(policy);
  cents(subtotalCents);
  cents(commercial.minimumNetCents);
  cents(commercial.maximumDiscountCents);
  if (!Number.isInteger(percent) || percent < 1 || !Number.isFinite(commercial.maximumPercent) ||
      percent > Math.min(HARD_PROMO_MAX_PERCENT, policy.promoPercent, commercial.maximumPercent)) {
    throw new Error('Discount exceeds the applicable percentage cap');
  }
  const discount = Number(BigInt(subtotalCents) * BigInt(percent) / 100n);
  if (discount > commercial.maximumDiscountCents || subtotalCents - discount < commercial.minimumNetCents) {
    throw new Error('Discount exceeds commercial allowance or price floor');
  }
  return discount;
}
