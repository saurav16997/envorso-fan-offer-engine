import { parentPort, workerData } from 'node:worker_threads';
import { ReviewStore } from '../../src/review/store.js';
import { DEMO_CONTEXT } from '../../src/review/scenarios.js';
import type { ScenarioId, Selection } from '../../src/review/types.js';

const data = workerData as { path: string; scenario: ScenarioId; generation: string; selection: Selection; gate: SharedArrayBuffer };
const store = new ReviewStore(data.path, DEMO_CONTEXT);
const gate = new Int32Array(data.gate);
parentPort!.postMessage('ready');
Atomics.wait(gate, 0, 0, 10_000);
try { parentPort!.postMessage({ result: store.approve(data.scenario, data.generation, [data.selection]) }); }
catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
finally { store.close(); }
