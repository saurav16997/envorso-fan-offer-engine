import type { Cart, EvaluationInput, OperationalEvidence } from '../domain/types.js';
import { originalSample, agedPromoScenario, SEAWOLVES, MATCH_LATER } from '../fixtures/scenarios.js';
import type { DemoContext, ScenarioId } from './types.js';

export const DEMO_CONTEXT: DemoContext = { tenantId: SEAWOLVES, actorId: 'demo:marketer' };
export const SCENARIOS = {
  original: { label: 'Original eight carts', description: 'Supplied source observations with explicitly synthetic operational evidence.' },
  grouped: { label: 'Synthetic review workload', description: '12 synthetic fan references: eight routine reminders, two exceptions, one wait and one purchase exclusion.' },
  promo: { label: 'Synthetic promo review', description: 'Original F-511 observations aged by 24 hours, with explicit synthetic commercial eligibility.' },
} as const;

export function scenarioId(value: unknown): ScenarioId {
  if (value !== 'original' && value !== 'grouped' && value !== 'promo') throw new Error('Unknown demo scenario');
  return value;
}

/** Generated operational workload. These are NOT additional supplied fans. */
export function groupedScenario(): EvaluationInput {
  const base = originalSample();
  const now = base.clock.now();
  const template = base.carts.find(c => c.source.cartId === 'C-1002')!;
  const carts: Cart[] = Array.from({ length: 12 }, (_, index) => {
    const fanId = `SYN-F-${String(index + 1).padStart(3, '0')}`;
    const seats = 2 + index % 3;
    const valueCents = seats * 3500;
    const age = index === 10 ? 2 : 6 + index;
    return { ...template, identity: { kind: 'fan', fanId }, lastActivityAt: new Date(Date.parse(now) - age * 3_600_000).toISOString(),
      cartValueCents: valueCents, source: { ...template.source, cartId: `SYN-C-${index + 1}`, fanId,
        source: index === 6 || index === 7 ? 'App' : 'Web', seats, cartValue: `$${valueCents / 100}`,
        abandoned: `${age} hrs ago`, seasonPass: index === 9 ? 'Yes' : 'No',
        emailOptIn: index === 6 || index === 7 ? 'No' : 'Yes', pushOptIn: index === 6 || index === 7 ? 'Yes' : 'No' } };
  });
  const freshness = { checkedAt: now, validUntil: new Date(Date.parse(now) + 3_600_000).toISOString() };
  const evidence: OperationalEvidence = {
    tenants: [{ tenantId: SEAWOLVES, active: true }], matches: base.evidence.matches.filter(m => m.matchId === MATCH_LATER),
    opportunities: carts.map((c, i) => ({ tenantId: SEAWOLVES, subjectKey: `fan:${c.source.fanId}`, matchId: MATCH_LATER,
      ...freshness, purchase: i === 11 ? 'purchased' : 'not_purchased', recoveryHistoryComplete: true,
      clubHistoryComplete: true, entitlement: 'unknown', preferredChannel: null, recipientTimeZone: 'America/Los_Angeles' })),
    destinations: carts.map(c => ({ tenantId: SEAWOLVES, subjectKey: `fan:${c.source.fanId}`,
      channel: c.source.emailOptIn === 'Yes' ? 'email' : 'push', value: c.source.emailOptIn === 'Yes'
        ? `${c.source.fanId.toLowerCase()}@example.invalid` : `synthetic-token:${c.source.fanId}`, verifiedOwner: true, status: 'usable' })),
    consents: carts.filter((_, i) => i !== 8).map(c => ({ tenantId: SEAWOLVES, subjectKey: `fan:${c.source.fanId}`,
      channel: c.source.emailOptIn === 'Yes' ? 'email' : 'push', purpose: 'marketing', status: 'granted',
      ...freshness, effectiveAt: now, provenance: 'SYNTHETIC workload consent fixture; no real permission asserted.' })),
    contacts: [], commercial: [],
  };
  return { carts, evidence, policy: base.policy, clock: { now: () => now } };
}

export function scenarioInput(id: ScenarioId): EvaluationInput {
  return id === 'original' ? originalSample() : id === 'promo' ? agedPromoScenario() : groupedScenario();
}

/** Tenant ownership is enforced before persistence and again on every database query. */
export function tenantInput(input: EvaluationInput, tenantId: string): EvaluationInput {
  const scoped = <T extends { tenantId: string }>(rows: readonly T[]): T[] => rows.filter(row => row.tenantId === tenantId);
  return { ...input, carts: scoped(input.carts), evidence: {
    tenants: scoped(input.evidence.tenants), matches: scoped(input.evidence.matches), opportunities: scoped(input.evidence.opportunities),
    destinations: scoped(input.evidence.destinations), consents: scoped(input.evidence.consents),
    contacts: scoped(input.evidence.contacts), commercial: scoped(input.evidence.commercial),
  } };
}
