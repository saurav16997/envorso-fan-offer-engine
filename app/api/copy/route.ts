import { withDemoStoreAsync } from '../../../src/review/server.js';
import { validLocalOrigin } from '../../../src/review/origin.js';
import { ReviewError } from '../../../src/review/types.js';
import { scenarioId } from '../../../src/review/scenarios.js';
import { LIMITS } from '../../../src/copy/policy.js';

export const runtime = 'nodejs';
export async function POST(request: Request): Promise<Response> {
  if (!validLocalOrigin(request.headers.get('origin'), request.headers.get('host'))) return Response.json({ error: 'Drafting requires the same local origin.' }, { status: 403 });
  if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'JSON is required.' }, { status: 415 });
  try {
    const reader = request.body?.getReader(); if (!reader) throw new ReviewError(422, 'Draft selection is required.');
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > LIMITS.requestBytes) { await reader.cancel(); throw new ReviewError(413, 'Draft request is too large.'); }
      chunks.push(chunk.value);
    } } finally { reader.releaseLock(); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReviewError(422, 'Draft selection is required.');
    const r = value as Record<string, unknown>;
    if (Object.keys(r).sort().join(',') !== 'channel,generation,offer,scenario,selection' ||
        typeof r.generation !== 'string' || r.generation.length > 80 || (r.channel !== 'email' && r.channel !== 'push') ||
        (r.offer !== 'reminder' && r.offer !== 'promo') || !r.selection || typeof r.selection !== 'object' || Array.isArray(r.selection)) throw new ReviewError(422, 'Only the current draft selection, channel and offer category are accepted.');
    const s = r.selection as Record<string, unknown>;
    if (Object.keys(s).sort().join(',') !== 'expectedVersion,revisionId' || typeof s.revisionId !== 'string' || s.revisionId.length > 80 || !Number.isSafeInteger(s.expectedVersion)) throw new ReviewError(422, 'Exact revision selection is required.');
    const result = await withDemoStoreAsync(store => store.suggest(scenarioId(r.scenario), r.generation as string,
      { revisionId: s.revisionId as string, expectedVersion: s.expectedVersion as number }, r.channel as 'email' | 'push', r.offer as 'reminder' | 'promo'));
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    // Never serialize SDK errors, response bodies, credentials or input text.
    return Response.json({ error: error instanceof ReviewError ? error.message : 'Drafting could not complete. Your wording is unchanged.' },
      { status: error instanceof ReviewError ? error.status : 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
