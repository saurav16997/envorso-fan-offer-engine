import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

// Own temporary database and random local port. Never reset or mutate the user's normal demo database.
mkdirSync(resolve('.tmp'), { recursive: true });
mkdirSync(resolve('artifacts/browser'), { recursive: true });
const directory = mkdtempSync(resolve('.tmp/browser-'));
const dbPath = join(directory, 'review.sqlite');
process.env.RECOVERY_DB_PATH = dbPath;
const { seedDemo } = await import('../dist/src/review/server.js');
const { ReviewStore } = await import('../dist/src/review/store.js');
const { DEMO_CONTEXT } = await import('../dist/src/review/scenarios.js');
// Seed one genuinely approved legacy payload, then upgrade via the actual server/UI.
class LegacyPushStore extends ReviewStore {
  renderProposal(id, input, opportunity, edit) {
    const p = super.renderProposal(id, input, opportunity, edit);
    return p && opportunity.subjectKey === 'fan:F-092' ? { ...p, templateVersion: 'recovery-v1', content: { ...p.content, body: 'Legacy full detailed push body.' } } : p;
  }
  preserveHistoricalPayload() { return true; }
}
const legacy = new LegacyPushStore(dbPath, DEMO_CONTEXT);
const { scenarioInput } = await import('../dist/src/review/scenarios.js');
legacy.seed('original', scenarioInput('original'));
const legacyInbox = legacy.inbox('original');
const legacyFan = legacyInbox.items.find(i => i.payload.opportunity.subjectKey === 'fan:F-092');
legacy.approve('original', legacyInbox.generation, [{ revisionId: legacyFan.revisionId, expectedVersion: legacyFan.version }]);
legacy.close();
seedDemo();
const db = new ReviewStore(dbPath, DEMO_CONTEXT);
const expectedGeneration = db.inbox('original').generation;
db.close();
const reserve = createServer();
await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [resolve('node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: process.cwd(), env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', RECOVERY_DB_PATH: dbPath,
    COPY_DRAFT_PROVIDER: 'test_fixture', COPY_DRAFT_TEST_FIXTURE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
server.stdout.on('data', chunk => { logs += chunk; });
server.stderr.on('data', chunk => { logs += chunk; });
const serverExit = new Promise(resolve => server.once('exit', resolve));
let browser;
let browserPage;
const results = [];
async function closeIndividual(p) { const d = p.getByRole('dialog').filter({ has: p.locator('.detail-panel') }); if (await d.count()) await d.getByRole('button', { name: 'Close dialog', exact: true }).click(); }
async function until(check, message, timeout = 12_000) {
  const stop = Date.now() + timeout;
  while (Date.now() < stop) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(message);
}
try {
  await until(async () => {
    if (server.exitCode !== null) throw new Error(`Owned Next server exited: ${logs}`);
    try { const response = await fetch(`${base}/api/inbox?scenario=original`); return response.ok && (await response.json()).generation === expectedGeneration; }
    catch { return false; }
  }, `Production server did not become ready: ${logs}`, 30_000);
  try { browser = await chromium.launch({ channel: 'chrome', headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  browserPage = page;
  page.on('response', async response => { if (response.url().includes('/api/') && !response.ok()) logs += `\nHTTP ${response.status()} ${await response.text().catch(() => '')}`; });
  const pageErrors = [];
  async function basketCheck(fan, cart, quantity, section, value, scope = page.locator('.detail-panel .detail-section .preview').first(), scenario = 'original') {
    const before = await (await context.request.get(`${base}/api/inbox?scenario=${scenario}`)).json();
    const address = page.url(); let mutations = 0;
    const observe = request => { if (request.method() !== 'GET' && request.url().startsWith(base)) mutations++; };
    page.on('request', observe);
    const trigger = scope.getByRole('button', { name: 'Review your basket', exact: true });
    await trigger.focus(); await page.keyboard.press('Enter');
    const region = scope.getByRole('region', { name: 'Simulated basket preview' }); await region.waitFor();
    const saved = before.items.find(i => i.payload.opportunity.subjectKey === `fan:${fan}`);
    for (const expected of [fan, cart, String(quantity), section, value, saved.revisionId]) assert.ok((await region.textContent()).includes(expected));
    assert.equal(await page.getByRole('dialog').count(), 1);
    await until(async () => region.getByRole('heading', { name: 'Simulated basket preview' }).evaluate(e => e === document.activeElement), 'Basket heading did not receive focus');
    await page.keyboard.press('Escape');
    await until(async () => trigger.evaluate(e => e === document.activeElement), 'Basket trigger focus was not restored');
    await trigger.press('Space'); await region.waitFor();
    await region.getByRole('button', { name: 'Back to message preview' }).click();
    await until(async () => trigger.evaluate(e => e === document.activeElement), 'Basket trigger focus was not restored after Back');
    assert.equal(page.url(), address); assert.equal(mutations, 0); page.off('request', observe);
    assert.deepEqual(await (await context.request.get(`${base}/api/inbox?scenario=${scenario}`)).json(), before);
  }
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base);
  assert.equal((await (await context.request.get(base)).text()).includes('data-scribe-recorder-ready'), false);
  assert.equal(await page.locator('html').getAttribute('data-scribe-recorder-ready'), null);
  await page.getByRole('heading', { name: 'Recovery inbox', exact: true }).waitFor();
  assert.equal(await page.locator('.queue .table-scroll').evaluate(e => e.scrollWidth <= e.clientWidth), true);
  assert.ok((await page.getByLabel('Ready-to-review discount cap', { exact: true }).textContent()).includes('$0.00'));
  await page.screenshot({ path: resolve('artifacts/browser/release-compact-queue.png'), fullPage: true });
  for (const [fan, text] of [['F-333', '6 tickets additional'], ['F-204', '2026-11-10 20:00'], ['F-511', 'marketer review']]) {
    await closeIndividual(page);
    if (fan !== 'F-511') await page.getByRole('tab', { name: /Needs attention|Waiting \/ excluded/ }).filter({ hasText: fan === 'F-333' ? 'Needs attention' : 'Waiting / excluded' }).click();
    else await page.getByRole('tab', { name: /Ready to review/ }).click();
    await page.getByRole('button', { name: `Review ${fan}`, exact: true }).click();
    const c = page.locator(`.detail-panel [aria-label="Context for ${fan}"]`);
    assert.ok((await c.textContent()).includes(text));
    if (fan === 'F-333') assert.ok((await c.textContent()).includes('Club ticketing staff'));
    await page.screenshot({ path: resolve(`artifacts/browser/context-before-${fan}.png`), fullPage: true });
  }
  await closeIndividual(page);
  await page.reload();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Skip to review inbox');
  await page.getByRole('tab', { name: /Ready to review/ }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: /Needs attention/ }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowLeft');
  await closeIndividual(page);
  assert.equal(await page.locator('.detail-panel').count(), 0);
  await page.getByRole('button', { name: 'Review F-511', exact: true }).click();
  await page.getByRole('dialog', { name: 'F-511 · Email · Reminder', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit proposal', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button', { name: 'Review F-511', exact: true }).evaluate(e => e === document.activeElement), true);
  await page.getByRole('button', { name: 'Review F-511', exact: true }).press('Enter');
  await basketCheck('F-511', 'C-1008', 4, 'Upper Deck', '$140.00');
  await page.screenshot({ path: resolve('artifacts/browser/original-inbox-desktop.png'), fullPage: true });
  results.push('Desktop original scenario and keyboard skip/tab navigation verified.');
  await closeIndividual(page);
  await page.getByRole('button', { name: 'Review F-092', exact: true }).click();
  await page.getByRole('region', { name: 'Detailed destination content' }).waitFor();
  await basketCheck('F-092', 'C-1003', 1, 'Lower Bowl', '$58.00');
  const migrated = await (await context.request.get(`${base}/api/inbox?scenario=original`)).json();
  const migratedPush = migrated.items.find(i => i.payload.opportunity.subjectKey === 'fan:F-092');
  assert.equal(migratedPush.reviewStatus, 'draft'); assert.equal(migratedPush.revisions.length, 2);
  assert.ok(migratedPush.revisions.some(r => r.id === legacyFan.revisionId && r.payload.proposal.templateVersion === 'recovery-v1'));
  assert.ok(migratedPush.payload.proposal.content.body.length <= 160);
  assert.ok(migrated.history.some(e => e.kind === 'approved' && e.revisionId === legacyFan.revisionId));
  await page.getByRole('button', { name: /Approve revision 2/ }).waitFor();
  await page.screenshot({ path: resolve('artifacts/browser/push-v2-migration.png'), fullPage: true });
  results.push('External-review corrections: actual compact F-092 push and separate destination inspected; legacy approved revision retained with historical approval; migrated draft requires fresh approval.');
  await closeIndividual(page);
  await page.getByRole('button', { name: 'Review F-511', exact: true }).click();

  await page.getByRole('button', { name: 'Edit proposal', exact: true }).click();
  const introduction = 'A friendly invitation to revisit your ticket basket.';
  await page.getByLabel('Message introduction').fill(introduction);
  await basketCheck('F-511', 'C-1008', 4, 'Upper Deck', '$140.00');
  assert.equal(await page.getByLabel('Message introduction').inputValue(), introduction);
  await page.getByRole('button', { name: 'Save new draft', exact: true }).click();
  await until(async () => {
    if (await page.locator('.error-message[role="alert"]').count()) throw new Error(`Save failed in browser: ${await page.locator('.error-message[role="alert"]').textContent()}`);
    return await page.getByRole('button', { name: /Approve revision 2/ }).count() > 0;
  }, 'Updated revision did not appear after saving the edit');
  assert.ok((await page.locator('.detail-panel .message-body').first().textContent()).includes(introduction));
  await page.getByRole('button', { name: /Approve revision 2/ }).click();
  await until(async () => (await page.locator('.notice[role="status"]').textContent())?.includes('Approved this exact revision'), 'Approval success not shown');
  await page.reload();
  await closeIndividual(page);
  await page.getByRole('tab', { name: /Review history/ }).click();
  await closeIndividual(page);
  await page.getByRole('button', { name: 'Review F-511', exact: true }).click();
  await page.getByText('✓ Approved, awaiting dispatch. Nothing has been sent.', { exact: true }).waitFor();
  assert.ok((await page.locator('.detail-panel [aria-label="Context for F-511"]').textContent()).includes('approved and awaiting dispatch'));
  const persisted = await (await context.request.get(`${base}/api/inbox?scenario=original`)).json();
  const f511 = persisted.items.find(i => i.payload.opportunity.subjectKey === 'fan:F-511');
  assert.equal(f511.reviewStatus, 'approved'); assert.equal(f511.revisions.length, 2);
  assert.ok(persisted.history.some(h => h.kind === 'approved' && h.revisionId === f511.revisionId && h.actorId === 'demo:marketer'));
  await page.screenshot({ path: resolve('artifacts/browser/original-approved-desktop.png'), fullPage: true });
  results.push('F-511 edited, updated preview inspected, exact revision approved, reload verified persisted approval/history.');

  const stale = await context.newPage();
  stale.on('pageerror', error => pageErrors.push(error.message));
  await stale.goto(base);
  await closeIndividual(stale);
  await stale.getByRole('button', { name: 'Review F-092', exact: true }).click();
  await closeIndividual(page);
  await page.getByRole('tab', { name: /Ready to review/ }).click();
  await closeIndividual(page);
  await page.getByRole('button', { name: 'Review F-092', exact: true }).click();
  await page.locator('details.demo-controls > summary').click();
  await page.getByRole('button', { name: 'Simulate revoked consent', exact: true }).click();
  await page.getByText('This item requires evidence resolution.', { exact: false }).waitFor();
  await stale.getByRole('button', { name: /Approve revision 2/ }).click();
  await stale.locator('.error-message[role="alert"]').waitFor();
  assert.ok((await stale.locator('.error-message[role="alert"]').textContent()).includes('stale'));
  await stale.screenshot({ path: resolve('artifacts/browser/stale-approval-blocked.png'), fullPage: true });
  const blocked = await (await context.request.get(`${base}/api/inbox?scenario=original`)).json();
  assert.equal(blocked.items.find(i => i.payload.opportunity.subjectKey === 'fan:F-092').reviewStatus, 'draft');
  results.push('Consent revocation blocked a stale-tab approval; no effective approval was created.');
  await stale.close();

  await closeIndividual(page);
  await page.getByLabel('Demo scenario', { exact: true }).selectOption('grouped');
  await page.getByRole('checkbox', { name: 'Select SYN-F-001 for batch review', exact: true }).waitFor();
  await page.getByRole('checkbox', { name: 'Select SYN-F-001 for batch review', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Select SYN-F-002 for batch review', exact: true }).check();
  assert.equal(await page.locator('.detail-panel').count(), 0);
  await page.getByText('2 selected · $0 incentive', { exact: true }).waitFor();
  await page.getByText('Different channel, match, template or policy from the selected batch.', { exact: false }).first().waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Select SYN-F-007 for batch review', exact: true }).isDisabled(), true);
  await closeIndividual(page);
  await page.getByRole('button', { name: 'Review selected (2)', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review 2 selected reminders', exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.locator('.batch-preview').count(), 2);
  await basketCheck('SYN-F-001', 'SYN-C-1', 2, 'Upper Deck', '$70.00', dialog.locator('.batch-preview .preview').first(), 'grouped');
  assert.equal(await dialog.locator('.batch-preview').count(), 2);
  assert.ok((await dialog.textContent()).includes('syn-f-001@example.invalid'));
  assert.ok((await dialog.textContent()).includes('syn-f-002@example.invalid'));
  assert.equal(await dialog.getByRole('button', { name: 'Approve selected reminders', exact: true }).isDisabled(), true);
  await dialog.getByRole('checkbox', { name: 'I reviewed every selected recipient and exact message preview.', exact: true }).check();
  await page.screenshot({ path: resolve('artifacts/browser/grouped-reminder-review.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Approve selected reminders', exact: true }).click();
  await until(async () => (await page.locator('.notice[role="status"]').textContent())?.includes('2 reminders approved'), 'Grouped approval success not shown');
  const grouped = await (await context.request.get(`${base}/api/inbox?scenario=grouped`)).json();
  assert.equal(grouped.items.filter(i => i.reviewStatus === 'approved').length, 2);
  assert.deepEqual(grouped.items.filter(i => i.reviewStatus === 'approved').map(i => i.payload.opportunity.subjectKey).sort(), ['fan:SYN-F-001', 'fan:SYN-F-002']);
  results.push('Grouped workload: two explicit compatible recipients/previews reviewed and approved individually in one transaction; incompatible push rows disabled.');

  await closeIndividual(page);
  await page.getByLabel('Demo scenario', { exact: true }).selectOption('promo');
  await page.getByRole('button', { name: 'Review F-511', exact: true }).waitFor();
  assert.ok((await page.getByLabel('Ready-to-review discount cap', { exact: true }).textContent()).includes('$14.00'));
  await closeIndividual(page);
  await page.getByRole('button', { name: 'Review F-511', exact: true }).click();
  assert.equal(await page.locator('input[aria-label="Select F-511 for batch review"]').isDisabled(), true);
  assert.ok((await page.locator('.detail-panel .message-body').first().textContent()).includes('up to $14.00'));
  await page.screenshot({ path: resolve('artifacts/browser/promo-individual-review.png'), fullPage: true });
  await page.getByRole('button', { name: /Approve revision 1/ }).click();
  await until(async () => (await page.locator('.notice[role="status"]').textContent())?.includes('Approved this exact revision'), 'Individual promo approval not shown');
  assert.ok((await page.getByLabel('Ready-to-review discount cap', { exact: true }).textContent()).includes('$0.00'));
  const originalAgain = await (await context.request.get(`${base}/api/inbox?scenario=original`)).json();
  assert.equal(originalAgain.items.find(i => i.payload.opportunity.subjectKey === 'fan:F-511').revisionId, f511.revisionId);
  results.push('Separate 10% / $14 promo reviewed individually; reminder batching disabled; original history remains isolated.');

  const openDetails = async locator => { if (!await locator.evaluate(el => el.open)) await locator.locator(':scope > summary').click(); };
  // A. Original approved F-511 -> fresh checks -> simulated email acceptance -> reload receipt.
  await closeIndividual(page);
  await page.getByLabel('Demo scenario', { exact: true }).selectOption('original');
  await closeIndividual(page);
  await page.getByRole('tab', { name: /Delivery activity/ }).click();
  await page.getByRole('button', { name: 'Inspect send F-511', exact: true }).click();
  await openDetails(page.locator('.outcome-controls:not(.request-controls)'));
  await page.getByRole('button', { name: 'Run queued delivery', exact: true }).click();
  await page.locator('.dispatch-state.accepted').first().waitFor();
  await page.reload(); await page.getByRole('tab', { name: /Delivery activity/ }).click();
  await page.getByRole('button', { name: 'Inspect send F-511', exact: true }).click();
  assert.ok((await page.locator('.outcome-receipt').textContent()).includes('SIM-email-'));
  assert.ok((await page.locator('.outcome-receipt .message-body').first().textContent()).includes(introduction));
  await page.screenshot({ path: resolve('artifacts/browser/delivery-original-accepted.png'), fullPage: true });
  results.push('A: Original F-511 exact approved email accepted by simulator; reload preserves the immutable attempted message and receipt.');
  await page.getByRole('tab', { name: /Waiting \/ excluded/ }).click();
  await page.getByRole('button', { name: 'Review F-511', exact: true }).click();
  const acceptedContext = page.locator('.detail-panel [aria-label="Context for F-511"]');
  assert.ok((await acceptedContext.textContent()).includes('Recovery contact already recorded; no further recovery message for this match'));
  await page.screenshot({ path: resolve('artifacts/browser/context-F-511-accepted.png'), fullPage: true });
  await acceptedContext.getByRole('button', { name: 'View existing receipt', exact: true }).click();
  await page.getByRole('region', { name: 'Simulated receipt for F-511' }).waitFor();
  await openDetails(page.locator('.outcome-controls:not(.request-controls)'));
  await page.getByRole('button', { name: 'Advance demo clock 61 minutes', exact: true }).click();
  await page.getByRole('tab', { name: /Needs attention/ }).click();
  await page.getByRole('button', { name: 'Review F-092', exact: true }).click();
  const staleContext = page.locator('.detail-panel [aria-label="Context for F-092"]');
  assert.ok((await staleContext.textContent()).includes('operational evidence expired'));
  assert.ok((await staleContext.textContent()).includes('System/data operator'));
  await staleContext.getByText(/Remaining requirements/).click();
  assert.ok((await staleContext.textContent()).includes('does not establish opt-out'));
  await page.screenshot({ path: resolve('artifacts/browser/context-F-092-stale.png'), fullPage: true });
  await closeIndividual(page);
  await page.getByRole('tab', { name: /Waiting \/ excluded/ }).click();
  await page.getByRole('button', { name: 'Review F-511', exact: true }).click();
  assert.ok((await page.locator('.detail-panel [aria-label="Context for F-511"]').textContent()).includes('cannot recall an already accepted message'));
  await page.screenshot({ path: resolve('artifacts/browser/context-F-511-after-clock.png'), fullPage: true });
  await closeIndividual(page);

  // B. Another tab retains a queued snapshot while consent is revoked after approval.
  await closeIndividual(page);
  await page.getByLabel('Demo scenario', { exact: true }).selectOption('grouped');
  await closeIndividual(page);
  await page.getByRole('tab', { name: /Delivery activity/ }).click();
  await page.getByRole('button', { name: 'Inspect send SYN-F-001', exact: true }).click();
  const blockedTab = await context.newPage(); blockedTab.on('pageerror', e => pageErrors.push(e.message));
  await blockedTab.goto(`${base}/?scenario=grouped`); await blockedTab.getByRole('tab', { name: /Delivery activity/ }).click();
  await blockedTab.getByRole('button', { name: 'Inspect send SYN-F-001', exact: true }).click();
  await openDetails(blockedTab.locator('.request-controls'));
  await openDetails(page.locator('.request-controls'));
  await page.getByRole('button', { name: 'Simulate consent change after approval', exact: true }).click();
  await page.locator('.dispatch-state.blocked').first().waitFor();
  await blockedTab.getByRole('button', { name: 'Run this queued request', exact: true }).click();
  await blockedTab.locator('.dispatch-state.blocked').first().waitFor();
  assert.ok((await blockedTab.locator('.outcome-explanation').textContent()).includes('revoked'));
  await blockedTab.screenshot({ path: resolve('artifacts/browser/delivery-consent-blocked.png'), fullPage: true });
  await blockedTab.close();
  results.push('B: Consent revoked after approval blocks an old tab’s queued dispatch, with an explicit revoked-permission explanation.');

  // C. Accepted but response lost: unknown -> lookup reconciliation, no new submission.
  await page.getByRole('button', { name: 'Inspect send SYN-F-002', exact: true }).click();
  await openDetails(page.locator('.outcome-controls:not(.request-controls)'));
  await page.getByLabel('Simulator outcome', { exact: true }).selectOption('accepted_timeout');
  await openDetails(page.locator('.request-controls'));
  await page.getByRole('button', { name: 'Run this queued request', exact: true }).click();
  await page.locator('.dispatch-state.unknown').first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Queue one definite-failure retry', exact: true }).count(), 0);
  await page.screenshot({ path: resolve('artifacts/browser/delivery-timeout-unknown.png'), fullPage: true });
  await page.getByRole('button', { name: 'Reconcile uncertain outcome', exact: true }).click();
  await page.locator('.dispatch-state.accepted').first().waitFor();
  const { OutcomeStore } = await import('../dist/src/outcome/store.js');
  const audit = new OutcomeStore(dbPath, DEMO_CONTEXT);
  const provider = audit.db.prepare('SELECT COUNT(*) AS requests, SUM(submissions) AS submissions FROM simulated_provider_requests WHERE tenant_id = ? AND scenario_id = ?').get(DEMO_CONTEXT.tenantId, 'grouped');
  audit.close(); assert.equal(provider.requests, 1); assert.equal(provider.submissions, 1);
  await page.screenshot({ path: resolve('artifacts/browser/delivery-timeout-reconciled.png'), fullPage: true });
  results.push('C: Accepted-but-lost response shown as unknown, reconciled with its stable key/receipt; exactly one simulated submission remains.');

  // D. The actual persisted code was in the approved preview before dispatch; checkout consumes it once.
  await closeIndividual(page);
  await page.getByLabel('Demo scenario', { exact: true }).selectOption('promo');
  await closeIndividual(page);
  await page.getByRole('tab', { name: /Delivery activity/ }).click();
  await page.getByRole('button', { name: 'Inspect send F-511', exact: true }).click();
  await openDetails(page.locator('.request-controls'));
  await page.getByRole('button', { name: 'Run this queued request', exact: true }).click();
  await page.locator('.dispatch-state.accepted').first().waitFor();
  await page.getByRole('button', { name: 'Simulate promo redemption', exact: true }).click();
  await page.getByText('Simulated purchase recorded', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Attempt second redemption (expect rejection)', exact: true }).click();
  await page.locator('.error-message[role="alert"]').waitFor();
  assert.ok((await page.locator('.error-message[role="alert"]').textContent()).includes('redeemed'));
  const purchased = await (await context.request.get(`${base}/api/inbox?scenario=promo`)).json();
  assert.equal(purchased.purchases.length, 1); assert.equal(purchased.purchases[0].discountCents, 1400);
  assert.equal(purchased.dispatches[0].state, 'accepted'); assert.equal(purchased.promos[0].state, 'redeemed');
  await page.screenshot({ path: resolve('artifacts/browser/promo-redeemed-and-repeat-blocked.png'), fullPage: true });
  results.push('D: Actual approved demo code sent through simulator, redeemed once with a $14 discount / $126 simulated paid amount; second checkout rejected.');

  // Optional copy workflow uses an explicitly labeled server test fixture, never the user's API key.
  await closeIndividual(page);
  await page.getByLabel('Demo scenario', { exact: true }).selectOption('grouped');
  await closeIndividual(page);
  await page.getByRole('button', { name: 'Review SYN-F-003', exact: true }).click();
  await page.getByRole('button', { name: 'Edit proposal', exact: true }).click();
  const editorIntro = 'A quiet invitation to review your ticket basket.';
  await page.getByLabel('Message introduction').fill(editorIntro);
  const copyBefore = await (await context.request.get(`${base}/api/inbox?scenario=grouped`)).json();
  await page.getByRole('button', { name: 'Suggest wording', exact: true }).click();
  await page.getByText('TEST FIXTURE — no live AI generation', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Synthetic test suggestion', exact: true }).waitFor();
  await page.screenshot({ path: resolve('artifacts/browser/copy-suggestion-test-fixture.png'), fullPage: true });
  await page.getByRole('button', { name: 'Discard suggestion', exact: true }).click();
  assert.equal(await page.getByLabel('Message introduction').inputValue(), editorIntro);
  const afterDiscard = await (await context.request.get(`${base}/api/inbox?scenario=grouped`)).json();
  const copyFan = b => b.items.find(i => i.payload.opportunity.subjectKey === 'fan:SYN-F-003');
  assert.equal(copyFan(afterDiscard).revisionId, copyFan(copyBefore).revisionId);
  // Exercise the real cooldown rather than overriding request limits for tests.
  await new Promise(resolve => setTimeout(resolve, 15_100));
  await page.getByRole('button', { name: 'Suggest wording', exact: true }).click();
  await page.getByRole('button', { name: 'Use suggestion in editor', exact: true }).click();
  assert.equal(await page.getByLabel('Message introduction').inputValue(), 'Take a moment to review your ticket basket whenever you like.');
  await page.getByLabel('Message introduction').fill('Please revisit your ticket basket at your convenience.');
  await page.getByRole('button', { name: 'Save new draft', exact: true }).click();
  await page.getByRole('button', { name: 'Approve revision 2', exact: false }).waitFor();
  const copyAfterSave = await (await context.request.get(`${base}/api/inbox?scenario=grouped`)).json();
  assert.equal(copyFan(copyAfterSave).reviewStatus, 'draft'); assert.equal(copyFan(copyAfterSave).approvedRevisionId, null);
  assert.equal(copyAfterSave.copyProvenance.find(p => p.revisionId === copyFan(copyAfterSave).revisionId).source, 'marketer_edited');
  // Prove a subsequent wording change invalidates an existing queued approval.
  await page.getByRole('button', { name: 'Approve revision 2', exact: false }).click();
  await page.getByRole('button', { name: 'Edit & create new draft', exact: true }).click();
  await page.getByLabel('Email subject').fill('An invitation to review your basket');
  await page.getByRole('button', { name: 'Save new draft', exact: true }).click();
  await page.getByRole('button', { name: 'Approve revision 3', exact: false }).waitFor();
  const copyRevised = await (await context.request.get(`${base}/api/inbox?scenario=grouped`)).json();
  assert.equal(copyFan(copyRevised).reviewStatus, 'draft'); assert.equal(copyRevised.dispatches.find(j => j.subjectKey === 'fan:SYN-F-003').state, 'blocked');
  await page.screenshot({ path: resolve('artifacts/browser/copy-saved-fresh-approval.png'), fullPage: true });
  results.push('Copy drafting TEST FIXTURE: request/inspect/discard preserved edits and revision; request/use/edit/save created a draft; later wording edit invalidated queued approval. No live model-quality claim from browser fixtures.');

  await page.setViewportSize({ width: 390, height: 844 });
  await closeIndividual(page);
  await page.getByRole('button', { name: 'Review SYN-F-003', exact: true }).click();
  assert.equal(await page.getByRole('dialog').evaluate(e => e.getBoundingClientRect().width <= window.innerWidth), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: resolve('artifacts/browser/mobile-layout.png'), fullPage: true });
  assert.deepEqual(pageErrors, []);
  results.push('390px responsive layout has no document overflow; no browser page errors observed.');
  const report = { passed: true, databasePath: dbPath, viewport: '1440x1000 desktop / 390x844 mobile', browser: browser.version(), results };
  results.push('Read-only local basket previews: F-511/F-092 exact revision/cart/basket, Enter/Space activation, Escape/Back focus restoration, edits preserved, one dialog, no mutation requests or persisted state changes. Server HTML and extension-free Chrome html lack data-scribe-recorder-ready; no page errors.');
  writeFileSync(resolve('artifacts/browser/results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (browserPage && !browserPage.isClosed()) {
    await browserPage.screenshot({ path: resolve('artifacts/browser/failure.png'), fullPage: true }).catch(() => {});
    logs += `\nPAGE: ${await browserPage.locator('body').innerText().catch(() => '')}`;
  }
  writeFileSync(resolve('artifacts/browser/failure.log'), `${error.stack ?? error}\n\n${logs}`);
  throw error;
} finally {
  await browser?.close();
  server.kill();
  await serverExit;
}
