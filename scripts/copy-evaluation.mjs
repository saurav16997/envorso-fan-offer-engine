import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { copyCases } from '../dist/src/copy/evaluation.js';
import { copyConfig } from '../dist/src/copy/provider.js';
import { LIMITS, PROMPT_VERSION, validateWording } from '../dist/src/copy/policy.js';

// Exactly one call per case, sequential, no retries or hidden model judging. Explicit --live required.
const live = process.argv.includes('--live');
const reportPath = resolve(`docs/evaluation/${live ? 'copy-results' : 'copy-offline'}.json`);
if (live && existsSync(reportPath) && !process.argv.includes('--overwrite')) {
  console.log('Existing live evidence preserved. An intentional new paid run requires --overwrite.'); process.exit(1);
}
const config = copyConfig({ ...process.env, COPY_DRAFT_ENABLED: live ? 'true' : 'false', COPY_DRAFT_PROVIDER: 'openai' });
const results = [];
for (const c of copyCases) {
  let outcome = 'not_run'; let wording = null; let rawWording = null; let elapsedMs = null;
  if (live && config.enabled && config.generate) {
    const started = performance.now(); const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIMITS.timeoutMs);
    try {
      const result = await config.generate(c.context, controller.signal); outcome = result.state;
      if (result.state === 'suggested') {
        // Only synthetically generated text is recorded, bounded and excluding errors/refusals/provider bodies.
        rawWording = result.value && typeof result.value === 'object' ? {
          subject: typeof result.value.subject === 'string' ? result.value.subject.slice(0, 100) : null,
          introduction: typeof result.value.introduction === 'string' ? result.value.introduction.slice(0, 400) : null } : null;
        try { wording = validateWording(result.value, c.context.channel); }
        catch { outcome = 'invalid'; }
      }
    } catch { outcome = controller.signal.aborted ? 'timeout' : 'api_error'; }
    finally { clearTimeout(timeout); elapsedMs = Math.round(performance.now() - started); }
  } else if (live) outcome = 'unavailable';
  results.push({ ...c, outcome, wording, rawWording, elapsedMs, automatedCheck: wording ? 'Passed practical checks; human factual/tone review still required' : 'No usable validated live wording' });
  console.log(`${c.id}: ${outcome}`);
}
mkdirSync(resolve('docs/evaluation'), { recursive: true });
const report = { accessedAt: new Date().toISOString(), mode: live ? 'authorized_live' : 'offline_no_generation', model: config.model, promptVersion: PROMPT_VERSION,
  attemptedCalls: live && config.enabled ? copyCases.length : 0, results };
writeFileSync(reportPath, JSON.stringify(report, null, 2));
const safe = x => String(x ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const sheet = ['# Personal copy review sheet', '', `Run: ${report.mode}; model: ${config.model}; prompt: ${PROMPT_VERSION}; ${report.accessedAt}.`, '',
  'All examples are synthetic. API latency is not marketer time saved. No user ratings, edits or time savings have been filled in. Mock tests are not model-quality evidence.', '',
  'For each example, compare the baseline and live wording against the truth below. Score unsupported claims, consistency with locked terms, channel fit/length, next action and low-pressure tone. Record your own edits and elapsed review/edit time. Choose template / generated / neither.', ''];
for (const r of results) sheet.push(`## ${r.label}`, '', `Synthetic truth: ${r.truth}`, '',
  `Context sent: ${JSON.stringify(r.context)}`, '', `Outcome: **${r.outcome}**${r.elapsedMs === null ? '' : `; API elapsed ${r.elapsedMs} ms`}.`, '',
  '| Field | Deterministic baseline | Live candidate |', '| --- | --- | --- |',
  `| Subject | ${safe(r.baseline.subject)} | ${safe(r.rawWording?.subject ?? 'No live candidate')} |`,
  `| Opening | ${safe(r.baseline.introduction)} | ${safe(r.rawWording?.introduction ?? 'No live candidate')} |`, '',
  `${r.automatedCheck}. A rejected raw candidate above is **not usable in the app**. Locked facts/CTA/terms are rendered separately; the model does not receive them.`, '',
  'Your choice: _____  Unsupported claims: _____  Terms consistency: _____  Channel/length: _____  Next action: _____  Tone: _____', '',
  'Your edits: _____  Review/edit time: _____  Notes: _____', '');
writeFileSync(resolve(`docs/evaluation/${live ? 'COPY_REVIEW_SHEET' : 'COPY_REVIEW_SHEET_OFFLINE'}.md`), sheet.join('\n'));
console.log('Wrote bounded synthetic results and blank personal review sheet. No provider errors or credentials were logged.');
