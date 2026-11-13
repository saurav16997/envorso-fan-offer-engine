import { ReviewError } from './types.js';
import type { Edit, Selection } from './types.js';
import type { ReviewStore } from './store.js';
import { scenarioId, scenarioInput } from './scenarios.js';
import { OutcomeStore } from '../outcome/store.js';
import type { RedemptionRequest } from '../outcome/types.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReviewError(422, 'Expected a review object.');
  return value as Record<string, unknown>;
}
function keys(row: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(row).some(key => !expected.includes(key))) throw new ReviewError(422, 'Unsupported request field. Actor, tenant, message facts and prices are owned by the server.');
}
function selection(value: unknown): Selection {
  const row = object(value); keys(row, ['revisionId', 'expectedVersion']);
  if (typeof row.revisionId !== 'string' || !row.revisionId.trim() || typeof row.expectedVersion !== 'number' ||
      !Number.isSafeInteger(row.expectedVersion) || row.expectedVersion < 1) throw new ReviewError(422, 'Select an exact revision and expected version.');
  return { revisionId: row.revisionId, expectedVersion: row.expectedVersion };
}
export function executeReview(store: ReviewStore, value: unknown): { message: string; inbox: ReturnType<ReviewStore['inbox']> } {
  const row = object(value);
  let id;
  try { id = scenarioId(row.scenario); } catch { throw new ReviewError(422, 'Choose an existing demo scenario.'); }
  if (typeof row.generation !== 'string' || !row.generation) throw new ReviewError(422, 'The current scenario generation is required.');
  const common = ['action', 'scenario', 'generation'];
  const outcomes = (): OutcomeStore => {
    if (!(store instanceof OutcomeStore)) throw new ReviewError(422, 'This store does not support outcome simulations.');
    return store;
  };
  let message: string;
  switch (row.action) {
    case 'simulator-mode':
      keys(row, [...common, 'mode']); outcomes().setSimulator(id, row.generation, row.mode);
      message = 'Simulator outcome configured only for this clearly labeled scenario. No request was submitted.'; break;
    case 'dispatch': {
      keys(row, [...common, 'dispatchId', 'revisionId']);
      if (row.dispatchId !== undefined && (typeof row.dispatchId !== 'string' || typeof row.revisionId !== 'string')) throw new ReviewError(422, 'Choose an exact queued request and approved revision.');
      const attempted = outcomes().runQueued(id, row.generation, row.dispatchId as string | undefined, row.revisionId as string | undefined);
      message = `${attempted} simulated provider ${attempted === 1 ? 'attempt' : 'attempts'} completed. Inspect delivery activity; acceptance does not confirm fan delivery.`; break;
    }
    case 'reconcile':
      keys(row, [...common, 'dispatchId']);
      if (typeof row.dispatchId !== 'string') throw new ReviewError(422, 'Choose an uncertain request.');
      message = outcomes().reconcile(id, row.generation, row.dispatchId).explanation; break;
    case 'recover-claims':
      keys(row, common); message = `${outcomes().recoverClaims(id, row.generation)} abandoned claims moved to unknown. No requests were retried.`; break;
    case 'retry-definite':
      keys(row, [...common, 'dispatchId']);
      if (typeof row.dispatchId !== 'string') throw new ReviewError(422, 'Choose a definitely failed request.');
      outcomes().retryDefiniteFailure(id, row.generation, row.dispatchId);
      message = 'One explicit bounded retry queued with the same request/key. Unknown outcomes cannot use this action.'; break;
    case 'advance-clock':
      keys(row, [...common, 'minutes']);
      if (typeof row.minutes !== 'number') throw new ReviewError(422, 'Supply a positive demo-clock advance.');
      outcomes().advanceClock(id, row.generation, row.minutes);
      message = 'Advanced the injected scenario clock without refreshing any evidence timestamps.'; break;
    case 'redeem': {
      keys(row, [...common, 'checkout']); const checkout = object(row.checkout);
      keys(checkout, ['code', 'subjectKey', 'matchId', 'section', 'seats', 'eligibleSubtotalCents']);
      const purchase = outcomes().redeem(id, row.generation, checkout as unknown as RedemptionRequest);
      message = `Simulated checkout consumed ${purchase.code} once and recorded one simulated purchase. No real payment, delivery or incremental revenue is claimed.`; break;
    }
    case 'approve': {
      keys(row, [...common, 'selection']);
      const result = store.approve(id, row.generation, [selection(row.selection)]);
      message = result.approved ? 'Approved this exact revision — awaiting dispatch. Nothing was sent.' : 'This exact revision was already approved. No duplicate decision was created.';
      break;
    }
    case 'batch': {
      keys(row, [...common, 'selections']);
      if (!Array.isArray(row.selections)) throw new ReviewError(422, 'Explicit revision selections are required.');
      const result = store.approve(id, row.generation, row.selections.map(selection), true);
      message = `${result.approved} reminders approved; ${result.alreadyApproved} already approved. Each exact revision is awaiting dispatch. Nothing was sent.`;
      break;
    }
    case 'edit': {
      keys(row, [...common, 'selection', 'edit']);
      const edit = object(row.edit); keys(edit, ['channel', 'offer', 'percent', 'introduction', 'subject', 'suggestionId']);
      store.edit(id, row.generation, selection(row.selection), edit as unknown as Edit);
      message = 'Saved a new draft revision. Review its full preview before approving; earlier approval does not apply.';
      break;
    }
    case 'reject':
      keys(row, [...common, 'selection', 'reason']);
      if (row.reason !== null && typeof row.reason !== 'string') throw new ReviewError(422, 'Use an optional structured rejection reason.');
      store.reject(id, row.generation, selection(row.selection), row.reason);
      message = 'Opportunity rejected and closed. Processing or restarting will not reopen it.';
      break;
    case 'process':
      keys(row, common);
      if (store.inbox(id).generation !== row.generation) throw new ReviewError(409, 'This scenario was reset. Reload before processing.');
      message = 'Reprocessed current evidence. Unchanged revisions and review decisions were preserved.';
      break;
    case 'demo-change':
      keys(row, [...common, 'selection', 'change']);
      if (row.change !== 'purchase' && row.change !== 'revoke_consent') throw new ReviewError(422, 'Choose a supported synthetic evidence change.');
      store.simulateChange(id, row.generation, selection(row.selection), row.change);
      message = 'Synthetic evidence changed. Eligibility was rechecked and affected approval invalidated. No real fan record was changed.';
      break;
    case 'reset':
      keys(row, [...common, 'confirmation']);
      if (store.inbox(id).generation !== row.generation) throw new ReviewError(409, 'This scenario was already reset. Reload.');
      if (typeof row.confirmation !== 'string') throw new ReviewError(422, 'Explicit reset confirmation is required.');
      store.reset(id, row.confirmation, scenarioInput(id), row.generation);
      message = 'This scenario was explicitly reset. Its previous review history was deleted; other scenarios were preserved.';
      break;
    default: throw new ReviewError(422, 'Unknown review action.');
  }
  return { message, inbox: store.inbox(id) };
}
