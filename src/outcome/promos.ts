import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { EvaluationInput, Opportunity } from '../domain/types.js';
import { cents, quoteDiscount, timestamp } from '../domain/policy.js';
import { hash } from '../review/proposal.js';
import { ReviewError } from '../review/types.js';
import type { DemoContext, Proposal, ScenarioId } from '../review/types.js';
import type { PromoView, PurchaseView, RedemptionRequest } from './types.js';

interface PromoRow { code: string; opportunity_key: string; subject_key: string; match_id: string; section: string; seats: number;
  percent: number; subtotal_cents: number; maximum_discount_cents: number; expires_at: string;
  approved_revision_id: string | null; state: PromoView['state'] }
interface Host { db: DatabaseSync; context: DemoContext; input: (id: ScenarioId) => EvaluationInput; now: () => string }

/** All methods participate in the caller's SQLite transaction. This is a simulated checkout only. */
export class PromoLedger {
  constructor(private host: Host) {}
  private find(id: ScenarioId, code: string): PromoRow {
    const row = this.host.db.prepare('SELECT * FROM promos WHERE tenant_id = ? AND scenario_id = ? AND code = ?')
      .get(this.host.context.tenantId, id, code) as unknown as PromoRow | undefined;
    if (!row) throw new ReviewError(404, 'Promo not found in this tenant and scenario.');
    return row;
  }
  attach(id: ScenarioId, opportunity: Opportunity, proposal: Proposal, generation: string): Proposal {
    if (proposal.offer.kind !== 'promo') return proposal;
    const p = proposal;
    const termsHash = hash({ subject: opportunity.subjectKey, match: p.match.id, basket: p.basket,
      percent: p.offer.percent, subtotal: p.offer.eligibleSubtotalCents, cap: p.exposure, expires: p.offer.expiresAt, policy: p.policyVersion });
    const code = `DEMO-${hash([this.host.context.tenantId, id, generation, opportunity.key, termsHash]).slice(0, 20).toUpperCase()}`;
    if (p.exposure.kind !== 'known' || p.offer.percent === null || p.offer.eligibleSubtotalCents === null) throw new Error('Promo must have exact terms and known exposure');
    this.host.db.prepare('INSERT OR IGNORE INTO promos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
      .run(this.host.context.tenantId, id, code, opportunity.key, termsHash, opportunity.subjectKey, p.match.id,
        p.basket.section, p.basket.seats, p.offer.percent, p.offer.eligibleSubtotalCents,
        p.exposure.maximumDiscountCents, p.offer.expiresAt, 'reserved');
    const terms = p.offer.terms.replace('Redemption is not implemented or enforced.', 'Single-use redemption is enforced only inside the simulated checkout; real ticketing enforcement is not implemented.');
    const body = p.content.body.replace(p.offer.terms, `${terms}\nPromo code: ${code}`);
    return { ...p, ...(p.destinationContent ? { destinationContent: { ...p.destinationContent,
      body: p.destinationContent.body.replace(p.offer.terms, `${terms}\nPromo code: ${code}`) } } : {}),
      offer: { ...p.offer, terms, promoCode: code, simulationRedemptionEnforced: true }, content: { ...p.content, body } };
  }
  activate(id: ScenarioId, code: string, revisionId: string): void {
    const promo = this.find(id, code);
    if (promo.state === 'redeemed') throw new ReviewError(409, 'This code is already used. A new approval cannot restore it.');
    this.host.db.prepare("UPDATE promos SET state = 'active', approved_revision_id = ? WHERE tenant_id = ? AND scenario_id = ? AND code = ?")
      .run(revisionId, this.host.context.tenantId, id, code);
  }
  requireActiveForDispatch(id: ScenarioId, code: string, revisionId: string): void {
    const promo = this.find(id, code);
    if (promo.state !== 'active' || promo.approved_revision_id !== revisionId) throw new ReviewError(422,
      `The approved simulated promo is ${promo.state} or belongs to another revision. Do not send an unusable code.`);
  }
  reserveOrCancel(id: ScenarioId, key: string, retainedCode: string | null): void {
    this.host.db.prepare(`UPDATE promos SET state = CASE WHEN code = ? THEN 'reserved' ELSE 'cancelled' END, approved_revision_id = NULL
      WHERE tenant_id = ? AND scenario_id = ? AND opportunity_key = ? AND state IN ('reserved','active')`)
      .run(retainedCode, this.host.context.tenantId, id, key);
  }
  cancel(id: ScenarioId, code: string): void {
    const promo = this.find(id, code);
    if (promo.state === 'redeemed') throw new ReviewError(409, 'A consumed code cannot be cancelled into a reusable state.');
    this.host.db.prepare("UPDATE promos SET state = 'cancelled' WHERE tenant_id = ? AND scenario_id = ? AND code = ?")
      .run(this.host.context.tenantId, id, code);
  }
  redeem(id: ScenarioId, request: RedemptionRequest): PurchaseView {
    if (!request || typeof request.code !== 'string' || typeof request.subjectKey !== 'string' || typeof request.matchId !== 'string' || typeof request.section !== 'string') throw new ReviewError(422, 'Exact promo and simulated ticket scope are required.');
    try { cents(request.eligibleSubtotalCents); } catch { throw new ReviewError(422, 'Eligible amount must be nonnegative integer cents.'); }
    const row = this.find(id, request.code);
    if (row.state !== 'active' || !row.approved_revision_id) throw new ReviewError(409, `This simulated code is ${row.state}; it cannot be redeemed.`);
    const input = this.host.input(id);
    const now = timestamp(input.clock.now());
    if (now >= timestamp(row.expires_at)) throw new ReviewError(422, 'This simulated promo has expired.');
    if (row.subject_key !== request.subjectKey || row.match_id !== request.matchId || row.section !== request.section ||
        row.seats !== request.seats || row.subtotal_cents !== request.eligibleSubtotalCents) throw new ReviewError(422, 'Wrong fan, match, section, quantity or eligible amount for this code.');
    const active = input.evidence.tenants.find(t => t.tenantId === this.host.context.tenantId)?.active;
    const match = input.evidence.matches.find(m => m.tenantId === this.host.context.tenantId && m.matchId === row.match_id);
    const operations = input.evidence.opportunities.find(o => o.tenantId === this.host.context.tenantId && o.subjectKey === row.subject_key && o.matchId === row.match_id);
    const commercial = input.evidence.commercial.find(c => c.tenantId === this.host.context.tenantId && c.subjectKey === row.subject_key && c.matchId === row.match_id &&
      c.cartId === (JSON.parse(this.host.db.prepare('SELECT payload_json FROM revisions WHERE tenant_id = ? AND scenario_id = ? AND revision_id = ?')
        .get(this.host.context.tenantId, id, row.approved_revision_id)!.payload_json as string) as { proposal: Proposal }).proposal.basket.cartId);
    const fresh = (x: { checkedAt: string; validUntil: string } | undefined): boolean => Boolean(x && timestamp(x.checkedAt) <= now &&
      now - timestamp(x.checkedAt) <= input.policy.evidenceMaxAgeHours * 3_600_000 && now < timestamp(x.validUntil));
    if (!active || !match || match.state !== 'scheduled' || now >= timestamp(match.kickoffAt) - input.policy.kickoffCutoffHours * 3_600_000 ||
        !fresh(match) || !fresh(operations) || operations?.purchase !== 'not_purchased' || !fresh(commercial) || !commercial?.approved || !commercial.provenance.trim() ||
        !Object.hasOwn(match.availableSeatsBySection, row.section) || match.availableSeatsBySection[row.section]! < row.seats) {
      throw new ReviewError(422, 'Current simulated checkout inventory, purchase or commercial checks do not permit this purchase.');
    }
    let discount: number;
    try { discount = quoteDiscount(request.eligibleSubtotalCents, row.percent, input.policy, commercial); }
    catch { throw new ReviewError(422, 'Current policy, hard cap, commercial floor or allowance rejects this discount.'); }
    if (discount > row.maximum_discount_cents) throw new ReviewError(422, 'Discount exceeds the approved maximum exposure.');
    const purchase: PurchaseView = { id: randomUUID(), code: row.code, subjectKey: row.subject_key, matchId: row.match_id,
      subtotalCents: request.eligibleSubtotalCents, discountCents: discount, paidCents: request.eligibleSubtotalCents - discount, evaluationAt: input.clock.now() };
    const consumed = this.host.db.prepare("UPDATE promos SET state = 'redeemed' WHERE tenant_id = ? AND scenario_id = ? AND code = ? AND state = 'active'")
      .run(this.host.context.tenantId, id, row.code);
    if (consumed.changes !== 1) throw new ReviewError(409, 'This code was already consumed by another simulated checkout.');
    this.host.db.prepare('INSERT INTO simulated_purchases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.host.context.tenantId, id, purchase.id, row.code, row.subject_key, row.match_id, purchase.subtotalCents, discount, purchase.paidCents, purchase.evaluationAt, this.host.now());
    const evidence = { ...input.evidence,
      opportunities: input.evidence.opportunities.map(o => o === operations ? { ...o, purchase: 'purchased' as const } : o),
      matches: input.evidence.matches.map(m => m === match ? { ...m, availableSeatsBySection: { ...m.availableSeatsBySection, [row.section]: m.availableSeatsBySection[row.section]! - row.seats } } : m) };
    // A local simulated order is new evidence; unrelated freshness timestamps are preserved.
    this.host.db.prepare('UPDATE scenarios SET input_json = ? WHERE tenant_id = ? AND scenario_id = ?')
      .run(JSON.stringify({ carts: input.carts, policy: input.policy, evidence }), this.host.context.tenantId, id);
    return purchase;
  }
  list(id: ScenarioId): PromoView[] {
    return (this.host.db.prepare('SELECT * FROM promos WHERE tenant_id = ? AND scenario_id = ? ORDER BY code').all(this.host.context.tenantId, id) as unknown as PromoRow[])
      .map(p => ({ code: p.code, subjectKey: p.subject_key, matchId: p.match_id, section: p.section, seats: p.seats,
        percent: p.percent, subtotalCents: p.subtotal_cents, maximumDiscountCents: p.maximum_discount_cents, expiresAt: p.expires_at, state: p.state }));
  }
  purchases(id: ScenarioId): PurchaseView[] {
    return (this.host.db.prepare('SELECT * FROM simulated_purchases WHERE tenant_id = ? AND scenario_id = ? ORDER BY rowid DESC').all(this.host.context.tenantId, id) as unknown as {
      purchase_id: string; code: string; subject_key: string; match_id: string; subtotal_cents: number; discount_cents: number; paid_cents: number; evaluation_at: string }[])
      .map(p => ({ id: p.purchase_id, code: p.code, subjectKey: p.subject_key, matchId: p.match_id, subtotalCents: p.subtotal_cents, discountCents: p.discount_cents, paidCents: p.paid_cents, evaluationAt: p.evaluation_at }));
  }
}
