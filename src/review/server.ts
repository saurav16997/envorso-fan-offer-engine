import { databasePath } from './database.js';
import { CopyStore } from '../copy/store.js';
import { DEMO_CONTEXT, scenarioInput } from './scenarios.js';
import { ONBOARDING } from '../fixtures/scenarios.js';
import type { ScenarioId } from './types.js';

/** Server-owned context. No request field or cookie can select an actor or tenant. Not production authentication. */
function demoStore(): CopyStore {
  const store = new CopyStore(databasePath(), DEMO_CONTEXT);
  try {
    for (const id of ['original', 'grouped', 'promo'] as const) store.seed(id, scenarioInput(id));
    // Preserve the full eight-cart sample in storage, without exposing another tenant through the Seawolves inbox.
    const other = new CopyStore(databasePath(), { tenantId: ONBOARDING, actorId: 'demo:fixture-loader' });
    try { other.seed('original', scenarioInput('original')); } finally { other.close(); }
    return store;
  } catch (error) { store.close(); throw error; }
}
export function withDemoStore<T>(run: (store: CopyStore) => T): T {
  const store = demoStore(); try { return run(store); } finally { store.close(); }
}
export async function withDemoStoreAsync<T>(run: (store: CopyStore) => Promise<T>): Promise<T> {
  const store = demoStore(); try { return await run(store); } finally { store.close(); }
}
export const seedDemo = (): void => { withDemoStore(() => undefined); };
export function resetDemo(id: ScenarioId, confirmation: string): void {
  withDemoStore(store => store.reset(id, confirmation, scenarioInput(id)));
}
