import { parentPort, workerData } from 'node:worker_threads';
import { OutcomeStore } from '../../src/outcome/store.js';
import { DEMO_CONTEXT } from '../../src/review/scenarios.js';
import type { RedemptionRequest } from '../../src/outcome/types.js';
import type { ScenarioId } from '../../src/review/types.js';

const data = workerData as { path: string; scenario: ScenarioId; generation: string; action: 'dispatch' | 'redeem'; request?: RedemptionRequest; gate: SharedArrayBuffer };
const store = new OutcomeStore(data.path, DEMO_CONTEXT);
parentPort!.postMessage('ready');
Atomics.wait(new Int32Array(data.gate), 0, 0, 10_000);
try {
  const value = data.action === 'dispatch' ? store.runQueued(data.scenario, data.generation) : store.redeem(data.scenario, data.generation, data.request!);
  parentPort!.postMessage({ ok: true, value });
} catch (error) { parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
finally { store.close(); }
