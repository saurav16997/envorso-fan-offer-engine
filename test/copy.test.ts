import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopyStore } from '../src/copy/store.js';
import { copyConfig } from '../src/copy/provider.js';
import type { CopyConfig } from '../src/copy/provider.js';
import { copyContext, LIMITS, validateWording } from '../src/copy/policy.js';
import { DEMO_CONTEXT, scenarioInput } from '../src/review/scenarios.js';
import { proposalEdit } from '../src/review/proposal.js';
import { copyCases } from '../src/copy/evaluation.js';

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'envorso-copy-')); const path = join(dir, 'review.sqlite');
  let at = '2026-11-11T18:00:00Z'; const store = new CopyStore(path, DEMO_CONTEXT, () => at);
  store.seed('original', scenarioInput('original'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const inbox = () => store.inbox('original'); const item = () => inbox().items.find(i => i.payload.opportunity.subjectKey === 'fan:F-511')!;
  const selection = () => ({ revisionId: item().revisionId, expectedVersion: item().version });
  const suggest = (config: CopyConfig) => store.suggest('original', inbox().generation, selection(), 'email', 'reminder', config);
  return { store, path, inbox, item, selection, suggest, advance: () => { at = new Date(Date.parse(at) + 16_000).toISOString(); } };
}
const wording = { subject: 'Review your Seawolves ticket basket', introduction: 'You can revisit your ticket basket whenever you like.' };
const good: CopyConfig = { enabled: true, model: 'test-model', provider: 'openai', generate: async () => ({ state: 'suggested', value: wording }) };

test('copy: missing/disabled server configuration never generates; templates and edited wording remain usable', async t => {
  assert.equal(copyConfig({}).enabled, false);
  assert.equal(copyConfig({ OPENAI_API_KEY: 'synthetic-test-only' }).enabled, false);
  assert.equal(copyConfig({ COPY_DRAFT_ENABLED: 'true', OPENAI_API_KEY: 'YOUR_KEY_HERE' }).enabled, false);
  assert.equal(copyConfig({ COPY_DRAFT_PROVIDER: 'test_fixture', COPY_DRAFT_TEST_FIXTURE: '1', RECOVERY_DB_PATH: 'normal.sqlite' }).enabled, false);
  const x = setup(t); const before = x.item(); let calls = 0;
  const result = await x.suggest({ ...good, enabled: false, generate: async () => { calls++; return { state: 'suggested', value: wording }; } });
  assert.equal(result.outcome, 'unavailable'); assert.equal(result.wording, null); assert.equal(calls, 0);
  assert.equal(x.item().revisionId, before.revisionId); assert.equal(x.inbox().dispatches!.length, 0);
});

test('copy: schema, lengths, unsafe claims and missing next action fail closed without saving raw suggestions', async t => {
  const x = setup(t); const before = x.item().revisionId;
  for (const value of [{ introduction: 'Hi' }, { ...wording, extra: 'field' }, { ...wording, subject: 's'.repeat(71) },
    { ...wording, introduction: 'x'.repeat(241) }, { ...wording, introduction: 'Only two seats left. Revisit your basket.' },
    { ...wording, introduction: 'Welcome back! Revisit your ticket basket with friends.' },
    { ...wording, introduction: 'Review your basket with a free upgrade.' }, { ...wording, introduction: 'Review your basket at https://bad.invalid' },
    { ...wording, introduction: 'We know you love rugby.' }]) {
    const result = await x.suggest({ ...good, generate: async () => ({ state: 'suggested', value }) });
    assert.equal(result.outcome, 'invalid'); assert.equal(result.wording, null); x.advance();
  }
  assert.equal(x.item().revisionId, before);
  assert.equal(x.store.db.prepare('SELECT COUNT(*) AS n FROM copy_generations WHERE wording_json IS NOT NULL').get()!.n, 0);
  assert.throws(() => validateWording({ subject: null, introduction: 'Review your basket. '.repeat(8) }, 'push'));
  assert.throws(() => validateWording(wording, 'push'));
});

test('copy: refusal, incomplete and provider errors keep current proposal; errors and secrets are not returned/stored', async t => {
  const x = setup(t); const before = x.item().revisionId;
  for (const state of ['refused', 'incomplete'] as const) {
    const result = await x.suggest({ ...good, generate: async () => ({ state }) }); assert.equal(result.outcome, state); x.advance();
  }
  const secret = 'synthetic-key-not-a-real-secret';
  const result = await x.suggest({ ...good, generate: async () => { throw new Error(`${secret} f511@example.invalid`); } });
  assert.equal(result.outcome, 'error'); assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(x.inbox().copyHistory).includes(secret)); assert.ok(!JSON.stringify(x.inbox().history).includes(secret));
  assert.equal(x.item().revisionId, before);
});

test('copy: deadline aborts a hanging provider once, with no retries or saved wording', { timeout: 16_000 }, async t => {
  const x = setup(t); let calls = 0; let aborted = false;
  const result = await x.suggest({ ...good, generate: async (_, signal) => { calls++; signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); } });
  assert.equal(result.outcome, 'timeout'); assert.equal(calls, 1); assert.equal(aborted, true); assert.equal(result.wording, null);
});

test('copy: concurrent connections/repeated clicks share persisted cooldown and daily request budget', async t => {
  const x = setup(t); let release!: () => void; let calls = 0;
  const first = x.suggest({ ...good, generate: async () => { calls++; await new Promise<void>(r => { release = r; }); return { state: 'suggested', value: wording }; } });
  const second = new CopyStore(x.path, DEMO_CONTEXT, () => '2026-11-11T18:00:00Z');
  try { await assert.rejects(second.suggest('original', x.inbox().generation, x.selection(), 'email', 'reminder', good), /already running/); }
  finally { second.close(); release(); await first; }
  await assert.rejects(x.suggest(good), /cooling down/);
  for (let n = 1; n < LIMITS.dailyRequests; n++) { x.advance(); await x.suggest(good); }
  x.advance(); await assert.rejects(x.suggest(good), /daily/); assert.equal(calls, 1);
});

test('copy: generation never saves/approves/sends; accepted wording creates a fresh revision and invalidates queued approval', async t => {
  const x = setup(t); x.store.approve('original', x.inbox().generation, [x.selection()]); const before = x.item();
  const result = await x.suggest(good);
  assert.equal(x.item().reviewStatus, 'approved'); assert.equal(x.item().revisionId, before.revisionId); assert.equal(x.inbox().dispatches![0]!.attempts.length, 0);
  x.store.edit('original', x.inbox().generation, x.selection(), { ...proposalEdit(before.payload.proposal!), ...result.wording!, subject: result.wording!.subject!, suggestionId: result.id });
  assert.notEqual(x.item().revisionId, before.revisionId); assert.equal(x.item().reviewStatus, 'draft'); assert.equal(x.item().approvedRevisionId, null);
  assert.equal(x.inbox().dispatches![0]!.state, 'blocked');
  assert.equal(x.inbox().copyProvenance!.at(-1)!.source, 'ai_assisted');
  x.store.approve('original', x.inbox().generation, [x.selection()]);
  x.store.runQueued('original', x.inbox().generation); assert.equal(x.inbox().dispatches![0]!.state, 'accepted');
  await assert.rejects(x.suggest(good), /snapshot|blocked/);
});

test('copy: edited suggestion provenance, stale/channel-bound suggestions and in-flight snapshots are enforced', async t => {
  const x = setup(t); const result = await x.suggest(good); const before = x.item();
  assert.throws(() => x.store.edit('original', x.inbox().generation, x.selection(), { ...proposalEdit(before.payload.proposal!), suggestionId: 'not-ours' }), /does not belong/);
  x.store.edit('original', x.inbox().generation, x.selection(), { ...proposalEdit(before.payload.proposal!), introduction: 'Please review your ticket basket at your convenience.', suggestionId: result.id });
  assert.equal(x.inbox().copyProvenance!.at(-1)!.source, 'marketer_edited');
  assert.throws(() => x.store.edit('original', x.inbox().generation, x.selection(), { ...proposalEdit(x.item().payload.proposal!), suggestionId: result.id }), /current revision/);
  x.store.approve('original', x.inbox().generation, [x.selection()]); const claim = x.store.claimNext('original', x.inbox().generation)!;
  x.advance(); await assert.rejects(x.suggest(good), /snapshot cannot be edited/);
  assert.deepEqual(x.inbox().dispatches![0]!.payload, claim.payload);
});

test('copy: a consent change while a provider runs discards its suggestion without reviving approval', async t => {
  const x = setup(t); let release!: () => void;
  const result = x.suggest({ ...good, generate: async () => { await new Promise<void>(r => { release = r; }); return { state: 'suggested', value: wording }; } });
  x.store.simulateChange('original', x.inbox().generation, x.selection(), 'revoke_consent'); release();
  assert.equal((await result).outcome, 'stale'); assert.equal(x.item().approvedRevisionId, null);
});

test('copy: minimal context excludes destinations, IDs, history, terms and operator injection for every synthetic case', async t => {
  const x = setup(t); let sent: unknown;
  const result = await x.suggest({ ...good, generate: async context => { sent = context; return { state: 'suggested', value: wording }; } });
  assert.equal(result.outcome, 'suggested'); assert.deepEqual(Object.keys(sent as object).sort(), ['channel', 'club', 'offerCategory', 'tone']);
  assert.ok(!JSON.stringify(sent).includes('F-511')); assert.ok(!JSON.stringify(result).includes('@example.invalid'));
  for (const c of copyCases) { assert.equal(Object.keys(c.context).length, 4); assert.ok(!JSON.stringify(c.context).includes('Ignore system')); }
  const p = x.item().payload.proposal!; assert.deepEqual(copyContext(p), sent);
  assert.equal(copyCases.length, 8);
});

test('copy: official SDK sends bounded schema/context only, disables storage, and does not retry errors', async () => {
  let calls = 0; let requestBody: Record<string, unknown> | undefined;
  const config = copyConfig({ COPY_DRAFT_ENABLED: 'true', OPENAI_API_KEY: 'synthetic-sdk-test-only' }, async (_, init) => {
    calls++; requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: 'synthetic-response', object: 'response', status: 'completed',
      output: [{ id: 'synthetic-message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(wording), annotations: [] }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const result = await config.generate!(copyCases[0]!.context, new AbortController().signal);
  assert.equal(result.state, 'suggested'); assert.deepEqual(result.value, wording); assert.equal(calls, 1);
  assert.equal(requestBody!.store, false); assert.equal(requestBody!.max_output_tokens, LIMITS.outputTokens); assert.equal(requestBody!.tools, undefined);
  assert.equal(JSON.stringify(requestBody!.input).includes('first-purchase'), false);
  const format = (requestBody!.text as { format: { strict: boolean; type: string } }).format; assert.equal(format.strict, true); assert.equal(format.type, 'json_schema');
  calls = 0;
  const failing = copyConfig({ COPY_DRAFT_ENABLED: 'true', OPENAI_API_KEY: 'synthetic-sdk-test-only' }, async () => { calls++; return new Response('{}', { status: 500 }); });
  await assert.rejects(failing.generate!(copyCases[0]!.context, new AbortController().signal)); assert.equal(calls, 1);
});
