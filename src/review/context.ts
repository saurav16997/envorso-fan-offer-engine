import type { Inbox, ReviewItem } from './types.js';

export interface ContextSummary { happened: string; why: string; next: string; owner: string; transition: string; remaining: string[]; receiptId: string | null }
const at = (s: string) => `${new Date(s).toISOString().slice(0, 16).replace('T', ' ')} UTC (scenario clock)`;
const requirements: Record<string, string> = {
  MATCH_EVIDENCE_STALE: 'Fresh match and inventory evidence is required.', MATCH_EVIDENCE_MISSING: 'Match identity, kickoff and inventory must be supplied.',
  OPERATIONAL_EVIDENCE_MISSING: 'Current purchase, contact-history and entitlement evidence is required.',
  SCOPED_CONSENT_MISSING: 'A current scoped marketing-permission check is required; a missing or stale check does not establish opt-out.',
  CONSENT_REVOKED: 'Marketing permission is revoked; no message may use that channel.',
  ENTITLEMENT_REVIEW_REQUIRED: 'Club ticketing staff must clarify whether the basket is additional to season-pass coverage.',
  PURCHASE_STATE_UNKNOWN: 'A current purchase check must establish whether the fan already bought.', CONTACT_HISTORY_UNKNOWN: 'Complete recovery and other engine-contact history is required.',
  INVENTORY_UNAVAILABLE: 'Sufficient inventory for the recorded sections and quantities must be established.', QUIET_HOURS: 'The recipient’s local sending window must open.',
  TIME_ZONE_UNKNOWN: 'A valid recipient time zone is required.', DESTINATION_UNAVAILABLE: 'A usable destination must be supplied.',
  DESTINATION_INVALID: 'The destination must be corrected and verified.', DESTINATION_REVOKED: 'The destination is revoked and cannot be used.',
  DESTINATION_OWNER_UNVERIFIED: 'Ownership of the destination must be verified.'
};
/** Presentation only. Engine decisions, persisted review and provider evidence remain authoritative. */
export function opportunityContext(item: ReviewItem, inbox: Pick<Inbox, 'evaluationAt' | 'dispatches'>): ContextSummary {
  const o = item.payload.opportunity;
  const cart = o.sourceCarts.find(c => c.source.cartId === o.canonicalCartId)!;
  const hours = Math.floor((Date.parse(inbox.evaluationAt) - Date.parse(o.latestActivityAt)) / 3_600_000);
  const codes = new Set([...o.reasons, ...o.delivery.blockers].map(r => r.code));
  const job = inbox.dispatches?.find(j => j.subjectKey === o.subjectKey && j.matchId === o.matchId);
  const remaining = [...new Set(o.delivery.blockers.filter(b => b.code !== 'BUSINESS_DECISION_BLOCKS_CONTACT').map(b => requirements[b.code] ?? 'Additional verified operational evidence is required; inspect technical evidence.'))];
  const base: ContextSummary = { happened: `${cart.source.seats} ${cart.source.seats === 1 ? 'ticket' : 'tickets'} in ${cart.source.section}, observed ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cart.cartValueCents / 100)}. Latest recorded basket activity ${hours}h ago on the scenario clock; ${o.sourceCartIds.length} source ${o.sourceCartIds.length === 1 ? 'basket' : 'baskets'} retained.`,
    why: '', next: '', owner: '', transition: '', remaining, receiptId: job?.id ?? null };
  const result = (why: string, next: string, owner: string, transition: string, closed = false): ContextSummary => ({ ...base, why, next, owner, transition, remaining: closed ? [] : remaining.filter(r => !why.includes(r)) });
  if (job?.state === 'accepted' || codes.has('RECOVERY_ALREADY_CONTACTED')) return result('Recovery contact already recorded; no further recovery message for this match', 'No further marketer action is needed. Inspect the existing receipt; provider acceptance does not confirm delivery.', 'System contact history', 'This recovery stays closed. Later data changes cannot recall an already accepted message.', true);
  if (job?.state === 'unknown' || job?.state === 'in_progress' || codes.has('CONTACT_PENDING_OR_UNKNOWN')) return result('A delivery request is in progress or its outcome is uncertain.', 'Investigate/reconcile using provider evidence. Do not retry or switch channel while acceptance is uncertain.', 'Delivery operator / provider evidence', 'Established provider evidence must resolve the outcome; without it, contact suppression remains.');
  if (item.reviewStatus === 'rejected') return result('A marketer rejected this opportunity.', 'No marketer action is currently needed.', 'Recorded review decision', 'Reprocessing does not reopen the rejected opportunity.', true);
  if (job?.state === 'failed') return result('The provider definitely rejected the request before acceptance.', job.canRetry ? 'A delivery operator may queue the bounded definite-failure retry after inspecting the receipt.' : 'The submission limit is exhausted. Investigate; do not submit again.', 'Delivery operator', 'Any permitted retry keeps the same request key and must pass fresh checks.');
  if (job?.state === 'blocked' && item.reviewStatus === 'approved' && o.delivery.readiness === 'checks_satisfied') return result('The approved request stopped before sending.', 'Inspect the existing receipt for the stopping condition; do not assume approval authorizes another attempt.', 'Delivery operator', 'The stopping condition and all current eligibility checks must be resolved within the existing dispatch limits.');
  if (codes.has('ALREADY_PURCHASED')) return result('A relevant purchase is already recorded.', 'No recovery message is needed.', 'System purchase history', 'Recovery for this recorded purchase stays excluded.', true);
  if (codes.has('MATCH_NOT_UPCOMING') || codes.has('RECOVERY_EXPIRED') || codes.has('CART_ENTITLEMENT_CONFIRMED')) return result(codes.has('MATCH_NOT_UPCOMING') ? 'The match has been played or is no longer scheduled.' : codes.has('CART_ENTITLEMENT_CONFIRMED') ? 'Verified pass coverage already covers this basket.' : 'The recovery window has ended.', 'No marketer action is currently needed.', 'Match/ticketing records and timing policy', 'This opportunity is excluded under the current verified records and timing rules.', true);
  if (codes.has('ENTITLEMENT_UNCERTAIN')) {
    if (o.nextEligibleAt) base.remaining.push(`Minimum waiting period ends ${at(o.nextEligibleAt)}; fresh checks are still required.`);
    return result(`Are these ${cart.source.seats} tickets additional to the fan’s season-pass coverage? This is unresolved, so the opportunity needs attention.`, 'Ask club ticketing staff to clarify coverage. No task has been assigned or notification sent.', 'Club ticketing staff', 'Verified additional-seat coverage, the waiting period and every remaining eligibility/permission check must pass before marketer review.');
  }
  if (codes.has('MINIMUM_WAIT') || codes.has('CLUB_CONTACT_COOLDOWN')) return result(o.nextEligibleAt ? `Waiting until ${at(o.nextEligibleAt)} for ${codes.has('MINIMUM_WAIT') ? 'the minimum wait' : 'the contact cooldown'}.` : 'Waiting under the contact/timing policy.', 'No marketer action is currently needed. Recheck at the earliest eligibility time.', 'Scenario timing policy; system/data operator for fresh evidence', 'Reaching that time only permits reevaluation; fresh permission, purchase, inventory and all other checks must still pass.');
  if (o.delivery.blockers.length && o.delivery.blockers.every(b => b.code === 'QUIET_HOURS')) return result('The recipient’s local sending window is closed.', 'No marketer action is currently needed. Recheck in the next local sending window.', 'Recipient-local timing policy', 'The window must open and all evidence must still be current.');
  if (o.delivery.readiness === 'blocked' || o.status !== 'recommend') {
    const expired = codes.has('MATCH_EVIDENCE_STALE') || codes.has('OPERATIONAL_EVIDENCE_MISSING');
    return result(expired ? 'Reminder paused because operational evidence expired or is missing.' : codes.has('CONSENT_REVOKED') ? 'Marketing permission is revoked for the proposed channel.' : 'Current evidence does not establish permission or eligibility to contact this fan.',
      'Do not approve or send. A system/data operator must resolve the listed evidence gaps. The prototype has no live refresh integration.', 'System/data operator' , 'Verified current records must satisfy all remaining requirements; reprocessing only rechecks existing records, then a fresh eligible proposal may be reviewed.');
  }
  if (item.reviewStatus === 'approved') return result('This exact proposal is approved and awaiting dispatch.', 'No further approval is needed. An explicit demo worker run can attempt delivery after fresh checks.', 'Demo delivery operator / system checks', 'All pre-send checks must still pass. Approval is not sending; changed wording or facts require fresh review.');
  return result('Current snapshot checks allow this proposal to enter marketer review.', 'Inspect the exact proposal, then approve, edit or reject it.', 'Marketer', 'Approval queues only this exact revision. Dispatch must still recheck current permission and eligibility.');
}
