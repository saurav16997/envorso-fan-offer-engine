import { withDemoStore } from '../src/review/server.js';
import { scenarioId } from '../src/review/scenarios.js';
import InboxApp from '../ui/InboxApp.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<{ scenario?: string }> }) {
  const query = await searchParams;
  let id;
  try { id = scenarioId(query.scenario ?? 'original'); } catch { id = 'original' as const; }
  return <InboxApp initial={withDemoStore(store => store.inbox(id))} />;
}
