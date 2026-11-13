import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { evaluate } from '../src/domain/engine.js';
import { INITIAL_POLICY, quoteDiscount } from '../src/domain/policy.js';
import type { Cart, EvaluationInput, OperationalEvidence, Opportunity } from '../src/domain/types.js';
import { agedPromoScenario, MATCH_LATER, ONBOARDING, originalSample, SEAWOLVES, SYNTHETIC_SAMPLE_NOW } from '../src/fixtures/scenarios.js';
import { SOURCE_CARTS } from '../src/fixtures/source-carts.js';

const find = (output: readonly Opportunity[], cartId: string): Opportunity => {
  const found = output.find(o => o.sourceCartIds.includes(cartId));
  assert.ok(found, `Missing cart ${cartId}`);
  return found;
};
const has = (o: Opportunity, code: string): boolean => [...o.reasons, ...o.delivery.blockers].some(r => r.code === code);
const withEvidence = (input: EvaluationInput, patch: Partial<OperationalEvidence>): EvaluationInput =>
  ({ ...input, evidence: { ...input.evidence, ...patch } });
const updateCart = (input: EvaluationInput, id: string, update: (cart: Cart) => Cart): EvaluationInput =>
  ({ ...input, carts: input.carts.map(c => c.source.cartId === id ? update(c) : c) });
const one = (input: EvaluationInput): Opportunity => {
  const result = evaluate(input);
  assert.equal(result.length, 1);
  return result[0]!;
};
const promo = (): EvaluationInput => agedPromoScenario();

test('all 16 cells of every source row exactly match the supplied challenge table', () => {
  const challenge = readFileSync(new URL('../../CHALLENGE.md', import.meta.url), 'utf8');
  const suppliedRows = challenge.split(/\r?\n/).filter(line => line.startsWith('| C-'))
    .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
  const actual = SOURCE_CARTS.map(c => [c.cartId, c.fanId, c.team, c.source, c.match, String(c.seats), c.section,
    c.sectionSold, c.cartValue, c.abandoned, String(c.lifetimeTickets), c.lastPurchase, c.shopSpend12Months,
    c.seasonPass, c.emailOptIn, c.pushOptIn]);
  assert.equal(suppliedRows.length, 8);
  assert.deepEqual(actual, suppliedRows);
});

test('all eight rows produce the six independently specified original outcomes', () => {
  const output = evaluate(originalSample());
  assert.equal(output.length, 6);
  const actual = output.map(o => ({ ids: o.sourceCartIds.join(','), fan: o.subjectKey, status: o.status,
    action: o.proposedAction?.kind ?? null, channel: o.proposedChannel, next: o.nextEligibleAt }))
    .sort((a, b) => a.ids.localeCompare(b.ids));
  assert.deepEqual(actual, [
    { ids: 'C-1001,C-1006', fan: 'fan:F-204', status: 'defer', action: null, channel: null, next: '2026-11-10T20:00:00.000Z' },
    { ids: 'C-1002,C-1008', fan: 'fan:F-511', status: 'recommend', action: 'reminder', channel: 'email', next: null },
    { ids: 'C-1003', fan: 'fan:F-092', status: 'recommend', action: 'reminder', channel: 'push', next: null },
    { ids: 'C-1004', fan: 'fan:F-333', status: 'defer', action: null, channel: null, next: '2026-11-10T21:00:00.000Z' },
    { ids: 'C-1005', fan: 'fan:F-777', status: 'suppress', action: null, channel: null, next: null },
    { ids: 'C-1007', fan: 'fan:F-618', status: 'hold', action: null, channel: null, next: null },
  ]);
  assert.deepEqual(output.flatMap(o => o.sourceCartIds).sort(), ['C-1001', 'C-1002', 'C-1003', 'C-1004', 'C-1005', 'C-1006', 'C-1007', 'C-1008']);
  for (const o of output) {
    assert.equal(o.policyVersion, 'hypothesis-v0.1');
    assert.deepEqual(o.incentiveExposure, { kind: 'known', currency: 'USD', maximumDiscountCents: 0 });
    assert.ok(o.reasons.every(reason => reason.code.length > 0 && reason.message.length > 0));
  }
});

test('cross-device coalescing preserves lineage and uses latest activity, not oldest cart', () => {
  const out = evaluate(originalSample());
  const f204 = find(out, 'C-1001');
  assert.equal(f204.latestActivityAt, '2026-11-10T16:00:00.000Z');
  assert.equal(f204.canonicalCartId, 'C-1006');
  assert.equal(f204.sourceCarts.length, 2);
  const f511 = find(out, 'C-1002');
  assert.equal(f511.latestActivityAt, '2026-11-10T13:00:00.000Z');
  assert.equal(f511.canonicalCartId, 'C-1008');
  assert.equal(f511.proposedAction?.kind, 'reminder'); // The 26h account observation cannot unlock a coupon.
  assert.ok(has(f511, 'EXPLICIT_GUEST_ASSOCIATION'));
});

test('missing provenance and ambiguous guest candidates each prevent an account merge', async t => {
  for (const identity of [
    { kind: 'guest' as const, contactId: 'guest-1008', associatedFanIds: ['F-511'], provenance: null },
    { kind: 'guest' as const, contactId: 'guest-1008', associatedFanIds: ['F-511', 'F-other'], provenance: 'explicit conflicting evidence' },
    { kind: 'guest' as const, contactId: 'guest-1008', associatedFanIds: [], provenance: 'email-only observation' },
  ]) {
    await t.test(JSON.stringify(identity.associatedFanIds) + String(identity.provenance), () => {
      const result = evaluate(updateCart(originalSample(), 'C-1008', cart => ({ ...cart, identity })));
      assert.equal(result.length, 7);
      const guest = find(result, 'C-1008');
      assert.equal(guest.status, 'hold');
      assert.deepEqual(guest.sourceCartIds, ['C-1008']);
      assert.ok(has(guest, 'IDENTITY_UNRESOLVED'));
      assert.deepEqual(find(result, 'C-1002').sourceCartIds, ['C-1002']);
    });
  }
});

test('the same fan identifier in another tenant is a separate opportunity with no inherited consent', () => {
  const base = originalSample();
  const cart = base.carts.find(c => c.source.cartId === 'C-1002')!;
  const other = { ...cart, tenantId: 'synthetic:another-club' };
  const result = evaluate({ ...base, carts: [cart, other], evidence: { ...base.evidence,
    tenants: [...base.evidence.tenants, { tenantId: other.tenantId, active: true }],
    matches: [...base.evidence.matches, { ...base.evidence.matches.find(m => m.matchId === MATCH_LATER)!, tenantId: other.tenantId }],
  } });
  assert.equal(result.length, 2);
  assert.notEqual(result[0]!.key, result[1]!.key);
  const otherResult = result.find(o => o.tenantId === other.tenantId)!;
  assert.ok(has(otherResult, 'SCOPED_CONSENT_MISSING'));
  assert.ok(has(otherResult, 'DESTINATION_UNAVAILABLE'));
  assert.equal(otherResult.delivery.readiness, 'blocked');
});

test('conflicting associations across observations of the same tenant/contact hold the entire guest group', () => {
  const base = originalSample();
  const guest = base.carts.find(c => c.source.cartId === 'C-1008')!;
  assert.equal(guest.identity.kind, 'guest');
  if (guest.identity.kind !== 'guest') throw new Error('Fixture is not a guest');
  const conflict: Cart = { ...guest, source: { ...guest.source, cartId: 'guest-conflict' },
    identity: { ...guest.identity, associatedFanIds: ['F-other'] } };
  const input = { ...base, carts: [...base.carts, conflict] };
  const output = evaluate(input);
  const held = find(output, 'C-1008');
  assert.equal(held.status, 'hold');
  assert.deepEqual(held.sourceCartIds, ['C-1008', 'guest-conflict']);
  assert.deepEqual(find(output, 'C-1002').sourceCartIds, ['C-1002']);
  assert.deepEqual(output, evaluate({ ...input, carts: [...input.carts].reverse() }));
});

test('fan/match grouping does not merge different matches or discard conflicting baskets', () => {
  const base = originalSample();
  const cart = base.carts.find(c => c.source.cartId === 'C-1002')!;
  const other = { ...cart, matchId: 'different-match', source: { ...cart.source, cartId: 'different-cart', seats: 6 } };
  assert.equal(evaluate({ ...base, carts: [cart, other] }).length, 2);
  const coalesced = one({ ...base, carts: [cart, { ...other, matchId: cart.matchId }] });
  assert.equal(coalesced.sourceCarts[1]!.source.seats, 6);
  assert.deepEqual(coalesced.sourceCartIds, ['C-1002', 'different-cart']);
});

test('opt-out prevents email even when synthetic consent grants it', () => {
  const input = updateCart(promo(), 'C-1002', c => ({ ...c, source: { ...c.source, emailOptIn: 'No' } }));
  const out = one(input);
  assert.equal(out.status, 'hold');
  assert.equal(out.proposedChannel, null);
  assert.ok(has(out, 'NO_OPTED_IN_CHANNEL'));
});

test('F-092 never uses email, including when push destination is missing', () => {
  const base = originalSample();
  const out = find(evaluate(withEvidence(base, { destinations: base.evidence.destinations.filter(d => d.channel !== 'push') })), 'C-1003');
  assert.equal(out.proposedChannel, 'push');
  assert.equal(out.delivery.readiness, 'blocked');
  assert.ok(has(out, 'DESTINATION_UNAVAILABLE'));
});

test('opt-in is separate from destination ownership, reachability and scoped consent', async t => {
  const base = promo();
  const cases: [string, Partial<OperationalEvidence>, string][] = [
    ['missing destination', { destinations: [] }, 'DESTINATION_UNAVAILABLE'],
    ['unverified owner', { destinations: base.evidence.destinations.map(d => ({ ...d, verifiedOwner: false })) }, 'DESTINATION_OWNER_UNVERIFIED'],
    ['unusable destination', { destinations: base.evidence.destinations.map(d => ({ ...d, status: 'invalid' })) }, 'DESTINATION_INVALID'],
    ['malformed email', { destinations: base.evidence.destinations.map(d => ({ ...d, value: 'not-an-email' })) }, 'DESTINATION_INVALID'],
    ['missing scope', { consents: [] }, 'SCOPED_CONSENT_MISSING'],
    ['wrong tenant', { consents: base.evidence.consents.map(c => ({ ...c, tenantId: ONBOARDING })) }, 'SCOPED_CONSENT_MISSING'],
    ['wrong subject', { consents: base.evidence.consents.map(c => ({ ...c, subjectKey: 'fan:other' })) }, 'SCOPED_CONSENT_MISSING'],
    ['wrong purpose', { consents: base.evidence.consents.map(c => ({ ...c, purpose: 'transactional' })) }, 'SCOPED_CONSENT_MISSING'],
    ['missing provenance', { consents: base.evidence.consents.map(c => ({ ...c, provenance: '' })) }, 'SCOPED_CONSENT_MISSING'],
    ['revoked', { consents: base.evidence.consents.map(c => ({ ...c, status: 'revoked' })) }, 'CONSENT_REVOKED'],
    ['expired', { consents: base.evidence.consents.map(c => ({ ...c, validUntil: base.clock.now() })) }, 'SCOPED_CONSENT_MISSING'],
  ];
  for (const [label, patch, expected] of cases) await t.test(label, () => {
    const out = one(withEvidence(base, patch));
    assert.equal(out.status, 'recommend'); // Business action remains inspectable.
    assert.equal(out.delivery.readiness, 'blocked');
    assert.ok(has(out, expected));
  });
});

test('conflicting same-time consents fail closed independent of record order', () => {
  const base = promo();
  const granted = base.evidence.consents.find(c => c.subjectKey === 'fan:F-511')!;
  const revoked = { ...granted, status: 'revoked' as const };
  const a = one(withEvidence(base, { consents: [granted, revoked] }));
  const b = one(withEvidence(base, { consents: [revoked, granted] }));
  assert.deepEqual(a, b);
  assert.ok(has(a, 'CONSENT_REVOKED'));
  const expired = { ...granted, validUntil: base.clock.now() };
  const c = one(withEvidence(base, { consents: [granted, expired] }));
  assert.deepEqual(c, one(withEvidence(base, { consents: [expired, granted] })));
  assert.ok(has(c, 'SCOPED_CONSENT_MISSING'));
});

test('original business recommendations survive removal of synthetic delivery data but cannot authorize contact', () => {
  const base = originalSample();
  const out = evaluate(withEvidence(base, { destinations: [], consents: [], opportunities: [] }));
  assert.equal(find(out, 'C-1002').proposedAction?.kind, 'reminder');
  assert.equal(find(out, 'C-1003').proposedChannel, 'push');
  for (const o of out) assert.equal(o.delivery.readiness, 'blocked');
});

test('past and cancelled matches suppress recovery regardless of consent', () => {
  assert.ok(has(find(evaluate(originalSample()), 'C-1005'), 'MATCH_NOT_UPCOMING'));
  const base = promo();
  const out = one(withEvidence(base, { matches: base.evidence.matches.map(m => ({ ...m, state: 'cancelled' })) }));
  assert.equal(out.status, 'suppress');
  assert.equal(out.proposedAction, null);
});

test('season-pass ownership defers with uncertainty, then holds after the wait; never assumes six seats covered', () => {
  const base = originalSample();
  const early = find(evaluate(base), 'C-1004');
  assert.equal(early.status, 'defer');
  assert.ok(has(early, 'ENTITLEMENT_UNCERTAIN'));
  assert.ok(early.missingInformation.includes('pass_match_section_seat_coverage'));
  const aged = updateCart(base, 'C-1004', c => ({ ...c, lastActivityAt: '2026-11-10T13:00:00.000Z' }));
  assert.equal(find(evaluate(aged), 'C-1004').status, 'hold');
  const additional = withEvidence(aged, { opportunities: aged.evidence.opportunities.map(o =>
    o.subjectKey === 'fan:F-333' ? { ...o, entitlement: 'additional_seats' } : o) });
  assert.equal(find(evaluate(additional), 'C-1004').proposedAction?.kind, 'reminder');
  const covered = withEvidence(aged, { opportunities: aged.evidence.opportunities.map(o =>
    o.subjectKey === 'fan:F-333' ? { ...o, entitlement: 'cart_fully_covered' } : o) });
  assert.equal(find(evaluate(covered), 'C-1004').status, 'suppress');
});

test('unsynced spend remains unknown and does not by itself prevent a reminder after team activation', () => {
  const base = originalSample();
  const held = find(evaluate(base), 'C-1007');
  assert.equal(held.sourceCarts[0]!.shopSpendCents, 'not_synced');
  assert.equal(held.sourceCarts[0]!.source.shopSpend12Months, 'Not synced');
  assert.ok(has(held, 'TENANT_NOT_ACTIVATED'));
  const active = withEvidence(base, { tenants: base.evidence.tenants.map(t => ({ ...t, active: true })) });
  const out = find(evaluate(active), 'C-1007');
  assert.equal(out.proposedAction?.kind, 'reminder');
  assert.equal(out.delivery.readiness, 'checks_satisfied');
  assert.ok(out.missingInformation.includes('shop_spend_unknown_or_not_synced'));
  assert.equal(find(evaluate(base), 'C-1008').sourceCarts[1]!.shopSpendCents, 'unknown');
});

test('four-hour minimum wait is inclusive at the exact boundary', async t => {
  for (const [activity, status] of [
    ['2026-11-10T14:00:00.001Z', 'defer'],
    ['2026-11-10T14:00:00.000Z', 'recommend'],
    ['2026-11-10T13:59:59.999Z', 'recommend'],
  ] as const) await t.test(activity, () => {
    const base = originalSample();
    const input = updateCart(base, 'C-1008', c => ({ ...c, lastActivityAt: activity }));
    assert.equal(find(evaluate(input), 'C-1002').status, status);
  });
});

test('separate aged promo preserves original observations and proposes 10% / $14 exposure with no enforcement claim', () => {
  const base = promo();
  const out = one(base);
  assert.equal(base.clock.now(), '2026-11-11T18:00:00.000Z');
  assert.equal(out.latestActivityAt, '2026-11-10T13:00:00.000Z');
  assert.equal(out.sourceCarts[1]!.source.abandoned, '5 hrs ago');
  assert.deepEqual(out.proposedAction, { kind: 'promo', percent: 10, singleUseRequired: true, redemptionEnforced: false, eligibleSubtotalCents: 14000 });
  assert.deepEqual(out.incentiveExposure, { kind: 'known', currency: 'USD', maximumDiscountCents: 1400 });
  assert.equal(out.delivery.readiness, 'checks_satisfied');
});

test('24-hour promo threshold is inclusive and always uses the latest activity', async t => {
  for (const [latest, kind] of [
    ['2026-11-10T18:00:00.001Z', 'reminder'],
    ['2026-11-10T18:00:00.000Z', 'promo'],
    ['2026-11-10T17:59:59.999Z', 'promo'],
  ] as const) await t.test(latest, () => {
    const input = updateCart(promo(), 'C-1008', c => ({ ...c, lastActivityAt: latest }));
    assert.equal(one(input).proposedAction?.kind, kind);
  });
});

test('promo eligibility boundaries use strict sell-through and more-than-48-hour kickoff limits', async t => {
  for (const [sold, hoursToKickoff, kind] of [
    [59.99, 48.001, 'promo'], [60, 49, 'reminder'], [80, 49, 'reminder'], [59, 48, 'reminder'], [59, 47.99, 'reminder'],
  ] as const) await t.test(`${sold}% / ${hoursToKickoff}h`, () => {
    const base = promo();
    const input = withEvidence({ ...base, carts: base.carts.map(c => ({ ...c, sectionSoldPercent: sold,
      source: { ...c.source, sectionSold: `${sold}%` } })) }, {
      matches: base.evidence.matches.map(m => ({ ...m, kickoffAt: new Date(Date.parse(base.clock.now()) + hoursToKickoff * 3_600_000).toISOString() })),
    });
    assert.equal(one(input).proposedAction?.kind, kind);
  });
});

test('unknown/returning buyer history, missing commercial approval and stale data cannot unlock a promo', async t => {
  const base = promo();
  const cases: [string, EvaluationInput][] = [
    ['unknown history', updateCart(base, 'C-1002', c => ({ ...c, lifetimeTickets: 'unknown', source: { ...c.source, lifetimeTickets: 'Unknown' } }))],
    ['returning buyer', updateCart(base, 'C-1002', c => ({ ...c, lifetimeTickets: 1, source: { ...c.source, lifetimeTickets: 1 } }))],
    ['no commercial data', withEvidence(base, { commercial: [] })],
    ['unapproved', withEvidence(base, { commercial: base.evidence.commercial.map(c => ({ ...c, approved: false })) })],
    ['stale commercial', withEvidence(base, { commercial: base.evidence.commercial.map(c => ({ ...c, checkedAt: SYNTHETIC_SAMPLE_NOW })) })],
    ['unknown purchase', withEvidence(base, { opportunities: base.evidence.opportunities.map(o => ({ ...o, purchase: 'unknown' })) })],
    ['missing history', withEvidence(base, { opportunities: base.evidence.opportunities.map(o => ({ ...o, recoveryHistoryComplete: false })) })],
    ['missing club history', withEvidence(base, { opportunities: base.evidence.opportunities.map(o => ({ ...o, clubHistoryComplete: false })) })],
    ['stale match', withEvidence(base, { matches: base.evidence.matches.map(m => ({ ...m, checkedAt: SYNTHETIC_SAMPLE_NOW })) })],
    ['insufficient inventory', withEvidence(base, { matches: base.evidence.matches.map(m => ({ ...m, availableSeatsBySection: {} })) })],
  ];
  for (const [label, input] of cases) await t.test(label, () => assert.equal(one(input).proposedAction?.kind, 'reminder'));
});

test('discount cap, integer cents, allowance and floor are enforced independently of UI', () => {
  const commercial = { minimumNetCents: 0, maximumDiscountCents: 20000, maximumPercent: 15 };
  assert.equal(quoteDiscount(14000, 10, INITIAL_POLICY, commercial), 1400);
  assert.equal(quoteDiscount(14001, 10, INITIAL_POLICY, commercial), 1400);
  assert.equal(quoteDiscount(99, 10, INITIAL_POLICY, commercial), 9);
  assert.throws(() => quoteDiscount(14000, 15, INITIAL_POLICY, commercial), /cap/);
  assert.throws(() => quoteDiscount(14000, 11, INITIAL_POLICY, commercial), /cap/);
  assert.throws(() => quoteDiscount(14000, 10, { ...INITIAL_POLICY, promoPercent: 7 }, commercial), /cap/);
  assert.throws(() => quoteDiscount(14000, 16, { ...INITIAL_POLICY, promoPercent: 16 }, commercial), /policy/);
  assert.throws(() => quoteDiscount(14000, 10, INITIAL_POLICY, { ...commercial, maximumPercent: 9 }), /cap/);
  assert.throws(() => quoteDiscount(14000, 10, INITIAL_POLICY, { ...commercial, minimumNetCents: 12601 }), /floor/);
  assert.throws(() => quoteDiscount(14000, 10, INITIAL_POLICY, { ...commercial, maximumDiscountCents: 1399 }), /allowance/);
  for (const invalid of [1.5, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => quoteDiscount(invalid, 10, INITIAL_POLICY, commercial), /integer cents/);
  }
  assert.equal(quoteDiscount(14000, 15, { ...INITIAL_POLICY, promoPercent: 15 }, commercial), 2100);
});

test('stricter configured policy applies to real recommendations; commercial violations fall back to reminder', () => {
  const base = promo();
  const stricter = one({ ...base, policy: { ...base.policy, version: 'hypothesis-test-7', promoPercent: 7 } });
  assert.equal(stricter.proposedAction?.kind === 'promo' && stricter.proposedAction.percent, 7);
  assert.deepEqual(stricter.incentiveExposure, { kind: 'known', currency: 'USD', maximumDiscountCents: 980 });
  assert.equal(stricter.policyVersion, 'hypothesis-test-7');
  const floor = one(withEvidence(base, { commercial: base.evidence.commercial.map(c => ({ ...c, minimumNetCents: 12601 })) }));
  assert.equal(floor.proposedAction?.kind, 'reminder');
  assert.ok(has(floor, 'COMMERCIAL_LIMIT_PREVENTS_PROMO'));
});

test('a previous recovery contact suppresses a later coupon; pending/unknown contacts hold', async t => {
  for (const [state, expected] of [['accepted', 'suppress'], ['pending', 'hold'], ['unknown', 'hold']] as const) {
    await t.test(state, () => {
      const base = promo();
      const out = one(withEvidence(base, { contacts: [{ tenantId: SEAWOLVES, subjectKey: 'fan:F-511', matchId: MATCH_LATER,
        at: '2026-11-11T17:00:00.000Z', kind: 'recovery', state }] }));
      assert.equal(out.status, expected);
      assert.equal(out.proposedAction, null);
    });
  }
});

test('club-wide contact cooldown expires at exactly seven days; cross-tenant contacts have no effect', () => {
  const base = promo();
  const contact = { tenantId: SEAWOLVES, subjectKey: 'fan:F-511', matchId: 'other-match',
    at: '2026-11-04T18:00:00.001Z', kind: 'other_engine_marketing' as const, state: 'accepted' as const };
  const out = one(withEvidence(base, { contacts: [contact] }));
  assert.equal(out.status, 'defer');
  assert.equal(out.nextEligibleAt, '2026-11-11T18:00:00.001Z');
  assert.equal(one(withEvidence(base, { contacts: [{ ...contact, at: '2026-11-04T18:00:00.000Z' }] })).status, 'recommend');
  assert.equal(one(withEvidence(base, { contacts: [{ ...contact, tenantId: ONBOARDING }] })).status, 'recommend');
});

test('a relevant purchase suppresses recovery; stale/unknown purchase checks block delivery', () => {
  const base = promo();
  const purchased = one(withEvidence(base, { opportunities: base.evidence.opportunities.map(o => ({ ...o, purchase: 'purchased' })) }));
  assert.equal(purchased.status, 'suppress');
  const stale = one(withEvidence(base, { opportunities: base.evidence.opportunities.map(o => ({ ...o, checkedAt: SYNTHETIC_SAMPLE_NOW })) }));
  assert.equal(stale.proposedAction?.kind, 'reminder');
  assert.ok(has(stale, 'OPERATIONAL_EVIDENCE_MISSING'));
});

test('recovery expires at seven days inactivity and exactly two hours before kickoff', async t => {
  for (const [activity, kickoff, status] of [
    ['2026-11-04T18:00:00.001Z', '2026-11-15T18:00:00.000Z', 'recommend'],
    ['2026-11-04T18:00:00.000Z', '2026-11-15T18:00:00.000Z', 'suppress'],
    ['2026-11-10T13:00:00.000Z', '2026-11-11T20:00:00.001Z', 'recommend'],
    ['2026-11-10T13:00:00.000Z', '2026-11-11T20:00:00.000Z', 'suppress'],
  ] as const) await t.test(activity + kickoff, () => {
    const base = promo();
    const input = withEvidence({ ...base, carts: base.carts.map(c => ({ ...c, lastActivityAt: activity })) }, {
      matches: base.evidence.matches.map(m => ({ ...m, kickoffAt: kickoff })),
    });
    assert.equal(one(input).status, status);
  });
});

test('quiet-hour window is 09:00 inclusive to 20:00 exclusive in the explicit recipient timezone', async t => {
  for (const [timeZone, blocked] of [['America/Los_Angeles', false], ['Etc/GMT+9', false], ['Etc/GMT+10', true],
    ['Etc/GMT-1', false], ['Etc/GMT-2', true], [null, true], ['Invalid/Zone', true]] as const) {
    await t.test(String(timeZone), () => {
      const base = promo();
      const out = one(withEvidence(base, { opportunities: base.evidence.opportunities.map(o => ({ ...o, recipientTimeZone: timeZone })) }));
      assert.equal(out.delivery.readiness, blocked ? 'blocked' : 'checks_satisfied');
      assert.equal(out.status, 'recommend');
    });
  }
});

test('repeat evaluations are stable, read the clock once, and do not mutate inputs', () => {
  const input = originalSample();
  const before = JSON.stringify(input);
  let reads = 0;
  const counted = { ...input, clock: { now: () => { reads += 1; return SYNTHETIC_SAMPLE_NOW; } } };
  const first = evaluate(counted);
  assert.equal(reads, 1);
  assert.deepEqual(first, evaluate(counted));
  assert.equal(reads, 2);
  assert.equal(JSON.stringify(input), before);
});

test('cart order and independent evidence order never change results, including canonical timestamp ties', () => {
  const base = originalSample();
  const reversed: EvaluationInput = { ...base, carts: [...base.carts].reverse(), evidence: {
    tenants: [...base.evidence.tenants].reverse(), matches: [...base.evidence.matches].reverse(),
    opportunities: [...base.evidence.opportunities].reverse(), destinations: [...base.evidence.destinations].reverse(),
    consents: [...base.evidence.consents].reverse(), contacts: [], commercial: [],
  } };
  assert.deepEqual(evaluate(base), evaluate(reversed));
  for (let shift = 1; shift < base.carts.length; shift += 1) {
    assert.deepEqual(evaluate({ ...base, carts: [...base.carts.slice(shift), ...base.carts.slice(0, shift)] }), evaluate(base));
  }
  const tied = updateCart(base, 'C-1008', c => ({ ...c, lastActivityAt: '2026-11-09T16:00:00.000Z' }));
  assert.equal(find(evaluate(tied), 'C-1002').canonicalCartId, 'C-1002');
  assert.deepEqual(evaluate(tied), evaluate({ ...tied, carts: [...tied.carts].reverse() }));
});

test('keys remain stable as time/action/policy changes and cannot collide through delimiters', () => {
  const base = find(evaluate(originalSample()), 'C-1002');
  const aged = one(promo());
  assert.equal(base.key, aged.key);
  assert.equal(aged.key, one({ ...promo(), policy: { ...INITIAL_POLICY, version: 'new-version' } }).key);
  const input = promo();
  const a = one({ ...input, carts: input.carts.map(c => ({ ...c, tenantId: 'a:b', matchId: 'c' })) });
  const b = one({ ...input, carts: input.carts.map(c => ({ ...c, tenantId: 'a', matchId: 'b:c' })) });
  assert.notEqual(a.key, b.key);
});

test('malformed inputs and contradictory duplicate evidence fail visibly, without silent data loss', () => {
  const base = originalSample();
  assert.throws(() => evaluate({ ...base, carts: [...base.carts, base.carts[0]!] }), /Duplicate tenant\/cart/);
  assert.throws(() => evaluate(withEvidence(base, { matches: [...base.evidence.matches, base.evidence.matches[0]!] })), /Duplicate match/);
  assert.throws(() => evaluate(updateCart(base, 'C-1002', c => ({ ...c, cartValueCents: 140.5 }))), /integer cents/);
  assert.throws(() => evaluate(updateCart(base, 'C-1002', c => ({ ...c, lastActivityAt: '2026-11-11T18:00:00Z' }))), /future/);
  assert.throws(() => evaluate({ ...base, clock: { now: () => '2026-11-10T18:00:00' } }), /explicit-offset/);
  const missingMatch = find(evaluate(withEvidence(base, { matches: [] })), 'C-1002');
  assert.equal(missingMatch.status, 'hold');
  assert.equal(missingMatch.incentiveExposure.kind, 'unknown');
});
