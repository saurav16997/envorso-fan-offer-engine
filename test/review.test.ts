import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate } from '../src/domain/engine.js';
import { timestamp } from '../src/domain/policy.js';
import type { EvaluationInput, OperationalEvidence, Opportunity } from '../src/domain/types.js';
import { agedPromoScenario, MATCH_LATER, originalSample, SEAWOLVES } from '../src/fixtures/scenarios.js';

const patchEvidence = (input: EvaluationInput, patch: Partial<OperationalEvidence>): EvaluationInput =>
  ({ ...input, evidence: { ...input.evidence, ...patch } });
const fan = (input: EvaluationInput, id = 'fan:F-511'): Opportunity => {
  const found = evaluate(input).find(o => o.subjectKey === id);
  assert.ok(found);
  return found;
};
const codes = (o: Opportunity): string[] => [...o.reasons, ...o.delivery.blockers].map(r => r.code);

test('review: malformed imported types cannot pass eligibility through JavaScript coercion', () => {
  const base = agedPromoScenario();
  const cases: [readonly (string | number)[], unknown, RegExp][] = [
    [['evidence', 'tenants', 0, 'active'], 'false', /boolean/],
    [['evidence', 'destinations', 0, 'verifiedOwner'], 'false', /boolean/],
    [['evidence', 'destinations', 0, 'status'], 'unconfirmed', /status/],
    [['evidence', 'consents', 0, 'status'], 'denied', /status/],
    [['evidence', 'consents', 0, 'effectiveAt'], undefined, /timestamp/],
    [['evidence', 'opportunities', 0, 'purchase'], 'unconfirmed', /purchase/],
    [['evidence', 'opportunities', 0, 'entitlement'], undefined, /entitlement/],
    [['evidence', 'opportunities', 0, 'recoveryHistoryComplete'], 'false', /boolean/],
    [['evidence', 'commercial', 0, 'approved'], 'false', /boolean/],
    [['evidence', 'commercial', 0, 'currency'], 'EUR', /USD/],
    [['evidence', 'commercial', 0, 'eligibleSubtotalCents'], -1, /integer cents/],
    [['evidence', 'commercial', 0, 'minimumNetCents'], 0.5, /integer cents/],
    [['evidence', 'commercial', 0, 'maximumPercent'], 101, /percentage/],
    [['carts', 0, 'tenantId'], '', /string with content/],
    [['carts', 1, 'identity', 'associatedFanIds'], [''], /string with content/],
    [['carts', 0, 'sectionSoldPercent'], -1, /percentage/],
    [['carts', 0, 'shopSpendCents'], 'missing', /integer cents/],
    [['carts', 0, 'identity', 'fanId'], 'F-someone-else', /source account fan ID/],
    [['policy', 'minimumWaitHours'], '0', /Invalid policy value/],
    [['policy', 'minimumWaitHours'], undefined, /Invalid policy value/],
  ];
  for (const [path, value, expected] of cases) {
    const imported: unknown = JSON.parse(JSON.stringify({ carts: base.carts, policy: base.policy, evidence: base.evidence }));
    let target = imported as Record<string | number, unknown>;
    for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, unknown>;
    target[path.at(-1)!] = value;
    // This assertion deliberately simulates an unchecked JSON import; the engine must validate it anyway.
    assert.throws(() => evaluate({ ...(imported as EvaluationInput), clock: base.clock }), expected, path.join('.'));
  }
});

test('review: impossible dates are rejected instead of being normalized into different business dates', () => {
  for (const invalid of ['2026-02-30T18:00:00Z', '2026-11-31T18:00:00Z', '2026-01-01T24:00:00Z',
    '2026-01-01T18:00:60Z', '2026-01-01T18:00:00+24:00', '11/10/2026Z']) {
    assert.throws(() => timestamp(invalid), /timestamp/, invalid);
  }
  assert.equal(timestamp('2026-11-11T13:00:00-05:00'), Date.parse('2026-11-11T18:00:00Z'));
  assert.equal(timestamp('2024-02-29T18:00:00Z'), Date.parse('2024-02-29T18:00:00Z'));
  const base = originalSample();
  assert.throws(() => evaluate({ ...base, clock: { now: () => '2026-02-30T18:00:00Z' } }), /calendar timestamp/);
  assert.throws(() => evaluate(patchEvidence(base, { matches: base.evidence.matches.map(m =>
    ({ ...m, kickoffAt: '2026-11-31T18:00:00Z' })) })), /calendar timestamp/);
});

test('review: source and normalized values must agree, including unknowns, unsynced spend, yield and money', () => {
  const base = agedPromoScenario();
  for (const sourcePatch of [{ lifetimeTickets: 'Unknown' as const }, { sectionSold: '88%' },
    { cartValue: '$96' }, { shopSpend12Months: 'Unknown' }, { shopSpend12Months: 'Not synced' }]) {
    const input = { ...base, carts: base.carts.map(c => c.identity.kind === 'fan'
      ? { ...c, source: { ...c.source, ...sourcePatch } } : c) };
    assert.throws(() => evaluate(input), /consistent with the retained source row/, JSON.stringify(sourcePatch));
  }
});

test('review: checking an old grant again does not override a later revocation event', () => {
  const base = agedPromoScenario();
  const grant = { ...base.evidence.consents.find(c => c.subjectKey === 'fan:F-511')!,
    effectiveAt: '2026-11-11T17:00:00Z', checkedAt: '2026-11-11T18:00:00Z' };
  const revoke = { ...grant, status: 'revoked' as const, effectiveAt: '2026-11-11T17:30:00Z', checkedAt: '2026-11-11T17:45:00Z' };
  const blocked = fan(patchEvidence(base, { consents: [grant, revoke] }));
  assert.equal(blocked.delivery.readiness, 'blocked');
  assert.ok(codes(blocked).includes('CONSENT_REVOKED'));
  assert.deepEqual(blocked, fan(patchEvidence(base, { consents: [revoke, grant] })));
  // Only a genuine later grant event, not a later check time, can restore permission.
  const laterGrant = { ...grant, effectiveAt: '2026-11-11T17:50:00Z', checkedAt: '2026-11-11T17:55:00Z' };
  assert.equal(fan(patchEvidence(base, { consents: [grant, revoke, laterGrant] })).delivery.readiness, 'checks_satisfied');
});

test('review: future-dated evidence is rejected rather than ignored in favor of an older grant', () => {
  const base = agedPromoScenario();
  const grant = base.evidence.consents.find(c => c.subjectKey === 'fan:F-511')!;
  const future = { ...grant, status: 'revoked' as const, effectiveAt: '2026-11-11T18:00:00.001Z', checkedAt: '2026-11-11T18:00:00.001Z' };
  assert.throws(() => evaluate(patchEvidence(base, { consents: [grant, future] })), /future/);
});

test('review: an ambiguous guest cannot leave candidate accounts eligible for an old-activity coupon', () => {
  const base = originalSample();
  const input = { ...base, carts: base.carts.filter(c => ['C-1002', 'C-1008'].includes(c.source.cartId)).map(c =>
    c.identity.kind === 'guest' ? { ...c, identity: { ...c.identity, associatedFanIds: ['F-511', 'F-other'] } } : c),
    evidence: { ...base.evidence, commercial: [{ tenantId: SEAWOLVES, subjectKey: 'fan:F-511', matchId: MATCH_LATER,
      cartId: 'C-1002', currency: 'USD' as const, eligibleSubtotalCents: 14000, minimumNetCents: 12600,
      maximumDiscountCents: 1400, maximumPercent: 10, approved: true, checkedAt: base.clock.now(),
      validUntil: '2026-11-10T19:00:00Z', provenance: 'Explicit synthetic commercial approval for the account cart' }] } };
  const out = evaluate(input);
  assert.equal(out.length, 2);
  assert.equal(out.flatMap(o => o.sourceCartIds).length, 2);
  for (const o of out) { assert.equal(o.status, 'hold'); assert.equal(o.proposedAction, null); assert.equal(o.delivery.readiness, 'blocked'); }
  assert.ok(codes(fan(input)).includes('RELATED_GUEST_IDENTITY_UNRESOLVED'));
  assert.deepEqual(out, evaluate({ ...input, carts: [...input.carts].reverse() }));
  // A different match for the same account is not implicated by this guest activity.
  const account = input.carts.find(c => c.identity.kind === 'fan')!;
  const differentMatch = { ...account, matchId: 'synthetic:sw-next', source: { ...account.source, cartId: 'independent-match' } };
  const unrelated = evaluate({ ...input, carts: [...input.carts, differentMatch] }).find(o => o.sourceCartIds.includes('independent-match'))!;
  assert.equal(unrelated.status, 'recommend');
});

test('review: known positive ticket history from a linked guest vetoes a first-time promo', () => {
  const base = agedPromoScenario();
  const out = fan({ ...base, carts: base.carts.map(c => c.identity.kind === 'guest'
    ? { ...c, lifetimeTickets: 3, source: { ...c.source, lifetimeTickets: 3 } } : c) });
  assert.equal(out.proposedAction?.kind, 'reminder');
  assert.deepEqual(out.incentiveExposure, { kind: 'known', currency: 'USD', maximumDiscountCents: 0 });
  assert.ok(codes(out).includes('BUYER_HISTORY_CONFLICT'));
});

test('review: current sell-through and complete section evidence constrain promos, even when old carts say 41%', () => {
  const base = agedPromoScenario();
  for (const [sold, expected] of [[59.99, 'promo'], [60, 'reminder'], [88, 'reminder'], [97, 'reminder']] as const) {
    const out = fan(patchEvidence(base, { matches: base.evidence.matches.map(m =>
      ({ ...m, sectionSoldPercentBySection: { 'Upper Deck': sold } })) }));
    assert.equal(out.proposedAction?.kind, expected, `Current sell-through ${sold}%`);
    if (sold >= 80) assert.ok(codes(out).includes('YIELD_PROTECTED'));
  }
  const missing = fan(patchEvidence(base, { matches: base.evidence.matches.map(m => ({ ...m, sectionSoldPercentBySection: {} })) }));
  assert.equal(missing.proposedAction?.kind, 'reminder');
  assert.ok(missing.missingInformation.includes('current_section_sell_through'));
  assert.equal(missing.delivery.readiness, 'checks_satisfied'); // Missing promo evidence does not block a zero-incentive reminder.
});

test('review: inherited object properties are not evidence of inventory', () => {
  const base = agedPromoScenario();
  const out = fan({ ...base, carts: base.carts.map(c => ({ ...c, source: { ...c.source, section: 'toString' } })) });
  assert.equal(out.delivery.readiness, 'blocked');
  assert.ok(codes(out).includes('INVENTORY_UNAVAILABLE'));
});

test('review: invalid and revoked push destinations remain distinct from missing permission and never fall back to email for F-092', () => {
  const base = originalSample();
  for (const [status, expected] of [['invalid', 'DESTINATION_INVALID'], ['revoked', 'DESTINATION_REVOKED']] as const) {
    const out = fan(patchEvidence(base, { destinations: base.evidence.destinations.map(d =>
      d.subjectKey === 'fan:F-092' ? { ...d, status } : d) }), 'fan:F-092');
    assert.equal(out.proposedChannel, 'push');
    assert.equal(out.delivery.readiness, 'blocked');
    assert.ok(codes(out).includes(expected));
    assert.ok(!codes(out).includes('SCOPED_CONSENT_MISSING'));
  }
});

test('review: channel fallback happens only while evaluating a new proposal and requires its own permission', () => {
  const base = originalSample();
  const input = { ...base, carts: base.carts.filter(c => c.identity.kind === 'fan' && c.identity.fanId === 'F-204')
    .map(c => ({ ...c, lastActivityAt: '2026-11-10T14:00:00Z' })) };
  const preferredBlocked = patchEvidence(input, { destinations: base.evidence.destinations.map(d =>
    d.channel === 'push' ? { ...d, status: 'revoked' } : d) });
  const fallback = fan(preferredBlocked, 'fan:F-204');
  assert.equal(fallback.proposedChannel, 'email');
  assert.equal(fallback.delivery.readiness, 'checks_satisfied');
  const noPermission = patchEvidence(preferredBlocked, { consents: base.evidence.consents.map(c => ({ ...c, status: 'revoked' })) });
  assert.equal(fan(noPermission, 'fan:F-204').delivery.readiness, 'blocked');
});

test('review: missing or wrong-tenant match evidence produces a hold without borrowing another tenant catalog', () => {
  const base = agedPromoScenario();
  const out = fan(patchEvidence(base, { matches: base.evidence.matches.map(m => ({ ...m, tenantId: 'another-tenant' })) }));
  assert.equal(out.status, 'hold');
  assert.ok(codes(out).includes('MATCH_UNKNOWN'));
  assert.equal(out.delivery.readiness, 'blocked');
});
