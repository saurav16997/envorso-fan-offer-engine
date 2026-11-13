import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { originalSample, agedPromoScenario, ONBOARDING } from '../src/fixtures/scenarios.js';
import type { EvaluationInput } from '../src/domain/types.js';
import { executeReview } from '../src/review/commands.js';
import { validLocalOrigin } from '../src/review/origin.js';
import { ReviewStore } from '../src/review/store.js';
import { DEMO_CONTEXT, groupedScenario } from '../src/review/scenarios.js';
import type { Edit, Inbox, ReviewItem, ScenarioId } from '../src/review/types.js';

function setup(t: TestContext, id: ScenarioId = 'original', input = originalSample()) {
  const directory = mkdtempSync(join(tmpdir(), 'envorso-review-'));
  const path = join(directory, 'review.sqlite');
  const stores: ReviewStore[] = [];
  const open = (): ReviewStore => { const store = new ReviewStore(path, DEMO_CONTEXT); stores.push(store); return store; };
  const store = open();
  store.seed(id, input);
  t.after(() => { for (const s of stores) if (s.db.isOpen) s.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, path, open };
}
const selected = (item: ReviewItem) => ({ revisionId: item.revisionId, expectedVersion: item.version });
const item = (inbox: Inbox, subject = 'fan:F-511'): ReviewItem => {
  const found = inbox.items.find(i => i.payload.opportunity.subjectKey === subject);
  assert.ok(found); return found;
};
const edit = (i: ReviewItem, introduction = 'A quick invitation to revisit your ticket basket.'): Edit => ({
  channel: i.payload.proposal!.channel, offer: i.payload.proposal!.offer.kind,
  percent: i.payload.proposal!.offer.percent, introduction,
});
const countDecisions = (store: ReviewStore, id: ScenarioId): number => Number(store.db.prepare(
  'SELECT COUNT(*) AS count FROM review_decisions WHERE tenant_id = ? AND scenario_id = ? AND kind = ?').get(DEMO_CONTEXT.tenantId, id, 'approve')!.count);

test('review persistence: immutable revisions, exact approval and source associations survive reopening without duplicate processing', t => {
  const { store, open } = setup(t);
  const before = store.inbox('original');
  const target = item(before);
  store.approve('original', before.generation, [selected(target)]);
  assert.throws(() => store.db.prepare('UPDATE revisions SET payload_json = ? WHERE tenant_id = ? AND scenario_id = ? AND revision_id = ?')
    .run('{}', DEMO_CONTEXT.tenantId, 'original', target.revisionId), /immutable/);
  store.close();
  const reopened = open();
  assert.equal(reopened.seed('original', originalSample()), false);
  const after = reopened.inbox('original');
  assert.equal(after.items.length, 5);
  assert.equal(item(after).reviewStatus, 'approved');
  assert.equal(item(after).approvedRevisionId, target.revisionId);
  assert.equal(item(after).revisions.length, 1);
  assert.deepEqual(item(after).payload, target.payload);
  assert.equal(countDecisions(reopened, 'original'), 1);
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM source_associations WHERE tenant_id = ? AND scenario_id = ?').get(DEMO_CONTEXT.tenantId, 'original')!.count, 7);
  const again = reopened.approve('original', before.generation, [selected(target)]);
  assert.equal(again.alreadyApproved, 1);
  assert.equal(countDecisions(reopened, 'original'), 1);
});

test('review persistence: rejected opportunities stay closed after new facts, reprocessing and restart', t => {
  const { store, open } = setup(t);
  const before = store.inbox('original');
  const target = item(before);
  store.reject('original', before.generation, selected(target), 'prefer_no_contact');
  store.reject('original', before.generation, selected(target), 'prefer_no_contact');
  const input = originalSample();
  store.replaceInput('original', { ...input, carts: input.carts.map(c => c.source.cartId === 'C-1008'
    ? { ...c, lastActivityAt: '2026-11-10T12:00:00Z' } : c) });
  store.close();
  const after = open().inbox('original');
  assert.equal(item(after).reviewStatus, 'rejected');
  assert.equal(item(after).revisionId, target.revisionId);
  assert.equal(after.history.filter(h => h.kind === 'rejected').length, 1);
  assert.throws(() => open().approve('original', after.generation, [selected(item(after))]), /No proposals were approved/);
});

test('review persistence: edits invalidate approval and stale tabs cannot approve old content', t => {
  const { store } = setup(t);
  const before = store.inbox('original');
  store.approve('original', before.generation, [selected(item(before))]);
  const approved = item(store.inbox('original'));
  store.edit('original', before.generation, selected(approved), edit(approved));
  const draft = item(store.inbox('original'));
  assert.equal(draft.reviewStatus, 'draft');
  assert.equal(draft.approvedRevisionId, null);
  assert.equal(draft.revisionNumber, 2);
  assert.equal(draft.revisions[1]!.payload.proposal!.content.introduction, 'You can pick up where you left off with your ticket basket.');
  assert.throws(() => store.approve('original', before.generation, [selected(approved)]), /No proposals were approved/);
  assert.ok(store.inbox('original').history.some(e => e.kind === 'approval_invalidated'));
});

test('review persistence: refreshing checks or processing time alone does not revise content or invalidate approval', t => {
  const { store } = setup(t);
  const before = store.inbox('original');
  store.approve('original', before.generation, [selected(item(before))]);
  const input = originalSample();
  const checkedAt = '2026-11-10T18:05:00Z';
  const fresh = <T extends { checkedAt: string; validUntil: string }>(x: T): T => ({ ...x, checkedAt, validUntil: '2026-11-10T19:05:00Z' });
  store.replaceInput('original', { ...input, clock: { now: () => checkedAt }, evidence: { ...input.evidence,
    matches: input.evidence.matches.map(fresh), opportunities: input.evidence.opportunities.map(fresh),
    commercial: input.evidence.commercial.map(fresh), consents: input.evidence.consents.map(fresh) } });
  const after = item(store.inbox('original'));
  assert.equal(after.revisionId, item(before).revisionId);
  assert.equal(after.reviewStatus, 'approved');
});

test('review persistence: real simultaneous requests from separate connections create one effective approval', { timeout: 20_000 }, async t => {
  const { store, path } = setup(t);
  const before = store.inbox('original');
  const gate = new SharedArrayBuffer(4);
  const workers = [0, 1].map(() => new Worker(new URL('./helpers/approve-worker.js', import.meta.url), {
    workerData: { path, scenario: 'original', generation: before.generation, selection: selected(item(before)), gate },
  }));
  const exited = workers.map(worker => new Promise<void>(resolve => worker.once('exit', () => resolve())));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  const ready = workers.map(worker => new Promise<void>((resolve, reject) => { worker.once('error', reject); worker.on('message', value => { if (value === 'ready') resolve(); }); }));
  const complete = workers.map(worker => new Promise<{ result: { approved: number; alreadyApproved: number } }>((resolve, reject) => {
    worker.once('error', reject); worker.on('message', value => { if (value !== 'ready') resolve(value); });
  }));
  await Promise.all(ready);
  Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0, 2);
  const results = await Promise.all(complete);
  await Promise.all(exited);
  assert.equal(results.reduce((n, r) => n + r.result.approved, 0), 1);
  assert.equal(results.reduce((n, r) => n + r.result.alreadyApproved, 0), 1);
  assert.equal(countDecisions(store, 'original'), 1);
});

test('review persistence: consent, purchase, destination and source disappearance before approval invalidate the exact proposal', t => {
  for (const change of ['consent', 'purchase', 'destination', 'source'] as const) {
    const { store } = setup(t);
    const before = store.inbox('original');
    const target = item(before);
    const input = originalSample();
    const changed: EvaluationInput = { ...input, carts: change === 'source'
      ? input.carts.filter(c => !target.payload.opportunity.sourceCartIds.includes(c.source.cartId)) : input.carts,
      evidence: { ...input.evidence,
        consents: input.evidence.consents.map(c => change === 'consent' && c.subjectKey === 'fan:F-511' ? { ...c, status: 'revoked' } : c),
        opportunities: input.evidence.opportunities.map(o => change === 'purchase' && o.subjectKey === 'fan:F-511' ? { ...o, purchase: 'purchased' } : o),
        destinations: input.evidence.destinations.map(d => change === 'destination' && d.subjectKey === 'fan:F-511' ? { ...d, value: 'changed@example.invalid' } : d) } };
    store.replaceInput('original', changed);
    assert.throws(() => store.approve('original', before.generation, [selected(target)]), /No proposals were approved/, change);
    assert.equal(countDecisions(store, 'original'), 0);
    const current = item(store.inbox('original'));
    assert.notEqual(current.revisionId, target.revisionId);
    if (change === 'source') assert.equal(current.payload.opportunity.incentiveExposure.kind, 'unknown');
  }
});

test('review persistence: tenant-scoped reads and actions do not expose or approve another tenant revision', t => {
  const { store, path } = setup(t);
  const other = new ReviewStore(path, { tenantId: ONBOARDING, actorId: 'other:actor' });
  try {
    other.seed('original', originalSample());
    const otherInbox = other.inbox('original');
    assert.equal(otherInbox.items.length, 1);
    assert.equal(store.inbox('original').items.length, 5);
    assert.ok(store.inbox('original').items.every(i => i.payload.opportunity.tenantId === DEMO_CONTEXT.tenantId));
    assert.throws(() => store.approve('original', store.inbox('original').generation, [selected(otherInbox.items[0]!)]), /No proposals were approved/);
  } finally { other.close(); }
});

test('review persistence: a stale or blocked selection rolls back every batch approval', t => {
  const { store } = setup(t, 'grouped', groupedScenario());
  const before = store.inbox('grouped');
  const chosen = before.items.filter(i => i.payload.proposal?.channel === 'email' && i.payload.opportunity.delivery.readiness === 'checks_satisfied').slice(0, 2);
  assert.equal(chosen.length, 2);
  store.edit('grouped', before.generation, selected(chosen[1]!), edit(chosen[1]!));
  assert.throws(() => store.approve('grouped', before.generation, chosen.map(selected), true), /No proposals were approved/);
  assert.equal(countDecisions(store, 'grouped'), 0);
  let current = store.inbox('grouped');
  const second = current.items.find(i => i.key === chosen[1]!.key)!;
  store.simulateChange('grouped', current.generation, selected(second), 'revoke_consent');
  current = store.inbox('grouped');
  const blocked = current.items.find(i => i.key === second.key)!;
  assert.throws(() => store.approve('grouped', current.generation, [selected(chosen[0]!), selected(blocked)], true), /No proposals were approved/);
  assert.equal(countDecisions(store, 'grouped'), 0);
  const compatible = current.items.filter(i => i.payload.proposal?.channel === 'email' && i.payload.opportunity.delivery.readiness === 'checks_satisfied').slice(0, 2);
  assert.equal(store.approve('grouped', current.generation, compatible.map(selected), true).approved, 2);
  assert.equal(countDecisions(store, 'grouped'), 2);
});

test('review persistence: discounts and mixed-channel reminders cannot enter batch approval', t => {
  const { store } = setup(t, 'promo', agedPromoScenario());
  const promo = store.inbox('promo');
  assert.throws(() => store.approve('promo', promo.generation, [selected(item(promo))], true), /No proposals were approved/);
  assert.equal(countDecisions(store, 'promo'), 0);
  store.seed('grouped', groupedScenario());
  const grouped = store.inbox('grouped');
  const email = grouped.items.find(i => i.payload.proposal?.channel === 'email')!;
  const push = grouped.items.find(i => i.payload.proposal?.channel === 'push')!;
  assert.throws(() => store.approve('grouped', grouped.generation, [selected(email), selected(push)], true), /No proposals were approved/);
  assert.equal(countDecisions(store, 'grouped'), 0);
});

test('review persistence: server rejects bypassed UI restrictions and recomputes permitted promo terms/exposure', t => {
  assert.equal(validLocalOrigin('http://127.0.0.1:3100', '127.0.0.1:3100'), true);
  assert.equal(validLocalOrigin('http://localhost:3000', 'localhost:3000'), true);
  assert.equal(validLocalOrigin('https://untrusted.example', '127.0.0.1:3100'), false);
  assert.equal(validLocalOrigin('http://127.0.0.1:3101', '127.0.0.1:3100'), false);
  const { store } = setup(t);
  const before = store.inbox('original');
  const target = item(before);
  assert.throws(() => executeReview(store, { action: 'approve', scenario: 'original', generation: before.generation,
    selection: selected(target), tenantId: ONBOARDING, actorId: 'forged' }), /Unsupported request field/);
  assert.throws(() => store.edit('original', before.generation, selected(target), { ...edit(target), offer: 'promo', percent: 10 }), /reminder only/);
  assert.throws(() => store.edit('original', before.generation, selected(target), { ...edit(target), introduction: 'Take 50% off now' }), /locked message/);
  const push = item(before, 'fan:F-092');
  assert.throws(() => store.edit('original', before.generation, selected(push), { ...edit(push), channel: 'email' }), /requested channel/);
  store.seed('promo', agedPromoScenario());
  const promo = store.inbox('promo');
  const p = item(promo);
  assert.throws(() => store.edit('promo', promo.generation, selected(p), { ...edit(p), percent: 15 }), /configured policy/);
  store.edit('promo', promo.generation, selected(p), { ...edit(p), percent: 7 });
  const changed = item(store.inbox('promo'));
  assert.equal(changed.payload.proposal!.exposure.kind === 'known' && changed.payload.proposal!.exposure.maximumDiscountCents, 980);
  assert.match(changed.payload.proposal!.content.body, /7% off.*\$140\.00.*\$9\.80/);
  assert.equal(changed.payload.proposal!.offer.redemptionEnforced, false);
});

test('review persistence: scenario reset is explicit, isolated and invalidates old generations', t => {
  const { store } = setup(t);
  store.seed('promo', agedPromoScenario());
  const original = store.inbox('original');
  const promo = store.inbox('promo');
  store.approve('promo', promo.generation, [selected(item(promo))]);
  assert.throws(() => store.reset('original', '', originalSample()), /Type RESET/);
  store.reset('original', 'RESET original', originalSample(), original.generation);
  assert.notEqual(store.inbox('original').generation, original.generation);
  assert.equal(item(store.inbox('promo')).reviewStatus, 'approved');
  assert.throws(() => store.approve('original', original.generation, [selected(item(original))]), /scenario was reset/);
  assert.throws(() => store.reset('original', 'RESET original', originalSample(), original.generation), /scenario was reset/);
});
