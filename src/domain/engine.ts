import { HOUR_MS, quoteDiscount, timestamp } from './policy.js';
import { assertInputShape } from './validation.js';
import type {
  Action, Cart, Channel, EvaluationInput, Explanation, Exposure, FreshEvidence,
  OperationalEvidence, Opportunity, Policy,
} from './types.js';

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const tuple = (...parts: string[]): string => JSON.stringify(parts);
const note = (code: string, message: string): Explanation => ({ code, message });

function resolve(cart: Cart, ambiguousContacts: ReadonlySet<string>): { subjectKey: string; ambiguous: boolean } {
  if (cart.identity.kind === 'fan') return { subjectKey: `fan:${cart.identity.fanId}`, ambiguous: false };
  const candidates = [...new Set(cart.identity.associatedFanIds)];
  if (candidates.length === 1 && cart.identity.provenance?.trim() &&
      !ambiguousContacts.has(tuple(cart.tenantId, cart.identity.contactId))) {
    return { subjectKey: `fan:${candidates[0]!}`, ambiguous: false };
  }
  return { subjectKey: `guest:${cart.identity.contactId}`, ambiguous: true };
}

function fresh(record: FreshEvidence, now: number, policy: Policy): boolean {
  const checked = timestamp(record.checkedAt);
  return checked <= now && now - checked <= policy.evidenceMaxAgeHours * HOUR_MS &&
    timestamp(record.validUntil) > now;
}

function unique<T>(items: readonly T[], key: (item: T) => string, label: string): void {
  const keys = items.map(key);
  if (new Set(keys).size !== keys.length) throw new Error(`Duplicate ${label}; reconcile before evaluation`);
}

function validateInput(input: EvaluationInput, now: number): void {
  unique(input.carts, c => tuple(c.tenantId, c.source.cartId), 'tenant/cart');
  const e = input.evidence;
  unique(e.tenants, x => x.tenantId, 'tenant configuration');
  unique(e.matches, x => tuple(x.tenantId, x.matchId), 'match evidence');
  unique(e.opportunities, x => tuple(x.tenantId, x.subjectKey, x.matchId), 'opportunity evidence');
  unique(e.destinations, x => tuple(x.tenantId, x.subjectKey, x.channel), 'destination');
  unique(e.commercial, x => tuple(x.tenantId, x.subjectKey, x.matchId, x.cartId), 'commercial evidence');
  for (const cart of input.carts) {
    if (timestamp(cart.lastActivityAt) > now) throw new Error('Cart activity is in the future');
  }
  for (const record of [...e.matches, ...e.opportunities, ...e.commercial, ...e.consents]) {
    if (timestamp(record.checkedAt) > now) throw new Error('Evidence check timestamp is in the future');
  }
  for (const contact of e.contacts) {
    if (timestamp(contact.at) > now) throw new Error('Contact timestamp is in the future');
  }
}

function channelChecks(e: OperationalEvidence, tenantId: string, subjectKey: string,
  channel: Channel, now: number, policy: Policy): Explanation[] {
  const blockers: Explanation[] = [];
  const destination = e.destinations.find(x => x.tenantId === tenantId && x.subjectKey === subjectKey && x.channel === channel);
  const syntacticallyUsable = destination && (channel === 'email'
    ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination.value) : destination.value.trim().length > 0);
  if (!destination) {
    blockers.push(note('DESTINATION_UNAVAILABLE', `No ${channel} destination is recorded.`));
  } else {
    if (!syntacticallyUsable || destination.status === 'invalid') {
      blockers.push(note('DESTINATION_INVALID', `The ${channel} destination is invalid or reported unusable.`));
    }
    if (destination.status === 'revoked') blockers.push(note('DESTINATION_REVOKED', `The ${channel} destination has been revoked.`));
    if (!destination.verifiedOwner) blockers.push(note('DESTINATION_OWNER_UNVERIFIED', `Ownership of the ${channel} destination is not verified.`));
  }
  const consents = e.consents.filter(x => x.tenantId === tenantId && x.subjectKey === subjectKey &&
    x.channel === channel && x.purpose === 'marketing');
  const latestEffectiveAt = consents.reduce((latest, c) => Math.max(latest, timestamp(c.effectiveAt)), -Infinity);
  const latestConsents = consents.filter(c => timestamp(c.effectiveAt) === latestEffectiveAt);
  // Conflicting records at the same instant must fail closed regardless of array order.
  if (latestConsents.length === 0 || latestConsents.some(c => !c.provenance.trim() || !fresh(c, now, policy))) {
    blockers.push(note('SCOPED_CONSENT_MISSING', `Current tenant/subject/${channel}/marketing consent with provenance is required.`));
  } else if (latestConsents.some(c => c.status === 'revoked')) {
    blockers.push(note('CONSENT_REVOKED', `${channel} marketing consent has been revoked.`));
  }
  return blockers;
}

function evaluateGroup(carts: readonly Cart[], input: EvaluationInput, now: number,
  ambiguousContacts: ReadonlySet<string>, affectedAccounts: ReadonlySet<string>): Opportunity {
  const { policy, evidence: e } = input;
  const sorted = [...carts].sort((a, b) => compare(a.source.cartId, b.source.cartId));
  const canonical = [...sorted].sort((a, b) => timestamp(b.lastActivityAt) - timestamp(a.lastActivityAt) ||
    compare(a.source.cartId, b.source.cartId))[0]!;
  const { tenantId, matchId } = canonical;
  const identity = resolve(canonical, ambiguousContacts);
  const { subjectKey } = identity;
  const scoped = <T extends { tenantId: string; subjectKey: string }>(x: T): boolean =>
    x.tenantId === tenantId && x.subjectKey === subjectKey;
  const opportunityEvidence = e.opportunities.find(x => scoped(x) && x.matchId === matchId);
  const match = e.matches.find(x => x.tenantId === tenantId && x.matchId === matchId);
  const contacts = e.contacts.filter(scoped);
  const age = now - timestamp(canonical.lastActivityAt);
  const minimumAt = timestamp(canonical.lastActivityAt) + policy.minimumWaitHours * HOUR_MS;
  const reasons: Explanation[] = [];
  const missing = new Set<string>();
  const blockers: Explanation[] = [];
  const block = (code: string, message: string): void => { blockers.push(note(code, message)); };
  if (sorted.length > 1) reasons.push(note('CARTS_COALESCED', 'All source carts are retained; the latest activity restarts the waiting period.'));
  if (sorted.some(x => x.identity.kind === 'guest') && !identity.ambiguous) {
    reasons.push(note('EXPLICIT_GUEST_ASSOCIATION', 'Guest association uses explicit tenant-scoped fixture evidence, not an email-matching rule.'));
  }
  if (sorted.some(x => typeof x.shopSpendCents !== 'number')) missing.add('shop_spend_unknown_or_not_synced');
  if (sorted.some(x => typeof x.lifetimeTickets !== 'number')) missing.add('source_lifetime_tickets_unknown');
  if (!match) { missing.add('match_catalog'); block('MATCH_EVIDENCE_MISSING', 'Exact match identity, kickoff and current inventory are required.'); }
  else if (!fresh(match, now, policy)) { missing.add('current_inventory'); block('MATCH_EVIDENCE_STALE', 'Match and inventory evidence must be refreshed.'); }
  if (match) {
    // Every retained basket must be supportable; these observations are alternatives, not additive seat demand.
    if (sorted.some(c => !Object.hasOwn(match.availableSeatsBySection, c.source.section) ||
        match.availableSeatsBySection[c.source.section]! < c.source.seats)) {
      block('INVENTORY_UNAVAILABLE', 'Available seats for every observed section/quantity are not established; adjacency is not promised.');
      missing.add('sufficient_current_inventory');
    }
  }
  const currentOps = opportunityEvidence && fresh(opportunityEvidence, now, policy);
  if (!currentOps) {
    missing.add('current_purchase_and_contact_history');
    block('OPERATIONAL_EVIDENCE_MISSING', 'Current purchase, contact-history and entitlement checks are required.');
  }
  if (!opportunityEvidence || opportunityEvidence.purchase === 'unknown') {
    missing.add('purchase_state'); block('PURCHASE_STATE_UNKNOWN', 'Absence of a subsequent relevant purchase has not been established.');
  }
  if (!opportunityEvidence?.recoveryHistoryComplete || !opportunityEvidence.clubHistoryComplete) {
    missing.add('complete_engine_contact_history'); block('CONTACT_HISTORY_UNKNOWN', 'Recovery and club-wide engine contact history must be complete.');
  }
  const passUncertain = sorted.some(c => c.source.seasonPass === 'Yes') &&
    (!currentOps || opportunityEvidence.entitlement === 'unknown');
  if (passUncertain) {
    missing.add('pass_match_section_seat_coverage');
    reasons.push(note('ENTITLEMENT_UNCERTAIN', 'Season-pass ownership does not establish coverage of every seat in this cart.'));
    block('ENTITLEMENT_REVIEW_REQUIRED', 'Check actual pass coverage before recommending contact.');
  }
  const timeZone = opportunityEvidence?.recipientTimeZone;
  if (!timeZone) { missing.add('recipient_time_zone'); block('TIME_ZONE_UNKNOWN', 'A recipient timezone or documented fallback is required.'); }
  else {
    try {
      const localHour = Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now));
      if (localHour < policy.quietHours.startHour || localHour >= policy.quietHours.endHour) {
        block('QUIET_HOURS', 'The recipient is outside the configured local send window.');
      }
    } catch { missing.add('valid_recipient_time_zone'); block('TIME_ZONE_UNKNOWN', 'The supplied timezone is invalid.'); }
  }

  // Source opt-out is conservative across all retained observations. Positive flags alone never authorize sending.
  const allowed: Channel[] = [];
  if (sorted.every(c => c.source.emailOptIn === 'Yes')) allowed.push('email');
  if (sorted.every(c => c.source.pushOptIn === 'Yes')) allowed.push('push');
  const preferred = opportunityEvidence?.preferredChannel ?? (canonical.source.source === 'App' ? 'push' : 'email');
  const orderedChannels = [...allowed].sort((a, b) => Number(b === preferred) - Number(a === preferred));
  const channel = orderedChannels.find(c => channelChecks(e, tenantId, subjectKey, c, now, policy).length === 0) ?? orderedChannels[0] ?? null;

  const finish = (status: Opportunity['status'], code: string, message: string,
    action: Action | null = null, exposure: Exposure = { kind: 'known', currency: 'USD', maximumDiscountCents: 0 },
    nextEligibleAt: string | null = null): Opportunity => {
    reasons.push(note(code, message));
    if (status !== 'recommend') block('BUSINESS_DECISION_BLOCKS_CONTACT', message);
    if (status === 'recommend' && channel) {
      const checks = channelChecks(e, tenantId, subjectKey, channel, now, policy);
      blockers.push(...checks);
      for (const check of checks) missing.add(check.code.toLowerCase());
    }
    return {
      key: tuple(tenantId, 'cart_recovery', subjectKey, matchId), tenantId, subjectKey, matchId,
      sourceCartIds: sorted.map(c => c.source.cartId), sourceCarts: sorted,
      latestActivityAt: new Date(timestamp(canonical.lastActivityAt)).toISOString(), canonicalCartId: canonical.source.cartId,
      status, proposedAction: action, proposedChannel: action ? channel : null, reasons,
      missingInformation: [...missing].sort(compare),
      delivery: { readiness: blockers.length ? 'blocked' : 'checks_satisfied', blockers },
      incentiveExposure: exposure, nextEligibleAt, policyVersion: policy.version,
    };
  };

  if (match && (match.state !== 'scheduled' || timestamp(match.kickoffAt) <= now)) {
    return finish('suppress', 'MATCH_NOT_UPCOMING', 'The match has already happened or is no longer scheduled.');
  }
  if (!e.tenants.some(x => x.tenantId === tenantId && x.active)) {
    return finish('hold', 'TENANT_NOT_ACTIVATED', 'The owning team is not activated; another tenant cannot supply its authorization.');
  }
  if (identity.ambiguous) {
    missing.add('unambiguous_identity_evidence');
    return finish('hold', 'IDENTITY_UNRESOLVED', 'Guest identity is missing, ambiguous or lacks explicit association provenance.');
  }
  if (affectedAccounts.has(tuple(tenantId, subjectKey, matchId))) {
    missing.add('unambiguous_related_guest_identity');
    return finish('hold', 'RELATED_GUEST_IDENTITY_UNRESOLVED', 'Ambiguous guest activity may belong to this account/match; resolve it before timing or contacting this account.');
  }
  if (!match) return finish('hold', 'MATCH_UNKNOWN', 'The match cannot be evaluated without its catalog entry.', null,
    { kind: 'unknown', explanation: 'No evaluable proposal exists while match evidence is missing.' });
  if (age >= policy.maximumInactivityHours * HOUR_MS ||
      now >= timestamp(match.kickoffAt) - policy.kickoffCutoffHours * HOUR_MS) {
    return finish('suppress', 'RECOVERY_EXPIRED', 'The inactivity limit or pre-kickoff recovery cutoff has been reached.');
  }
  if (opportunityEvidence?.purchase === 'purchased') return finish('suppress', 'ALREADY_PURCHASED', 'A relevant purchase is recorded; recovery contact is suppressed.');
  if (currentOps && opportunityEvidence.entitlement === 'cart_fully_covered' && sorted.some(c => c.source.seasonPass === 'Yes')) {
    return finish('suppress', 'CART_ENTITLEMENT_CONFIRMED', 'Explicit entitlement evidence establishes that this cart is fully covered.');
  }
  const sameRecovery = contacts.filter(x => x.kind === 'recovery' && x.matchId === matchId);
  if (sameRecovery.some(x => x.state === 'accepted')) return finish('suppress', 'RECOVERY_ALREADY_CONTACTED', 'One recovery contact for this fan/match is already recorded; no coupon ladder.');
  if (contacts.some(x => x.state === 'pending' || x.state === 'unknown')) return finish('hold', 'CONTACT_PENDING_OR_UNKNOWN', 'A pending or uncertain engine send must be resolved before another contact.');
  const latestContact = contacts.reduce<number | null>((latest, c) => latest === null ? timestamp(c.at) : Math.max(latest, timestamp(c.at)), null);
  if (latestContact !== null && now < latestContact + policy.contactCooldownHours * HOUR_MS) {
    const next = Math.max(minimumAt, latestContact + policy.contactCooldownHours * HOUR_MS);
    const expires = Math.min(timestamp(canonical.lastActivityAt) + policy.maximumInactivityHours * HOUR_MS,
      timestamp(match.kickoffAt) - policy.kickoffCutoffHours * HOUR_MS);
    return finish('defer', 'CLUB_CONTACT_COOLDOWN', 'The club/fan engine marketing contact cooldown is active.', null, undefined,
      next < expires ? new Date(next).toISOString() : null);
  }
  if (now < minimumAt) {
    const expires = timestamp(match.kickoffAt) - policy.kickoffCutoffHours * HOUR_MS;
    return finish('defer', 'MINIMUM_WAIT', 'Latest activity is less than the configured minimum wait ago.', null, undefined,
      minimumAt < expires ? new Date(minimumAt).toISOString() : null);
  }
  if (passUncertain) return finish('hold', 'ENTITLEMENT_REVIEW_REQUIRED', 'The wait has elapsed, but actual pass coverage remains unresolved.');
  if (!channel) return finish('hold', 'NO_OPTED_IN_CHANNEL', 'No channel is permitted by every source observation; scoped consent would also be required.');

  const firstTime = sorted.filter(c => c.identity.kind === 'fan').map(c => c.lifetimeTickets);
  const positiveHistory = sorted.some(c => typeof c.lifetimeTickets === 'number' && c.lifetimeTickets > 0);
  if (firstTime.some(count => count === 0) && positiveHistory) {
    reasons.push(note('BUYER_HISTORY_CONFLICT', 'A zero-ticket account observation conflicts with known ticket purchases in another retained observation; no first-time incentive.'));
    missing.add('authoritative_buyer_history');
  }
  const commercial = e.commercial.find(x => scoped(x) && x.matchId === matchId && x.cartId === canonical.source.cartId);
  const currentSold = sorted.map(c => Object.hasOwn(match.sectionSoldPercentBySection, c.source.section)
    ? match.sectionSoldPercentBySection[c.source.section] : undefined);
  const currentYieldAllowsPromo = currentSold.every(sold => sold !== undefined &&
    sold < policy.promoSoldBelowPercent && sold < policy.protectYieldAtPercent);
  const promoBehaviorEligible = age >= policy.promoWaitHours * HOUR_MS &&
    firstTime.length > 0 && firstTime.every(count => count === 0) && !positiveHistory &&
    sorted.every(c => c.sectionSoldPercent < policy.promoSoldBelowPercent && c.sectionSoldPercent < policy.protectYieldAtPercent) &&
    timestamp(match.kickoffAt) - now > policy.promoKickoffMoreThanHours * HOUR_MS;
  if (promoBehaviorEligible && currentYieldAllowsPromo && commercial?.approved && commercial.provenance.trim() &&
      fresh(commercial, now, policy) && fresh(match, now, policy) && currentOps &&
      opportunityEvidence.purchase === 'not_purchased' && opportunityEvidence.recoveryHistoryComplete &&
      opportunityEvidence.clubHistoryComplete && !blockers.some(x => x.code === 'INVENTORY_UNAVAILABLE') &&
      commercial.eligibleSubtotalCents <= canonical.cartValueCents) {
    try {
      const discount = quoteDiscount(commercial.eligibleSubtotalCents, policy.promoPercent, policy, commercial);
      return finish('recommend', 'PROMO_ELIGIBLE', 'The configured first-time incentive conditions and explicit commercial allowance are satisfied.',
        { kind: 'promo', percent: policy.promoPercent, singleUseRequired: true, redemptionEnforced: false,
          eligibleSubtotalCents: commercial.eligibleSubtotalCents },
        { kind: 'known', currency: 'USD', maximumDiscountCents: discount });
    } catch {
      reasons.push(note('COMMERCIAL_LIMIT_PREVENTS_PROMO', 'The configured incentive would violate the price floor, money format or applicable discount cap.'));
    }
  } else if (promoBehaviorEligible) {
    if (currentSold.some(sold => sold === undefined)) missing.add('current_section_sell_through');
    if (!currentYieldAllowsPromo) {
      reasons.push(note('CURRENT_YIELD_PREVENTS_PROMO', 'Current sell-through must be known and below both configured incentive thresholds.'));
    } else {
      missing.add('current_explicit_commercial_eligibility');
      reasons.push(note('PROMO_EVIDENCE_INCOMPLETE', 'A possible incentive remains unapproved without current explicit commercial and operational evidence; a reminder costs no incentive.'));
    }
  }
  if (sorted.some(c => c.sectionSoldPercent >= policy.protectYieldAtPercent) ||
      currentSold.some(sold => sold !== undefined && sold >= policy.protectYieldAtPercent)) {
    reasons.push(note('YIELD_PROTECTED', 'High section sell-through excludes incentives under this policy; it does not establish scarcity or adjacency.'));
  }
  return finish('recommend', 'REMINDER_DEFAULT', 'Propose a factual reminder with no discount; individual motivation is unknown.', { kind: 'reminder' });
}

/** Pure snapshot evaluation. No persistence, approvals, network calls, or delivery side effects. */
export function evaluate(input: EvaluationInput): Opportunity[] {
  assertInputShape(input);
  const now = timestamp(input.clock.now()); // Read the injected clock exactly once.
  validateInput(input, now);
  const guestEvidence = new Map<string, { fanIds: Set<string>; complete: boolean }>();
  for (const cart of input.carts) {
    if (cart.identity.kind !== 'guest') continue;
    const key = tuple(cart.tenantId, cart.identity.contactId);
    const evidence = guestEvidence.get(key) ?? { fanIds: new Set<string>(), complete: true };
    for (const id of cart.identity.associatedFanIds) evidence.fanIds.add(id);
    evidence.complete &&= new Set(cart.identity.associatedFanIds).size === 1 && Boolean(cart.identity.provenance?.trim());
    guestEvidence.set(key, evidence);
  }
  const ambiguousContacts = new Set([...guestEvidence].filter(([, e]) => !e.complete || e.fanIds.size !== 1).map(([key]) => key));
  const affectedAccounts = new Set<string>();
  for (const cart of input.carts) {
    if (cart.identity.kind !== 'guest') continue;
    const contactKey = tuple(cart.tenantId, cart.identity.contactId);
    if (!ambiguousContacts.has(contactKey)) continue;
    // Retain uncertain guest rows separately, but do not let candidate accounts ignore their possible latest activity.
    for (const fanId of guestEvidence.get(contactKey)!.fanIds) {
      affectedAccounts.add(tuple(cart.tenantId, `fan:${fanId}`, cart.matchId));
    }
  }
  const groups = new Map<string, Cart[]>();
  for (const cart of input.carts) {
    const key = tuple(cart.tenantId, resolve(cart, ambiguousContacts).subjectKey, cart.matchId);
    const group = groups.get(key) ?? [];
    group.push(cart);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => evaluateGroup(group, input, now, ambiguousContacts, affectedAccounts)).sort((a, b) => compare(a.key, b.key));
}
