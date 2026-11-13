import assert from 'node:assert/strict';
import test from 'node:test';
import { OutcomeStore } from '../src/outcome/store.js';
import { DEMO_CONTEXT, scenarioInput } from '../src/review/scenarios.js';
test('release: rejecting a queued approval prevents any provider attempt', () => {
  const store = new OutcomeStore(':memory:', DEMO_CONTEXT);
  try {
    store.seed('original', scenarioInput('original')); let box = store.inbox('original');
    let fan = box.items.find(i => i.payload.opportunity.subjectKey === 'fan:F-511')!;
    store.approve('original', box.generation, [{ revisionId: fan.revisionId, expectedVersion: fan.version }]);
    box = store.inbox('original'); fan = box.items.find(i => i.key === fan.key)!;
    store.reject('original', box.generation, { revisionId: fan.revisionId, expectedVersion: fan.version }, 'prefer_no_contact');
    assert.equal(store.runQueued('original', box.generation), 0);
    box = store.inbox('original'); assert.equal(box.dispatches![0]!.state, 'blocked'); assert.equal(box.dispatches![0]!.attempts.length, 0);
  } finally { store.close(); }
});
