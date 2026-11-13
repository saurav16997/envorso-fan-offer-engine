import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { evaluate } from '../domain/engine.js';
import type { EvaluationInput, Opportunity } from '../domain/types.js';
import { transaction, openDatabase } from './database.js';
import { canonical, compatibility, hash, makeProposal, materialBasis, proposalEdit, validateEdit } from './proposal.js';
import { SCENARIOS, tenantInput } from './scenarios.js';
import { ReviewError } from './types.js';
import type { AuditEvent, DemoContext, Edit, Inbox, Issue, ReviewItem, ReviewStatus, RevisionPayload, ScenarioId, Selection } from './types.js';

export interface OpportunityRow {
  opportunity_key: string; current_revision_id: string; approved_revision_id: string | null;
  review_status: ReviewStatus; version: number; basis_hash: string;
}
export interface RevisionRow { revision_id: string; opportunity_key: string; revision_number: number; payload_json: string; payload_hash: string }
export interface ScenarioRow { generation: string; input_json: string; evaluation_at: string }

export class ReviewStore {
  readonly db: DatabaseSync;
  constructor(path: string, readonly context: DemoContext, protected readonly auditClock: () => string = () => new Date().toISOString()) {
    if (!context.tenantId.trim() || !context.actorId.trim()) throw new Error('A trusted server context is required');
    this.db = openDatabase(path);
  }
  close(): void { this.db.close(); }
  protected rows<T>(sql: string, ...args: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...args) as unknown as T[]; }
  protected scenario(id: ScenarioId): ScenarioRow {
    const found = this.rows<ScenarioRow>('SELECT generation, input_json, evaluation_at FROM scenarios WHERE tenant_id = ? AND scenario_id = ?', this.context.tenantId, id)[0];
    if (!found) throw new ReviewError(404, 'Scenario not found for this tenant. Seed the local database first.');
    return found;
  }
  protected input(id: ScenarioId): EvaluationInput {
    const row = this.scenario(id);
    const saved = JSON.parse(row.input_json) as Omit<EvaluationInput, 'clock'>;
    return { ...saved, clock: { now: () => row.evaluation_at } };
  }
  protected event(id: ScenarioId, kind: string, description: string, key: string | null = null, revisionId: string | null = null): void {
    this.db.prepare('INSERT INTO audit_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.context.tenantId, id, randomUUID(), key, revisionId, this.context.actorId, this.auditClock(), kind, description);
  }
  private insertScenario(id: ScenarioId, input: EvaluationInput): void {
    const scoped = tenantInput(input, this.context.tenantId);
    const evaluationAt = scoped.clock.now();
    evaluate({ ...scoped, clock: { now: () => evaluationAt } }); // Validate before persistence.
    this.db.prepare('INSERT INTO scenarios VALUES (?, ?, ?, ?, ?)').run(this.context.tenantId, id, randomUUID(),
      JSON.stringify({ carts: scoped.carts, evidence: scoped.evidence, policy: scoped.policy }), evaluationAt);
    this.event(id, 'scenario_seeded', 'Seeded this isolated demo scenario. All destinations and operational readiness evidence are synthetic.');
    this.sync(id);
  }
  seed(id: ScenarioId, input: EvaluationInput): boolean {
    return transaction(this.db, () => {
      if (this.rows('SELECT scenario_id FROM scenarios WHERE tenant_id = ? AND scenario_id = ?', this.context.tenantId, id).length) return false;
      this.insertScenario(id, input);
      return true;
    });
  }
  reset(id: ScenarioId, confirmation: string, input: EvaluationInput, expectedGeneration?: string): void {
    if (confirmation !== `RESET ${id}`) throw new ReviewError(422, `Type RESET ${id} to delete only this scenario's approvals and history.`);
    transaction(this.db, () => {
      if (expectedGeneration !== undefined) this.generation(id, expectedGeneration);
      this.beforeReset(id);
      this.db.prepare('DELETE FROM scenarios WHERE tenant_id = ? AND scenario_id = ?').run(this.context.tenantId, id);
      this.insertScenario(id, input);
      this.event(id, 'scenario_reset', 'Explicit destructive reset: prior scenario approvals and history were deleted; a new generation invalidates old tabs.');
    });
  }
  /** Trusted server/test ingestion seam, never exposed as an arbitrary client payload. */
  replaceInput(id: ScenarioId, input: EvaluationInput): void {
    transaction(this.db, () => {
      this.scenario(id);
      const scoped = tenantInput(input, this.context.tenantId);
      const at = scoped.clock.now();
      evaluate({ ...scoped, clock: { now: () => at } });
      this.db.prepare('UPDATE scenarios SET input_json = ?, evaluation_at = ? WHERE tenant_id = ? AND scenario_id = ?')
        .run(JSON.stringify({ carts: scoped.carts, evidence: scoped.evidence, policy: scoped.policy }), at, this.context.tenantId, id);
      this.event(id, 'evidence_updated', 'Server evidence changed; recommendations will be re-evaluated before review.');
      this.sync(id);
    });
  }
  protected opportunities(id: ScenarioId): OpportunityRow[] {
    return this.rows('SELECT * FROM opportunities WHERE tenant_id = ? AND scenario_id = ? ORDER BY opportunity_key', this.context.tenantId, id);
  }
  protected revision(id: ScenarioId, revisionId: string): RevisionRow | undefined {
    return this.rows<RevisionRow>('SELECT * FROM revisions WHERE tenant_id = ? AND scenario_id = ? AND revision_id = ?', this.context.tenantId, id, revisionId)[0];
  }
  protected writeRevision(id: ScenarioId, key: string, basisHash: string, payload: RevisionPayload, kind: 'processed' | 'edited'): void {
    const previous = this.opportunities(id).find(row => row.opportunity_key === key)!;
    const revisionNumber = this.rows<{ number: number }>('SELECT COALESCE(MAX(revision_number), 0) + 1 AS number FROM revisions WHERE tenant_id = ? AND scenario_id = ? AND opportunity_key = ?',
      this.context.tenantId, id, key)[0]!.number;
    const revisionId = randomUUID();
    this.db.prepare('INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(this.context.tenantId, id, revisionId,
      key, revisionNumber, basisHash, JSON.stringify(payload), hash(payload), this.auditClock(), this.context.actorId);
    this.db.prepare("UPDATE opportunities SET current_revision_id = ?, approved_revision_id = NULL, review_status = 'draft', version = version + 1, basis_hash = ? WHERE tenant_id = ? AND scenario_id = ? AND opportunity_key = ?")
      .run(revisionId, basisHash, this.context.tenantId, id, key);
    this.afterRevisionChanged(id, key, previous.current_revision_id, payload);
    if (previous.approved_revision_id) this.event(id, 'approval_invalidated', 'Material facts or content changed. The earlier approval remains historical and cannot authorize this new revision.', key, previous.approved_revision_id);
    this.event(id, kind, revisionNumber === 1 ? 'Prepared the first proposal revision.' : kind === 'edited'
      ? 'Saved a new draft revision with the reviewed edits. Fresh approval is required.' : 'Material evidence changed. Prepared a new draft and restored the deterministic proposal for fresh review.', key, revisionId);
  }
  protected sync(id: ScenarioId): void {
    const input = this.input(id);
    const evaluated = evaluate(input);
    const seen = new Set<string>();
    for (const opportunity of evaluated) {
      if (opportunity.tenantId !== this.context.tenantId) throw new Error('Ingestion violated tenant ownership');
      seen.add(opportunity.key);
      const basisHash = materialBasis(input, opportunity);
      this.db.prepare("INSERT OR IGNORE INTO opportunities VALUES (?, ?, ?, NULL, NULL, 'draft', 0, '')").run(this.context.tenantId, id, opportunity.key);
      for (const cart of opportunity.sourceCarts) {
        this.db.prepare('INSERT INTO source_associations VALUES (?, ?, ?, ?, ?) ON CONFLICT (tenant_id, scenario_id, opportunity_key, cart_id) DO UPDATE SET observation_json = excluded.observation_json')
          .run(this.context.tenantId, id, opportunity.key, cart.source.cartId, JSON.stringify(cart));
      }
      const row = this.opportunities(id).find(row => row.opportunity_key === opportunity.key)!;
      const saved = row.current_revision_id ? JSON.parse(this.revision(id, row.current_revision_id)!.payload_json) as RevisionPayload : null;
      if (saved?.proposal?.templateVersion === 'recovery-v1' && row.review_status !== 'rejected' && !this.preserveHistoricalPayload(id, row.opportunity_key)) {
        this.writeRevision(id, opportunity.key, basisHash, { opportunity, proposal: this.renderProposal(id, input, opportunity) }, 'processed');
        continue;
      }
      if (row.review_status === 'rejected' || row.basis_hash === basisHash) continue;
      // Quiet hours defer an unchanged approved job. Other changes still invalidate approval.
      if (row.review_status === 'approved' && opportunity.status === 'recommend' && opportunity.delivery.blockers.length > 0 &&
          opportunity.delivery.blockers.every(b => b.code === 'QUIET_HOURS') &&
          materialBasis(input, { ...opportunity, delivery: { readiness: 'checks_satisfied', blockers: [] } }) === row.basis_hash) continue;
      this.writeRevision(id, opportunity.key, basisHash, { opportunity, proposal: this.renderProposal(id, input, opportunity) }, 'processed');
    }
    for (const row of this.opportunities(id)) {
      if (seen.has(row.opportunity_key) || row.review_status === 'rejected') continue;
      const absentHash = hash(['source_absent', row.opportunity_key]);
      if (row.basis_hash === absentHash) continue;
      const previous = JSON.parse(this.revision(id, row.current_revision_id)!.payload_json) as RevisionPayload;
      const opportunity: Opportunity = { ...previous.opportunity, status: 'hold', proposedAction: null, proposedChannel: null,
        reasons: [{ code: 'SOURCE_NOT_CURRENT', message: 'This opportunity is no longer present in the current source snapshot. Resolve source identity/activity before review.' }],
        delivery: { readiness: 'blocked', blockers: [{ code: 'SOURCE_NOT_CURRENT', message: 'Current source evidence is missing.' }] },
        incentiveExposure: { kind: 'unknown', explanation: 'No current proposal can be evaluated without its source evidence.' }, nextEligibleAt: null };
      this.writeRevision(id, row.opportunity_key, absentHash, { opportunity, proposal: null }, 'processed');
    }
  }
  protected readInbox(id: ScenarioId): Inbox {
    const scenario = this.scenario(id);
    const input = this.input(id);
    const items: ReviewItem[] = this.opportunities(id).map(row => {
      const revision = this.revision(id, row.current_revision_id)!;
      const payload = JSON.parse(revision.payload_json) as RevisionPayload;
      const permittedChannels = (['email', 'push'] as const).filter(channel => {
        if (!payload.proposal) return false;
        try { this.renderProposal(id, input, payload.opportunity, { ...proposalEdit(payload.proposal), channel }); return true; }
        catch (error) { if (error instanceof ReviewError) return false; throw error; }
      });
      return { key: row.opportunity_key, revisionId: row.current_revision_id, revisionNumber: revision.revision_number,
        version: row.version, reviewStatus: row.review_status, approvedRevisionId: row.approved_revision_id,
        payload, permittedChannels,
        revisions: this.rows<RevisionRow & { created_at: string }>('SELECT * FROM revisions WHERE tenant_id = ? AND scenario_id = ? AND opportunity_key = ? ORDER BY revision_number DESC',
          this.context.tenantId, id, row.opportunity_key).map(r => ({ id: r.revision_id, number: r.revision_number, at: r.created_at, payload: JSON.parse(r.payload_json) as RevisionPayload })) };
    });
    const history = this.rows<{ event_id: string; opportunity_key: string | null; revision_id: string | null; actor_id: string; event_at: string; kind: string; description: string }>(
      'SELECT * FROM audit_events WHERE tenant_id = ? AND scenario_id = ? ORDER BY rowid DESC', this.context.tenantId, id)
      .map((e): AuditEvent => ({ id: e.event_id, opportunityKey: e.opportunity_key, revisionId: e.revision_id, actorId: e.actor_id, at: e.event_at, kind: e.kind, description: e.description }));
    return { scenario: id, generation: scenario.generation, label: SCENARIOS[id].label, description: SCENARIOS[id].description,
      evaluationAt: scenario.evaluation_at, actorLabel: 'Demo marketer', tenantLabel: 'Seawolves',
      sourceNote: id === 'original' ? 'Full supplied sample: 8 carts / 6 opportunities. This Seawolves inbox: 7 carts / 5 opportunities. The onboarding club’s cart is isolated in its own tenant.'
        : id === 'grouped' ? 'All 12 fan references and carts in this workload are synthetic.' : 'Separate synthetic scenario. Original activity is unchanged; the clock advances 24 hours.', items, history };
  }
  inbox(id: ScenarioId): Inbox { return transaction(this.db, () => { this.sync(id); return this.readInbox(id); }); }
  protected generation(id: ScenarioId, expected: string): void {
    if (this.scenario(id).generation !== expected) throw new ReviewError(409, 'This scenario was reset. Reload; old selections cannot approve the new generation.');
  }
  protected selected(id: ScenarioId, selection: Selection): { row: OpportunityRow; revision: RevisionRow; payload: RevisionPayload } {
    if (!selection || typeof selection.revisionId !== 'string' || !Number.isSafeInteger(selection.expectedVersion) || selection.expectedVersion < 1) {
      throw new ReviewError(422, 'A revision ID and positive expected version are required.');
    }
    const revision = this.revision(id, selection.revisionId);
    if (!revision) throw new ReviewError(404, 'That revision does not belong to this scenario and tenant.');
    const row = this.opportunities(id).find(o => o.opportunity_key === revision.opportunity_key)!;
    if (row.current_revision_id !== selection.revisionId) throw new ReviewError(409, 'This proposal revision is stale. Reload and inspect the current preview.');
    return { row, revision, payload: JSON.parse(revision.payload_json) as RevisionPayload };
  }
  protected currentEligibility(id: ScenarioId, payload: RevisionPayload): void {
    if (!payload.proposal || payload.opportunity.status !== 'recommend' || payload.opportunity.delivery.readiness !== 'checks_satisfied') {
      throw new ReviewError(422, 'This proposal is blocked, waiting, excluded or expired. Resolve its checks before approval.');
    }
    const rendered = this.renderProposal(id, this.input(id), payload.opportunity, proposalEdit(payload.proposal));
    if (canonical(rendered) !== canonical(payload.proposal)) throw new ReviewError(409, 'Recipient, content or offer terms changed. A fresh revision must be reviewed.');
  }
  approve(id: ScenarioId, generation: string, selections: readonly Selection[], batch = false): { alreadyApproved: number; approved: number } {
    if (!Array.isArray(selections) || !selections.length || selections.length > 50 || new Set(selections.map(s => s.revisionId)).size !== selections.length || (!batch && selections.length !== 1)) {
      throw new ReviewError(422, 'Select between one and fifty distinct revisions; individual approval requires one revision.');
    }
    const result = transaction(this.db, () => {
      this.generation(id, generation);
      this.sync(id);
      const issues: Issue[] = [];
      const pending: ReturnType<ReviewStore['selected']>[] = [];
      let alreadyApproved = 0;
      let group: string | null = null;
      for (const selection of selections) {
        try {
          const chosen = this.selected(id, selection);
          this.currentEligibility(id, chosen.payload);
          if (chosen.row.review_status === 'rejected') throw new ReviewError(409, 'This opportunity was rejected and is closed.');
          if (batch) {
            const p = chosen.payload.proposal!;
            if (p.offer.kind !== 'reminder' || p.exposure.kind !== 'known' || p.exposure.maximumDiscountCents !== 0) throw new ReviewError(422, 'Discounts require individual review and cannot enter a reminder batch.');
            if (group !== null && group !== compatibility(p)) throw new ReviewError(422, 'Batch reminders must share match, channel, template and policy.');
            group = compatibility(p);
          }
          if (chosen.row.review_status === 'approved' && chosen.row.approved_revision_id === selection.revisionId &&
              (chosen.row.version === selection.expectedVersion || chosen.row.version === selection.expectedVersion + 1)) { alreadyApproved += 1; continue; }
          if (chosen.row.version !== selection.expectedVersion) throw new ReviewError(409, 'Another review changed this opportunity. Reload before acting.');
          pending.push(chosen);
        } catch (error) {
          if (!(error instanceof ReviewError)) throw error;
          issues.push({ revisionId: selection.revisionId, message: error.message });
        }
      }
      // Commit material invalidations even when review is blocked. No approvals are written before every row passes.
      if (issues.length) return { error: new ReviewError(409, 'No proposals were approved. Some selected items changed or need attention.', issues) };
      for (const chosen of pending) {
        this.db.prepare('INSERT INTO review_decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(this.context.tenantId, id, randomUUID(), chosen.row.opportunity_key, chosen.revision.revision_id, 'approve', this.context.actorId, this.auditClock(), null, chosen.revision.payload_hash);
        const update = this.db.prepare("UPDATE opportunities SET review_status = 'approved', approved_revision_id = current_revision_id, version = version + 1 WHERE tenant_id = ? AND scenario_id = ? AND opportunity_key = ? AND version = ?")
          .run(this.context.tenantId, id, chosen.row.opportunity_key, chosen.row.version);
        if (update.changes !== 1) throw new Error('Concurrent review conflict');
        this.afterApproval(id, chosen.row.opportunity_key, chosen.revision.revision_id, chosen.payload);
        this.event(id, 'approved', 'Approved this exact immutable revision, recipient, channel, message and terms. Awaiting dispatch; nothing has been sent.', chosen.row.opportunity_key, chosen.revision.revision_id);
      }
      return { approved: pending.length, alreadyApproved };
    });
    if ('error' in result) throw result.error;
    return result;
  }
  edit(id: ScenarioId, generation: string, selection: Selection, edit: Edit): void {
    validateEdit(edit);
    const result = transaction(this.db, () => {
      this.generation(id, generation); this.sync(id);
      try {
        const chosen = this.selected(id, selection);
        if (chosen.row.version !== selection.expectedVersion || chosen.row.review_status === 'rejected') throw new ReviewError(409, 'This review changed or closed. Reload before editing.');
        this.beforeReviewMutation(id, chosen.row.opportunity_key);
        this.validateEditContext(id, selection, edit);
        const proposal = this.renderProposal(id, this.input(id), chosen.payload.opportunity, edit);
        const payload = { ...chosen.payload, proposal };
        if (hash(payload) !== chosen.revision.payload_hash) {
          this.writeRevision(id, chosen.row.opportunity_key, chosen.row.basis_hash, payload, 'edited');
          this.afterEditSaved(id, this.opportunities(id).find(o => o.opportunity_key === chosen.row.opportunity_key)!.current_revision_id, edit);
        }
        return {};
      } catch (error) { if (error instanceof ReviewError) return { error }; throw error; }
    });
    if (result.error) throw result.error;
  }
  reject(id: ScenarioId, generation: string, selection: Selection, reason: string | null): void {
    if (reason !== null && !['not_relevant', 'prefer_no_contact', 'data_concern', 'other'].includes(reason)) throw new ReviewError(422, 'Choose a supported rejection reason.');
    const result = transaction(this.db, () => {
      this.generation(id, generation); this.sync(id);
      try {
        const chosen = this.selected(id, selection);
        if (chosen.row.review_status === 'rejected' && chosen.row.version === selection.expectedVersion + 1) return {};
        if (chosen.row.version !== selection.expectedVersion || chosen.row.review_status === 'rejected') throw new ReviewError(409, 'This review changed or closed. Reload before rejecting.');
        this.beforeReviewMutation(id, chosen.row.opportunity_key);
        this.db.prepare('INSERT INTO review_decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(this.context.tenantId, id, randomUUID(),
          chosen.row.opportunity_key, chosen.revision.revision_id, 'reject', this.context.actorId, this.auditClock(), reason, chosen.revision.payload_hash);
        this.db.prepare("UPDATE opportunities SET review_status = 'rejected', approved_revision_id = NULL, version = version + 1 WHERE tenant_id = ? AND scenario_id = ? AND opportunity_key = ? AND version = ?")
          .run(this.context.tenantId, id, chosen.row.opportunity_key, chosen.row.version);
        this.event(id, 'rejected', `Closed this opportunity${reason ? `: ${reason.replaceAll('_', ' ')}` : ''}. Reprocessing will not reopen it.`, chosen.row.opportunity_key, chosen.revision.revision_id);
        this.afterRevisionChanged(id, chosen.row.opportunity_key, chosen.revision.revision_id, { ...chosen.payload, proposal: null });
        return {};
      } catch (error) { if (error instanceof ReviewError) return { error }; throw error; }
    });
    if (result.error) throw result.error;
  }
  simulateChange(id: ScenarioId, generation: string, selection: Selection, change: 'purchase' | 'revoke_consent'): void {
    transaction(this.db, () => {
      this.generation(id, generation);
      const chosen = this.selected(id, selection);
      if (chosen.row.version !== selection.expectedVersion) throw new ReviewError(409, 'Reload before applying a demo evidence change.');
      const input = this.input(id);
      const changedAt = input.clock.now();
      const o = chosen.payload.opportunity;
      const matches = (record: { subjectKey: string; tenantId: string }): boolean => record.tenantId === this.context.tenantId && record.subjectKey === o.subjectKey;
      const changed: EvaluationInput = { ...input, evidence: { ...input.evidence,
        opportunities: input.evidence.opportunities.map(x => change === 'purchase' && matches(x) && x.matchId === o.matchId ? { ...x, purchase: 'purchased' } : x),
        consents: input.evidence.consents.map(x => change === 'revoke_consent' && matches(x) ? { ...x, status: 'revoked', effectiveAt: changedAt,
          checkedAt: changedAt, validUntil: new Date(Date.parse(changedAt) + input.policy.evidenceMaxAgeHours * 3_600_000).toISOString() } : x) } };
      evaluate(changed);
      this.db.prepare('UPDATE scenarios SET input_json = ? WHERE tenant_id = ? AND scenario_id = ?')
        .run(JSON.stringify({ carts: changed.carts, policy: changed.policy, evidence: changed.evidence }), this.context.tenantId, id);
      this.event(id, 'demo_evidence_changed', change === 'purchase' ? 'Simulated a relevant purchase. No real order was created.' : 'Simulated revoked marketing consent. No real permission record was changed.', o.key, chosen.revision.revision_id);
      this.sync(id);
    });
  }
  protected renderProposal(_id: ScenarioId, input: EvaluationInput, opportunity: Opportunity, edit?: Edit) { return makeProposal(input, opportunity, edit); }
  protected afterApproval(_id: ScenarioId, _key: string, _revisionId: string, _payload: RevisionPayload): void {}
  protected afterRevisionChanged(_id: ScenarioId, _key: string, _previousRevisionId: string | null, _payload: RevisionPayload): void {}
  protected beforeReviewMutation(_id: ScenarioId, _key: string): void {}
  protected beforeReset(_id: ScenarioId): void {}
  protected preserveHistoricalPayload(_id: ScenarioId, _key: string): boolean { return false; }
  protected validateEditContext(_id: ScenarioId, _selection: Selection, _edit: Edit): void {}
  protected afterEditSaved(_id: ScenarioId, _revisionId: string, _edit: Edit): void {}
}
