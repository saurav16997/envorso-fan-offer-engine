import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { OutcomeStore } from '../src/outcome/store.js';
import { ReviewStore } from '../src/review/store.js';
import { DEMO_CONTEXT, scenarioInput } from '../src/review/scenarios.js';
import { originalSample, agedPromoScenario, syntheticEvidence, ONBOARDING } from '../src/fixtures/scenarios.js';
import type { EvaluationInput } from '../src/domain/types.js';
import type { Inbox, ReviewItem, ScenarioId } from '../src/review/types.js';
import type { PromoView, RedemptionRequest } from '../src/outcome/types.js';

function setup(t: TestContext, scenario: ScenarioId = 'original', input = scenarioInput(scenario)) {
  const directory = mkdtempSync(join(tmpdir(), 'envorso-outcomes-'));
  const path = join(directory, 'outcome.sqlite');
  const stores: OutcomeStore[] = [];
  const open = (clock?: () => string): OutcomeStore => { const store = new OutcomeStore(path, DEMO_CONTEXT, clock); stores.push(store); return store; };
  const store = open(); store.seed(scenario, input);
  t.after(() => { for (const s of stores) if (s.db.isOpen) s.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, path, open };
}
const selected = (i: ReviewItem) => ({ revisionId: i.revisionId, expectedVersion: i.version });
const fan = (b: Inbox, id = 'fan:F-511'): ReviewItem => b.items.find(i => i.payload.opportunity.subjectKey === id)!;
function approve(store: OutcomeStore, scenario: ScenarioId = 'original', subject = 'fan:F-511'): Inbox {
  const b = store.inbox(scenario); store.approve(scenario, b.generation, [selected(fan(b, subject))]); return store.inbox(scenario);
}
const checkout = (p: PromoView): RedemptionRequest => ({ code: p.code, subjectKey: p.subjectKey, matchId: p.matchId,
  section: p.section, seats: p.seats, eligibleSubtotalCents: p.subtotalCents });
function providerCounts(store: OutcomeStore, scenario: ScenarioId) {
  return store.db.prepare('SELECT COUNT(*) AS requests, COALESCE(SUM(submissions),0) AS submissions, COUNT(provider_reference) AS accepted FROM simulated_provider_requests WHERE tenant_id = ? AND scenario_id = ?')
    .get(DEMO_CONTEXT.tenantId, scenario)!;
}
async function simultaneous(path: string, scenario: ScenarioId, generation: string, action: 'dispatch' | 'redeem', request?: RedemptionRequest) {
  const gate = new SharedArrayBuffer(4);
  const workers = [0, 1].map(() => new Worker(new URL('./helpers/outcome-worker.js', import.meta.url), { workerData: { path, scenario, generation, action, request, gate } }));
  const done = workers.map(w => new Promise<void>((resolve, reject) => { w.once('exit', () => resolve()); w.once('error', reject); }));
  const ready = workers.map(w => new Promise<void>((resolve, reject) => { w.once('error', reject); w.on('message', m => { if (m === 'ready') resolve(); }); }));
  const results = workers.map(w => new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve, reject) => {
    w.once('error', reject); w.on('message', m => { if (m !== 'ready') resolve(m); });
  }));
  await Promise.all(ready); Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0, 2);
  const output = await Promise.all(results); await Promise.all(done); return output;
}

test('outcomes: approval atomically creates one durable logical send; unapproved/stale revisions cannot send', t => {
  const { store, open } = setup(t);
  const draft = store.inbox('original');
  assert.equal(store.runQueued('original', draft.generation), 0);
  assert.equal(providerCounts(store, 'original').requests, 0);
  const approved = approve(store);
  assert.equal(approved.dispatches!.length, 1);
  const job = approved.dispatches![0]!;
  assert.equal(job.state, 'queued');
  store.approve('original', draft.generation, [selected(fan(draft))]);
  assert.equal(store.inbox('original').dispatches!.length, 1);
  const current = fan(store.inbox('original'));
  store.edit('original', draft.generation, selected(current), { channel: 'email', offer: 'reminder', percent: null, introduction: 'An invitation to revisit your basket.' });
  assert.equal(store.runQueued('original', draft.generation, job.id, job.revisionId), 0);
  assert.equal(providerCounts(store, 'original').requests, 0);
  store.close();
  assert.equal(open().inbox('original').dispatches![0]!.state, 'blocked');
});

test('outcomes: consent or purchase changes after approval block sending and preserve a clear receipt', t => {
  for (const change of ['revoke_consent', 'purchase'] as const) {
    const { store } = setup(t);
    const b = approve(store); const target = fan(b);
    if (change === 'revoke_consent') store.advanceClock('original', b.generation, 1);
    store.simulateChange('original', b.generation, selected(target), change);
    assert.equal(store.runQueued('original', b.generation), 0);
    const job = store.inbox('original').dispatches![0]!;
    assert.equal(job.state, 'blocked');
    assert.match(job.explanation, change === 'purchase' ? /purchase/i : /revoked/i);
    assert.equal(providerCounts(store, 'original').requests, 0);
  }
});

test('outcomes: stale evidence is never refreshed by a worker', t => {
  const { store } = setup(t); const b = approve(store);
  store.advanceClock('original', b.generation, 61);
  assert.equal(store.runQueued('original', b.generation), 0);
  assert.equal(store.inbox('original').dispatches![0]!.state, 'blocked');
  const raw = JSON.parse(store.db.prepare('SELECT input_json FROM scenarios WHERE tenant_id = ? AND scenario_id = ?').get(DEMO_CONTEXT.tenantId, 'original')!.input_json as string);
  assert.equal(raw.evidence.matches[0].checkedAt, '2026-11-10T18:00:00.000Z');
  assert.equal(providerCounts(store, 'original').requests, 0);
});

test('outcomes: quiet hours preserve the exact approved job without an attempt', t => {
  const base = originalSample(); const at = '2026-11-11T03:55:00Z';
  const input = { ...base, carts: base.carts.filter(c => ['C-1002', 'C-1008'].includes(c.source.cartId)), evidence: syntheticEvidence(at), clock: { now: () => at } };
  const { store } = setup(t, 'original', input); const b = approve(store);
  const revision = fan(b).revisionId;
  store.advanceClock('original', b.generation, 10);
  assert.equal(store.runQueued('original', b.generation), 0);
  const after = store.inbox('original');
  assert.equal(fan(after).reviewStatus, 'approved'); assert.equal(fan(after).revisionId, revision);
  assert.equal(after.dispatches![0]!.state, 'queued'); assert.equal(after.dispatches![0]!.attempts.length, 0);
  assert.equal(after.dispatches![0]!.nextCheckAt, '2026-11-11T17:00:00.000Z');
});

test('outcomes: simultaneous workers, repeated clicks and restart produce one accepted logical request', { timeout: 20_000 }, async t => {
  const { store, path, open } = setup(t); const b = approve(store);
  const results = await simultaneous(path, 'original', b.generation, 'dispatch');
  assert.ok(results.every(r => r.ok));
  assert.equal(results.reduce((n, r) => n + Number(r.value), 0), 1);
  assert.equal(store.runQueued('original', b.generation), 0);
  const after = store.inbox('original'); assert.equal(after.dispatches!.length, 1);
  assert.equal(after.dispatches![0]!.state, 'accepted'); assert.equal(after.dispatches![0]!.attempts.length, 1);
  assert.deepEqual({ ...providerCounts(store, 'original') }, { requests: 1, submissions: 1, accepted: 1 });
  store.close(); const reopened = open();
  assert.equal(reopened.inbox('original').dispatches![0]!.state, 'accepted');
  assert.equal(reopened.runQueued('original', b.generation), 0);
});

test('outcomes: accepted response loss reconciles without resubmission; unsupported lookup stays unknown across restart', t => {
  for (const mode of ['accepted_timeout', 'unknown_timeout'] as const) {
    const { store, open } = setup(t); const b = approve(store);
    store.setSimulator('original', b.generation, mode); store.runQueued('original', b.generation);
    const job = store.inbox('original').dispatches![0]!;
    assert.equal(job.state, 'unknown'); assert.equal(job.canRetry, false);
    assert.throws(() => store.reset('original', 'RESET original', originalSample(), b.generation), /unknown request cannot be erased/);
    assert.throws(() => store.retryDefiniteFailure('original', b.generation, job.id), /cannot be retried/);
    store.close(); const reopened = open();
    assert.equal(reopened.inbox('original').dispatches![0]!.state, 'unknown');
    reopened.setSimulator('original', b.generation, 'accepted'); // A mode change cannot manufacture evidence or release suppression.
    assert.equal(reopened.runQueued('original', b.generation), 0);
    const reconciled = reopened.reconcile('original', b.generation, job.id);
    assert.equal(reconciled.state, mode === 'accepted_timeout' ? 'accepted' : 'unknown');
    assert.equal(providerCounts(reopened, 'original').submissions, 1);
    assert.equal(reopened.inbox('original').dispatches![0]!.attempts[0]!.idempotencyKey, job.idempotencyKey);
  }
});

test('outcomes: explicit definite-failure retry uses the same key and is bounded to two submissions', t => {
  const { store } = setup(t); const b = approve(store);
  store.setSimulator('original', b.generation, 'rejected'); store.runQueued('original', b.generation);
  let job = store.inbox('original').dispatches![0]!; assert.equal(job.state, 'failed');
  store.retryDefiniteFailure('original', b.generation, job.id); store.runQueued('original', b.generation);
  job = store.inbox('original').dispatches![0]!; assert.equal(job.state, 'failed'); assert.equal(job.canRetry, false);
  assert.equal(job.attempts.length, 2); assert.equal(job.attempts[0]!.idempotencyKey, job.attempts[1]!.idempotencyKey);
  assert.throws(() => store.retryDefiniteFailure('original', b.generation, job.id), /cannot be retried/);
  assert.equal(providerCounts(store, 'original').submissions, 2);
});

test('outcomes: abandoned claims become unknown; a provider-call crash can reconcile its existing receipt', t => {
  for (const crossBoundary of [false, true]) {
    const { store, open } = setup(t); const b = approve(store); store.close();
    const first = open(() => '2026-11-11T18:00:00Z');
    const claim = first.claimNext('original', b.generation)!;
    if (crossBoundary) assert.equal(first.callClaim(claim)!.state, 'accepted');
    first.close(); const recovered = open(() => '2026-11-11T18:02:00Z');
    assert.equal(recovered.recoverClaims('original', b.generation), 1);
    assert.equal(recovered.inbox('original').dispatches![0]!.state, 'unknown');
    assert.equal(recovered.callClaim(claim), null); // Fenced old worker cannot start another call.
    assert.equal(recovered.reconcile('original', b.generation, claim.dispatchId).state, crossBoundary ? 'accepted' : 'unknown');
    assert.equal(providerCounts(recovered, 'original').submissions, crossBoundary ? 1 : 0);
  }
});

test('outcomes: in-flight snapshots resist edits, and an external purchase race does not falsify provider acceptance', t => {
  const { store } = setup(t); const b = approve(store); const original = fan(b);
  const claim = store.claimNext('original', b.generation)!;
  assert.throws(() => store.edit('original', b.generation, selected(original), { channel: 'email', offer: 'reminder', percent: null, introduction: 'Changed copy during flight.' }), /snapshot cannot be edited/);
  store.advanceClock('original', b.generation, 1);
  const result = store.callClaim(claim)!;
  store.simulateChange('original', b.generation, selected(fan(store.inbox('original'))), 'purchase');
  store.finishClaim(claim, result);
  const job = store.inbox('original').dispatches![0]!;
  assert.equal(job.state, 'accepted'); assert.deepEqual(job.payload, claim.payload);
  assert.equal(job.attempts[0]!.evaluationAt, '2026-11-10T18:01:00.000Z');
  assert.equal(providerCounts(store, 'original').accepted, 1);
});

test('outcomes: pre-send revision/channel changes reuse one logical slot and stale binding clicks cannot send', t => {
  const at = '2026-11-10T20:00:00Z'; const base = originalSample();
  const { store } = setup(t, 'original', { ...base, evidence: syntheticEvidence(at), clock: { now: () => at } });
  let b = approve(store, 'original', 'fan:F-204'); const old = b.dispatches![0]!;
  const current = fan(b, 'fan:F-204');
  store.edit('original', b.generation, selected(current), { channel: 'email', offer: 'reminder', percent: null, introduction: current.payload.proposal!.content.introduction });
  b = approve(store, 'original', 'fan:F-204'); const newer = b.dispatches![0]!;
  assert.equal(newer.id, old.id); assert.notEqual(newer.revisionId, old.revisionId); assert.equal(newer.payload.proposal!.channel, 'email');
  assert.throws(() => store.runQueued('original', b.generation, old.id, old.revisionId), /snapshot changed/);
  assert.equal(store.runQueued('original', b.generation, newer.id, newer.revisionId), 1);
  assert.equal(store.inbox('original').dispatches!.length, 1); assert.equal(providerCounts(store, 'original').accepted, 1);
});

test('outcomes: tenant/scenario boundaries preserve receipts, keys and codes independently', t => {
  const { store, path } = setup(t); let b = approve(store); const job = b.dispatches![0]!;
  store.seed('promo', agedPromoScenario()); b = approve(store, 'promo');
  assert.notEqual(b.dispatches![0]!.idempotencyKey, job.idempotencyKey);
  assert.throws(() => store.runQueued('promo', b.generation, job.id, job.revisionId), /not found/);
  const other = new OutcomeStore(path, { tenantId: ONBOARDING, actorId: 'demo:other' });
  try {
    other.seed('original', originalSample()); const theirs = other.inbox('original'); assert.equal(theirs.dispatches!.length, 0);
    assert.throws(() => other.reconcile('original', theirs.generation, job.id), /not found/);
    assert.throws(() => other.redeem('original', theirs.generation, checkout(b.promos![0]!)), /not found/);
  } finally { other.close(); }
});

test('outcomes: durable accepted history enforces club contact limits even if an input refresh omits it', t => {
  const { store } = setup(t); const b = approve(store); store.runQueued('original', b.generation);
  const input = originalSample();
  const cart = input.carts.find(c => c.source.cartId === 'C-1002')!;
  const match = input.evidence.matches.find(m => m.matchId === cart.matchId)!;
  const operations = input.evidence.opportunities.find(o => o.subjectKey === 'fan:F-511')!;
  const newMatch = 'synthetic:second-match';
  store.replaceInput('original', { ...input, carts: [...input.carts, { ...cart, matchId: newMatch,
    source: { ...cart.source, cartId: 'SYN-SECOND-CART', match: 'Synthetic separate home match' } }],
    evidence: { ...input.evidence, contacts: [], matches: [...input.evidence.matches, { ...match, matchId: newMatch }],
      opportunities: [...input.evidence.opportunities, { ...operations, matchId: newMatch }] } });
  const refreshed = store.inbox('original');
  const candidate = refreshed.items.find(i => i.payload.opportunity.matchId === newMatch)!;
  store.approve('original', b.generation, [selected(candidate)]);
  store.runQueued('original', b.generation);
  const blocked = store.inbox('original').dispatches!.find(j => j.matchId === newMatch)!;
  assert.equal(blocked.state, 'blocked'); assert.match(blocked.explanation, /cooldown/);
  assert.equal(providerCounts(store, 'original').accepted, 1);
});

test('outcomes: a persisted code is in the exact approved preview and repeat processing/retry never mints another', t => {
  const { store } = setup(t, 'promo'); let b = store.inbox('promo');
  const code = fan(b).payload.proposal!.offer.promoCode!;
  assert.ok(code.startsWith('DEMO-')); assert.match(fan(b).payload.proposal!.content.body, new RegExp(code));
  b = approve(store, 'promo'); assert.equal(b.promos!.length, 1); assert.equal(b.promos![0]!.state, 'active');
  store.setSimulator('promo', b.generation, 'rejected'); store.runQueued('promo', b.generation);
  const job = store.inbox('promo').dispatches![0]!;
  store.retryDefiniteFailure('promo', b.generation, job.id); store.setSimulator('promo', b.generation, 'accepted'); store.runQueued('promo', b.generation);
  b = store.inbox('promo'); assert.equal(b.promos!.length, 1); assert.equal(b.promos![0]!.code, code);
  assert.equal(b.dispatches![0]!.payload.proposal!.offer.promoCode, code);
  assert.equal(providerCounts(store, 'promo').accepted, 1);
});

test('outcomes: adding an issued code to a legacy approved promo creates a new draft requiring approval', () => {
  const directory = mkdtempSync(join(tmpdir(), 'envorso-legacy-promo-'));
  const path = join(directory, 'legacy.sqlite');
  const legacy = new ReviewStore(path, DEMO_CONTEXT);
  legacy.seed('promo', agedPromoScenario());
  const before = legacy.inbox('promo'); legacy.approve('promo', before.generation, [selected(fan(before))]); legacy.close();
  const current = new OutcomeStore(path, DEMO_CONTEXT);
  try {
    const after = current.inbox('promo');
    assert.equal(fan(after).reviewStatus, 'draft'); assert.equal(fan(after).approvedRevisionId, null);
    assert.equal(fan(after).revisionNumber, 2); assert.ok(fan(after).payload.proposal!.offer.promoCode);
    assert.equal(after.dispatches!.length, 0);
    assert.throws(() => current.approve('promo', after.generation, [selected(fan(before))]), /No proposals were approved/);
  } finally { current.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('outcomes: concurrent checkout consumes one code with one purchase and one inventory decrement', { timeout: 20_000 }, async t => {
  const { store, path, open } = setup(t, 'promo'); const b = approve(store, 'promo');
  store.runQueued('promo', b.generation); const p = store.inbox('promo').promos![0]!;
  const results = await simultaneous(path, 'promo', b.generation, 'redeem', checkout(p));
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.match(results.find(r => !r.ok)!.error!, /redeemed/);
  const after = store.inbox('promo'); assert.equal(after.purchases!.length, 1);
  assert.equal(after.purchases![0]!.discountCents, 1400); assert.equal(after.purchases![0]!.paidCents, 12600);
  assert.equal(after.promos![0]!.state, 'redeemed');
  const source = JSON.parse(store.db.prepare('SELECT input_json FROM scenarios WHERE tenant_id = ? AND scenario_id = ?').get(DEMO_CONTEXT.tenantId, 'promo')!.input_json as string);
  assert.equal(source.evidence.matches.find((m: { matchId: string }) => m.matchId === p.matchId).availableSeatsBySection['Upper Deck'], 96);
  store.close(); assert.equal(open().inbox('promo').purchases!.length, 1);
});

test('outcomes: wrong checkout scope, invalid cents, cancelled codes and stricter policy reject without consuming', t => {
  const { store } = setup(t, 'promo'); const b = approve(store, 'promo'); const p = b.promos![0]!;
  for (const patch of [{ subjectKey: 'fan:other' }, { matchId: 'another-match' }, { section: 'Club' }, { seats: 5 },
    { eligibleSubtotalCents: -1 }, { eligibleSubtotalCents: 14000.5 }, { eligibleSubtotalCents: 14001 }]) {
    assert.throws(() => store.redeem('promo', b.generation, { ...checkout(p), ...patch }));
  }
  assert.equal(store.inbox('promo').purchases!.length, 0);
  store.cancelPromo('promo', b.generation, p.code); assert.throws(() => store.redeem('promo', b.generation, checkout(p)), /cancelled/);
  assert.equal(store.runQueued('promo', b.generation), 0);
  assert.match(store.inbox('promo').dispatches![0]!.explanation, /cancelled/);
  assert.equal(providerCounts(store, 'promo').requests, 0);
  const stricter = setup(t, 'promo'); const approved = approve(stricter.store, 'promo');
  stricter.store.runQueued('promo', approved.generation);
  const input = agedPromoScenario();
  stricter.store.replaceInput('promo', { ...input, policy: { ...input.policy, version: 'stricter-seven', promoPercent: 7 } });
  assert.throws(() => stricter.store.redeem('promo', approved.generation, checkout(approved.promos![0]!)), /policy.*cap/);
  assert.equal(stricter.store.inbox('promo').purchases!.length, 0);
});

test('outcomes: simulated checkout rounds integer-cent discounts down without exceeding the approved exposure', t => {
  const base = agedPromoScenario();
  const input = { ...base, carts: base.carts.map(c => ({ ...c, cartValueCents: 14001, source: { ...c.source, cartValue: '$140.01' } })),
    evidence: { ...base.evidence, commercial: base.evidence.commercial.map(c => ({ ...c, eligibleSubtotalCents: 14001, minimumNetCents: 12601 })) } };
  const { store } = setup(t, 'promo', input); const b = approve(store, 'promo');
  const order = store.redeem('promo', b.generation, checkout(b.promos![0]!));
  assert.equal(order.discountCents, 1400); assert.equal(order.paidCents, 12601);
});

function shortExpiry(): EvaluationInput {
  const base = agedPromoScenario(); const until = '2026-11-11T21:00:00Z';
  return { ...base, policy: { ...base.policy, version: 'test-expiry', maximumInactivityHours: 30, evidenceMaxAgeHours: 3 },
    evidence: { ...base.evidence,
      matches: base.evidence.matches.map(x => ({ ...x, validUntil: until })), opportunities: base.evidence.opportunities.map(x => ({ ...x, validUntil: until })),
      consents: base.evidence.consents.map(x => ({ ...x, validUntil: until })), commercial: base.evidence.commercial.map(x => ({ ...x, validUntil: until })) } };
}
test('outcomes: exact expiration blocks dispatch and redemption while other evidence is still fresh', t => {
  for (const sent of [false, true]) {
    const { store } = setup(t, 'promo', shortExpiry()); const b = approve(store, 'promo'); const p = b.promos![0]!;
    if (sent) store.runQueued('promo', b.generation);
    store.advanceClock('promo', b.generation, 60);
    if (!sent) { assert.equal(store.runQueued('promo', b.generation), 0); assert.equal(store.inbox('promo').dispatches![0]!.state, 'blocked'); }
    else assert.throws(() => store.redeem('promo', b.generation, checkout(p)), /expired/);
  }
});
