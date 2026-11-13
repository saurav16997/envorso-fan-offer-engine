import { databasePath, openDatabase } from './database.js';
import { resetDemo, seedDemo } from './server.js';
import { scenarioId } from './scenarios.js';

const [command, ...args] = process.argv.slice(2);
if (command === 'migrate') { const db = openDatabase(databasePath()); db.close(); console.log(`Migrations applied: ${databasePath()}`); }
else if (command === 'seed') { seedDemo(); console.log(`Missing demo scenarios seeded; existing decisions preserved: ${databasePath()}`); }
else if (command === 'reset') {
  const option = (name: string): string | undefined => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const id = scenarioId(option('--scenario'));
  const confirmation = option('--confirm');
  if (!confirmation) throw new Error(`Explicit confirmation required: --confirm "RESET ${id}"`);
  resetDemo(id, confirmation);
  console.log(`Reset only ${id} for the fixed Seawolves tenant: ${databasePath()}`);
} else throw new Error('Use migrate, seed, or reset --scenario <original|grouped|promo> --confirm "RESET <scenario>"');
