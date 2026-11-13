import { HOUR_MS, INITIAL_POLICY } from '../domain/policy.js';
import type { Cart, EvaluationInput, OperationalEvidence, SourceCart } from '../domain/types.js';
import { SOURCE_CARTS } from './source-carts.js';

/** ALL fields in this file beyond SOURCE_CARTS are synthetic demonstration evidence. */
export const SYNTHETIC_SAMPLE_NOW = '2026-11-10T18:00:00.000Z'; // 10:00 America/Los_Angeles; not a supplied sample date.
export const SEAWOLVES = 'synthetic:seawolves';
export const ONBOARDING = 'synthetic:onboarding-club';
export const MATCH_NEXT = 'synthetic:sw-next';
export const MATCH_LATER = 'synthetic:sw-later';
export const MATCH_PAST = 'synthetic:sw-played';

const offset = (iso: string, hours: number): string => new Date(Date.parse(iso) + hours * HOUR_MS).toISOString();
const sourceMoney = (value: string): number => {
  if (!/^\$\d+$/.test(value)) throw new Error(`Unexpected source money: ${value}`);
  return Number(value.slice(1)) * 100;
};

/** Fixture-only adapter. Production ingestion needs authoritative IDs/activity and validation. */
function observation(source: SourceCart): Cart {
  const hours = Number(/^(\d+) hrs? ago$/.exec(source.abandoned)?.[1]);
  if (!Number.isFinite(hours)) throw new Error('Unrecognized source activity');
  const matchId = source.cartId === 'C-1005' ? MATCH_PAST : source.cartId === 'C-1007' ? 'synthetic:onboarding-next'
    : ['C-1002', 'C-1008'].includes(source.cartId) ? MATCH_LATER : MATCH_NEXT;
  return {
    tenantId: source.team === 'Seawolves' ? SEAWOLVES : ONBOARDING,
    matchId, lastActivityAt: offset(SYNTHETIC_SAMPLE_NOW, -hours),
    identity: source.cartId === 'C-1008'
      ? { kind: 'guest', contactId: 'synthetic:guest-1008', associatedFanIds: ['F-511'],
          provenance: 'SYNTHETIC unique association implementing the explicit supplied C-1008/F-511 note; not email-only production identity resolution.' }
      : { kind: 'fan', fanId: source.fanId },
    source, cartValueCents: sourceMoney(source.cartValue), sectionSoldPercent: Number(source.sectionSold.slice(0, -1)),
    lifetimeTickets: source.lifetimeTickets === 'Unknown' ? 'unknown' : source.lifetimeTickets,
    shopSpendCents: source.shopSpend12Months === 'Unknown' ? 'unknown' : source.shopSpend12Months === 'Not synced'
      ? 'not_synced' : sourceMoney(source.shopSpend12Months),
  };
}

export function sampleCarts(): Cart[] { return SOURCE_CARTS.map(observation); }

export function syntheticEvidence(checkedAt = SYNTHETIC_SAMPLE_NOW): OperationalEvidence {
  const freshness = { checkedAt, validUntil: offset(checkedAt, 1) };
  const subjects = [
    { tenantId: SEAWOLVES, subjectKey: 'fan:F-204', matchId: MATCH_NEXT, channels: ['email', 'push'] as const },
    { tenantId: SEAWOLVES, subjectKey: 'fan:F-511', matchId: MATCH_LATER, channels: ['email'] as const },
    { tenantId: SEAWOLVES, subjectKey: 'fan:F-092', matchId: MATCH_NEXT, channels: ['push'] as const },
    { tenantId: SEAWOLVES, subjectKey: 'fan:F-333', matchId: MATCH_NEXT, channels: ['email', 'push'] as const },
    { tenantId: SEAWOLVES, subjectKey: 'fan:F-777', matchId: MATCH_PAST, channels: ['email'] as const },
    { tenantId: ONBOARDING, subjectKey: 'fan:F-618', matchId: 'synthetic:onboarding-next', channels: ['email'] as const },
  ];
  return {
    tenants: [{ tenantId: SEAWOLVES, active: true }, { tenantId: ONBOARDING, active: false }],
    matches: [
      { tenantId: SEAWOLVES, matchId: MATCH_NEXT, kickoffAt: offset(SYNTHETIC_SAMPLE_NOW, 96), state: 'scheduled',
        availableSeatsBySection: { 'Lower Bowl': 20, Club: 8 }, sectionSoldPercentBySection: { 'Lower Bowl': 88, Club: 97 }, ...freshness },
      { tenantId: SEAWOLVES, matchId: MATCH_LATER, kickoffAt: offset(SYNTHETIC_SAMPLE_NOW, 432), state: 'scheduled',
        availableSeatsBySection: { 'Upper Deck': 100 }, sectionSoldPercentBySection: { 'Upper Deck': 41 }, ...freshness },
      { tenantId: SEAWOLVES, matchId: MATCH_PAST, kickoffAt: offset(SYNTHETIC_SAMPLE_NOW, -48), state: 'played',
        availableSeatsBySection: { 'Upper Deck': 0 }, sectionSoldPercentBySection: { 'Upper Deck': 63 }, ...freshness },
      { tenantId: ONBOARDING, matchId: 'synthetic:onboarding-next', kickoffAt: offset(SYNTHETIC_SAMPLE_NOW, 216), state: 'scheduled',
        availableSeatsBySection: { Sideline: 40 }, sectionSoldPercentBySection: { Sideline: 55 }, ...freshness },
    ],
    opportunities: subjects.map(({ tenantId, subjectKey, matchId }) => ({ tenantId, subjectKey, matchId,
      ...freshness, purchase: 'not_purchased', recoveryHistoryComplete: true, clubHistoryComplete: true,
      entitlement: 'unknown', preferredChannel: null, recipientTimeZone: 'America/Los_Angeles' })),
    destinations: subjects.flatMap(({ tenantId, subjectKey, channels }) => channels.map(channel => ({
      tenantId, subjectKey, channel, value: channel === 'email' ? `${subjectKey.slice(4).toLowerCase()}@example.invalid` : `synthetic-token:${subjectKey}`,
      verifiedOwner: true, status: 'usable' as const,
    }))),
    consents: subjects.flatMap(({ tenantId, subjectKey, channels }) => channels.map(channel => ({
      tenantId, subjectKey, channel, purpose: 'marketing' as const, status: 'granted' as const,
      ...freshness, effectiveAt: SYNTHETIC_SAMPLE_NOW,
      provenance: 'SYNTHETIC brand-scoped marketing permission fixture v1; not proof of real consent.',
    }))),
    contacts: [], commercial: [],
  };
}

export function originalSample(): EvaluationInput {
  return { carts: sampleCarts(), evidence: syntheticEvidence(), policy: INITIAL_POLICY,
    clock: { now: () => SYNTHETIC_SAMPLE_NOW } };
}

/** Keeps the original five-hour observation. Advances the clock 24h and explicitly refreshes synthetic checks. */
export function agedPromoScenario(): EvaluationInput {
  const now = offset(SYNTHETIC_SAMPLE_NOW, 24); // Latest F-511 activity is now 29 hours old, within daytime send window.
  const evidence = syntheticEvidence(now);
  return { carts: sampleCarts().filter(c => ['C-1002', 'C-1008'].includes(c.source.cartId)),
    policy: INITIAL_POLICY, clock: { now: () => now },
    evidence: { ...evidence, commercial: [{ tenantId: SEAWOLVES, subjectKey: 'fan:F-511', matchId: MATCH_LATER,
      cartId: 'C-1008', currency: 'USD', eligibleSubtotalCents: 14000, minimumNetCents: 12600,
      maximumDiscountCents: 1400, maximumPercent: 10, approved: true, checkedAt: now, validUntil: offset(now, 1),
      provenance: 'SYNTHETIC commercial approval: entire $140 ticket subtotal eligible; excludes any unmodeled taxes/fees.',
    }] },
  };
}
