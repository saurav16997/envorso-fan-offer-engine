import assert from 'node:assert/strict';
import test from 'node:test';
import { OutcomeStore } from '../src/outcome/store.js';
import { DEMO_CONTEXT, scenarioInput } from '../src/review/scenarios.js';
import { makeProposal, PUSH_LIMITS } from '../src/review/proposal.js';
import { evaluate } from '../src/domain/engine.js';
import { validateWording } from '../src/copy/policy.js';
import type { Edit, ScenarioId } from '../src/review/types.js';
import type { EvaluationInput, Opportunity } from '../src/domain/types.js';

test('channel: complete push is bounded and separate from exact destination facts; email retains detail', () => {
  const input = scenarioInput('original'); const rows = evaluate(input);
  const push = makeProposal(input, rows.find(o => o.subjectKey === 'fan:F-092')!)!;
  assert.ok(push.content.subject.length <= PUSH_LIMITS.title); assert.ok(push.content.body.length <= PUSH_LIMITS.body);
  assert.ok(!push.content.body.includes('Your basket:')); assert.match(push.destinationContent!.body, /1 seat in Lower Bowl/);
  assert.equal(push.destinationContent!.url, push.content.ctaUrl);
  const email = makeProposal(input, rows.find(o => o.subjectKey === 'fan:F-511')!)!;
  assert.match(email.content.body, /4 seats in Upper Deck/); assert.equal(email.destinationContent, undefined);
  for (const p of [email, push]) assert.doesNotMatch(p.content.body + (p.destinationContent?.body ?? ''), /synthetic|proof of concept|not implemented|fixed demo clock|preview will not/i);
});

test('channel: legacy approval is invalidated by payload upgrade while immutable history is retained', () => {
  class Legacy extends OutcomeStore {
    protected override renderProposal(id: ScenarioId, input: EvaluationInput, o: Opportunity, edit?: Edit) {
      const p = super.renderProposal(id, input, o, edit); return p ? { ...p, templateVersion: 'recovery-v1' as const } : null;
    }
    protected override preserveHistoricalPayload() { return true; }
  }
  // A shared in-memory DB connection lets the current service read genuine immutable legacy rows.
  const old = new Legacy(':memory:', DEMO_CONTEXT); old.seed('original', scenarioInput('original'));
  let inbox = old.inbox('original'); const fan = inbox.items.find(i => i.payload.opportunity.subjectKey === 'fan:F-092')!;
  old.approve('original', inbox.generation, [{ revisionId: fan.revisionId, expectedVersion: fan.version }]);
  const snapshot = old.db.prepare('SELECT payload_json FROM revisions WHERE revision_id = ?').get(fan.revisionId)!.payload_json;
  // Switch only the service methods; the persisted connection/records remain the same.
  Object.setPrototypeOf(old, OutcomeStore.prototype);
  inbox = old.inbox('original'); const updated = inbox.items.find(i => i.key === fan.key)!;
  assert.equal(updated.reviewStatus, 'draft'); assert.equal(updated.approvedRevisionId, null);
  assert.notEqual(updated.revisionId, fan.revisionId); assert.ok(updated.revisions.some(r => r.id === fan.revisionId));
  assert.equal(old.db.prepare('SELECT payload_json FROM revisions WHERE revision_id = ?').get(fan.revisionId)!.payload_json, snapshot);
  assert.ok(inbox.history.some(e => e.kind === 'approved')); assert.equal(inbox.dispatches![0]!.state, 'blocked'); old.close();
});

test('copy validator v2: benign typography/equivalent actions pass; claims, links and control obfuscation remain blocked', () => {
  assert.throws(() => validateWording({ subject: 'Your ticket basket', introduction: 'Review your ticket basket for a frее upgrade.' }, 'email')); // Cyrillic homoglyphs must not bypass English claim checks.
  for (const introduction of ['When you’re ready, take another look at your ticket basket.', 'When convenient, you can review your ticket basket and decide whether you’d like to revisit it.']) {
    assert.equal(validateWording({ subject: 'Your ticket basket', introduction }, 'email').introduction, introduction);
  }
  for (const introduction of ['Hurry—review your ticket basket.', 'Review your basket for a free upgrade.', 'Review your basket with seats reserved.', 'Review your basket: https://bad.invalid', 'Review your basket\u202e today', '<b>Review your basket</b>', 'Review your basket for $5.', 'Review your basket for １０% off.']) {
    assert.throws(() => validateWording({ subject: 'Your ticket basket', introduction }, 'email'));
  }
});
