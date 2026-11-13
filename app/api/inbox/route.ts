import { withDemoStore } from '../../../src/review/server.js';
import { scenarioId } from '../../../src/review/scenarios.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request): Promise<Response> {
  try {
    const id = scenarioId(new URL(request.url).searchParams.get('scenario') ?? 'original');
    return Response.json(withDemoStore(store => store.inbox(id)), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to load the local inbox.' }, { status: 500 });
  }
}
