import { executeReview } from '../../../src/review/commands.js';
import { withDemoStore } from '../../../src/review/server.js';
import { ReviewError } from '../../../src/review/types.js';
import { validLocalOrigin } from '../../../src/review/origin.js';

export const runtime = 'nodejs';
export async function POST(request: Request): Promise<Response> {
  if (!validLocalOrigin(request.headers.get('origin'), request.headers.get('host'))) return Response.json({ error: 'Review actions require the same local origin.' }, { status: 403 });
  if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'JSON review commands are required.' }, { status: 415 });
  try {
    const raw: unknown = await request.json();
    const result = withDemoStore(store => executeReview(store, raw));
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Review failed.', issues: error instanceof ReviewError ? error.issues : [] },
      { status: error instanceof ReviewError ? error.status : 500 });
  }
}
