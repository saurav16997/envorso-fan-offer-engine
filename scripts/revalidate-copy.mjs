import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateWording, VALIDATOR_VERSION } from '../dist/src/copy/policy.js';
const raw = readFileSync('docs/evaluation/copy-results.json');
const historical = JSON.parse(raw);
const results = historical.results.map(c => { try { return { id: c.id, originalOutcome: c.outcome, outcome: 'accepted', wording: validateWording(c.rawWording, c.channel) }; }
  catch { return { id: c.id, originalOutcome: c.outcome, outcome: 'rejected' }; } });
writeFileSync('docs/evaluation/copy-revalidation-v2.json', JSON.stringify({ mode: 'offline_revalidation_no_calls', validatorVersion: VALIDATOR_VERSION,
  sourceSha256: createHash('sha256').update(raw).digest('hex'), originalModel: historical.model, results }, null, 2));
console.log(JSON.stringify({ validatorVersion: VALIDATOR_VERSION, accepted: results.filter(r => r.outcome === 'accepted').length, total: results.length, liveCalls: 0 }));
