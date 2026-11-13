import assert from 'node:assert/strict';
import test from 'node:test';
import { OutcomeStore } from '../src/outcome/store.js';
import { opportunityContext } from '../src/review/context.js';
import { DEMO_CONTEXT, scenarioInput } from '../src/review/scenarios.js';
test('context: verified original facts, ticketing question, wait, review, acceptance and stale evidence retain correct owners', () => {
  const store = new OutcomeStore(':memory:', DEMO_CONTEXT); store.seed('original', scenarioInput('original'));
  try {
    let inbox = store.inbox('original');
    const context = (fan: string) => opportunityContext(inbox.items.find(i => i.payload.opportunity.subjectKey === `fan:${fan}`)!, inbox);
    assert.match(context('F-333').why, /6 tickets additional/); assert.equal(context('F-333').owner, 'Club ticketing staff');
    assert.match(context('F-333').next, /No task has been assigned/); assert.ok(context('F-333').remaining.some(r => r.includes('waiting period')));
    assert.match(context('F-204').why, /2026-11-10 20:00/); assert.match(context('F-204').transition, /fresh permission/);
    assert.equal(context('F-511').owner, 'Marketer'); assert.match(context('F-777').why, /played/);
    const fan = inbox.items.find(i => i.payload.opportunity.subjectKey === 'fan:F-511')!;
    store.approve('original', inbox.generation, [{ revisionId: fan.revisionId, expectedVersion: fan.version }]); inbox = store.inbox('original');
    assert.match(context('F-511').why, /approved and awaiting/);
    store.runQueued('original', inbox.generation); inbox = store.inbox('original');
    assert.match(context('F-511').why, /Recovery contact already recorded/); assert.ok(context('F-511').receiptId);
    store.advanceClock('original', inbox.generation, 61); inbox = store.inbox('original');
    assert.match(context('F-092').why, /operational evidence expired/); assert.equal(context('F-092').owner, 'System/data operator');
    assert.ok(context('F-092').remaining.some(r => r.includes('does not establish opt-out')));
    assert.match(context('F-511').why, /no further recovery/); assert.match(context('F-511').transition, /cannot recall/);
  } finally { store.close(); }
});
