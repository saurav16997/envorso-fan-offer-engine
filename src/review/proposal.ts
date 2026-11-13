import { createHash } from 'node:crypto';
import { evaluate } from '../domain/engine.js';
import { HOUR_MS, quoteDiscount, timestamp } from '../domain/policy.js';
import type { EvaluationInput, Opportunity } from '../domain/types.js';
import { ReviewError } from './types.js';
import type { Edit, Proposal } from './types.js';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const ordered = (values: readonly unknown[]): unknown[] => [...values].sort((a, b) => canonical(a).localeCompare(canonical(b)));
export const PUSH_LIMITS = { title: 50, body: 160 } as const; // Initial app policy, not provider limits.

/** Freshness affects the engine outcome; check/processing timestamps alone do not change a revision. */
export function materialBasis(input: EvaluationInput, opportunity: Opportunity): string {
  const e = input.evidence;
  const scoped = (x: { tenantId: string; subjectKey: string }): boolean => x.tenantId === opportunity.tenantId && x.subjectKey === opportunity.subjectKey;
  const withoutFreshness = <T extends { checkedAt: string; validUntil: string }>(x: T): Omit<T, 'checkedAt' | 'validUntil'> => {
    const { checkedAt: _checkedAt, validUntil: _validUntil, ...facts } = x;
    return facts;
  };
  return hash({ opportunity, policy: input.policy,
    tenant: e.tenants.filter(x => x.tenantId === opportunity.tenantId),
    matches: e.matches.filter(x => x.tenantId === opportunity.tenantId && x.matchId === opportunity.matchId).map(withoutFreshness),
    operations: e.opportunities.filter(x => scoped(x) && x.matchId === opportunity.matchId).map(withoutFreshness),
    destinations: ordered(e.destinations.filter(scoped)), consents: ordered(e.consents.filter(scoped).map(withoutFreshness)),
    contacts: ordered(e.contacts.filter(scoped)),
    commercial: ordered(e.commercial.filter(x => scoped(x) && x.matchId === opportunity.matchId).map(withoutFreshness)),
  });
}

export const moneyLabel = (cents: number): string => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
export const dateLabel = (iso: string): string => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles',
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso));

export function proposalEdit(proposal: Proposal): Edit {
  return { channel: proposal.channel, offer: proposal.offer.kind, percent: proposal.offer.percent, introduction: proposal.content.introduction, subject: proposal.content.subject };
}

export function validateEdit(edit: Edit): void {
  if (!edit || (edit.channel !== 'email' && edit.channel !== 'push') || (edit.offer !== 'reminder' && edit.offer !== 'promo') ||
      typeof edit.introduction !== 'string' || edit.introduction.length > 240 || !edit.introduction.trim() ||
      /[<>\d%$]|https?:|www\.|[\x00-\x08\x0b-\x1f]/i.test(edit.introduction) ||
      (edit.subject !== undefined && (typeof edit.subject !== 'string' || !edit.subject.trim() || edit.subject.length > 70 || /[<>\d%$]|https?:|www\.|[\x00-\x1f\x7f]/i.test(edit.subject))) ||
      (edit.suggestionId !== undefined && (typeof edit.suggestionId !== 'string' || edit.suggestionId.length > 80)) ||
      (edit.offer === 'reminder' ? edit.percent !== null : !Number.isInteger(edit.percent) || edit.percent! < 1)) {
    throw new ReviewError(422, 'Use a permitted channel/offer and a short plain-text introduction. Keep numbers, amounts, URLs and offer terms in the locked message sections.');
  }
}

export function makeProposal(input: EvaluationInput, basis: Opportunity, edit?: Edit): Proposal | null {
  if (!basis.proposedAction || !basis.proposedChannel) {
    if (edit) throw new ReviewError(422, 'This opportunity has no eligible proposal to edit.');
    return null;
  }
  let selected = basis;
  if (edit) {
    validateEdit(edit);
    const candidate = evaluate({ ...input, evidence: { ...input.evidence,
      opportunities: input.evidence.opportunities.map(o => o.tenantId === basis.tenantId && o.subjectKey === basis.subjectKey && o.matchId === basis.matchId
        ? { ...o, preferredChannel: edit.channel } : o) } }).find(o => o.key === basis.key);
    if (!candidate || candidate.status !== 'recommend' || candidate.delivery.readiness !== 'checks_satisfied' || candidate.proposedChannel !== edit.channel) {
      throw new ReviewError(422, 'The requested channel is not currently eligible with verified reachability and scoped consent.');
    }
    selected = candidate;
  }
  const channel = edit?.channel ?? selected.proposedChannel!;
  if (edit && channel === 'push' && edit.introduction.length > 100) throw new ReviewError(422, 'Push opening must be at most 100 characters. Locked factual sections are separate from this opening.');
  const cart = selected.sourceCarts.find(c => c.source.cartId === selected.canonicalCartId)!;
  const match = input.evidence.matches.find(m => m.tenantId === selected.tenantId && m.matchId === selected.matchId)!;
  const destination = input.evidence.destinations.find(d => d.tenantId === selected.tenantId && d.subjectKey === selected.subjectKey && d.channel === channel);
  const expiresAt = new Date(Math.min(timestamp(selected.latestActivityAt) + input.policy.maximumInactivityHours * HOUR_MS,
    timestamp(match.kickoffAt) - input.policy.kickoffCutoffHours * HOUR_MS)).toISOString();
  const kind = edit?.offer ?? selected.proposedAction!.kind;
  let percent: number | null = null;
  let eligibleSubtotalCents: number | null = null;
  let discountCents = 0;
  if (kind === 'promo') {
    if (selected.proposedAction?.kind !== 'promo') throw new ReviewError(422, 'Current eligibility permits a reminder only; a discount cannot be added.');
    percent = edit?.percent ?? selected.proposedAction.percent;
    const commercial = input.evidence.commercial.find(c => c.tenantId === selected.tenantId && c.subjectKey === selected.subjectKey &&
      c.matchId === selected.matchId && c.cartId === selected.canonicalCartId)!;
    eligibleSubtotalCents = commercial.eligibleSubtotalCents;
    try { discountCents = quoteDiscount(eligibleSubtotalCents, percent!, input.policy, commercial); }
    catch { throw new ReviewError(422, 'That incentive exceeds the configured policy, commercial allowance or price floor.'); }
  }
  const introduction = edit?.introduction.trim() ?? 'You can pick up where you left off with your ticket basket.';
  const matchLabel = 'Seawolves home match';
  const terms = kind === 'promo'
    ? `${percent}% off the ${moneyLabel(eligibleSubtotalCents!)} eligible ticket subtotal, up to ${moneyLabel(discountCents)}. Single use required for this fan and match. Taxes and fees excluded.`
    : 'No discount. Current availability and pricing apply; seats are not reserved or guaranteed adjacent.';
  const ctaUrl = `https://tickets.example.invalid/demo/cart/${encodeURIComponent(cart.source.cartId)}`;
  const details = [`${matchLabel} · ${dateLabel(match.kickoffAt)}.`,
    `Your basket: ${cart.source.seats} ${cart.source.seats === 1 ? 'seat' : 'seats'} in ${cart.source.section}, observed value ${moneyLabel(cart.cartValueCents)}.`,
    terms, `Offer expires ${dateLabel(expiresAt)}.`, `Review your basket: ${ctaUrl}`].join('\n\n');
  const pushBody = `${introduction}${kind === 'promo' ? ' Offer terms in basket.' : ''}`;
  const subject = channel === 'email' ? edit?.subject?.trim() ?? 'Your Seawolves ticket basket' : 'Your Seawolves ticket basket';
  if (channel === 'push' && (subject.length > PUSH_LIMITS.title || pushBody.length > PUSH_LIMITS.body)) throw new ReviewError(422, 'Complete push notification exceeds application title/body limits.');
  return { templateVersion: 'recovery-v2', recipient: {
    reference: canonical([selected.tenantId, selected.subjectKey, channel, destination?.value ?? null]),
    destination: destination?.value ?? 'Missing destination' }, channel,
    basket: { cartId: cart.source.cartId, seats: cart.source.seats, section: cart.source.section, valueCents: cart.cartValueCents },
    match: { id: match.matchId, label: matchLabel, kickoffAt: match.kickoffAt },
    offer: { kind, percent, eligibleSubtotalCents, expiresAt, terms, singleUseRequired: kind === 'promo', redemptionEnforced: false },
    exposure: { kind: 'known', currency: 'USD', maximumDiscountCents: discountCents },
    ...(channel === 'push' ? { destinationContent: { url: ctaUrl, body: details } } : {}),
    content: { introduction, subject, body: channel === 'push' ? pushBody : `${introduction}\n\n${details}`, ctaLabel: 'Review your basket', ctaUrl }, policyVersion: input.policy.version };
}

export function compatibility(proposal: Proposal): string {
  return canonical([proposal.channel, proposal.match.id, proposal.templateVersion, proposal.policyVersion, proposal.offer.kind]);
}
