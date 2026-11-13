import { randomUUID } from 'node:crypto';
import { evaluate } from '../domain/engine.js';
import { timestamp } from '../domain/policy.js';
import type { Contact, EvaluationInput, Opportunity } from '../domain/types.js';
import { ReviewStore } from '../review/store.js';
import { transaction } from '../review/database.js';
import { canonical, hash, makeProposal, materialBasis, proposalEdit } from '../review/proposal.js';
import { ReviewError } from '../review/types.js';
import type { Edit, Inbox, RevisionPayload, ScenarioId, Selection } from '../review/types.js';
import { PromoLedger } from './promos.js';
import { MessagingSimulator, simulatorMode } from './simulator.js';
import type { Claim, DispatchState, DispatchView, RedemptionRequest, SimulatedResult, SimulatorMode } from './types.js';

interface Job {
  dispatch_id: string; subject_key: string; match_id: string; opportunity_key: string; binding_id: string;
  state: DispatchState; explanation: string; next_check_at: string | null; claim_token: string | null;
  lease_until: string | null; provider_reference: string | null; updated_at: string;
}
interface Binding { binding_id: string; revision_id: string; payload_json: string; payload_hash: string; idempotency_key: string }
interface Attempt { attempt_id: string; binding_id: string; attempt_number: number; state: string; started_at: string;
  evaluation_at: string; call_started: number; mode: SimulatorMode; provider_reference: string | null; explanation: string }
const protectedStates: readonly DispatchState[] = ['in_progress', 'accepted', 'unknown'];
const LEASE_MS = 120_000;
const MAX_CALLS = 2;

/** Persisted review plus local delivery/checkout simulations. Every SQL operation is scoped. */
export class OutcomeStore extends ReviewStore {
  protected override preserveHistoricalPayload(id: ScenarioId, key: string): boolean {
    return this.jobs(id).some(j => j.opportunity_key === key && protectedStates.includes(j.state));
  }
  private ledger(): PromoLedger { return new PromoLedger({ db: this.db, context: this.context, input: id => this.input(id), now: () => this.auditClock() }); }
  private simulator(): MessagingSimulator { return new MessagingSimulator(this.db, this.context); }
  private jobs(id: ScenarioId): Job[] { return this.rows('SELECT * FROM dispatches WHERE tenant_id = ? AND scenario_id = ? ORDER BY rowid', this.context.tenantId, id); }
  private job(id: ScenarioId, jobId: string): Job {
    const job = this.jobs(id).find(j => j.dispatch_id === jobId);
    if (!job) throw new ReviewError(404, 'Logical send not found in this tenant and scenario.');
    return job;
  }
  private binding(id: ScenarioId, bindingId: string): Binding {
    const binding = this.rows<Binding>('SELECT * FROM dispatch_bindings WHERE tenant_id = ? AND scenario_id = ? AND binding_id = ?', this.context.tenantId, id, bindingId)[0];
    if (!binding) throw new Error('Dispatch has no immutable approved binding');
    return binding;
  }
  private attempts(id: ScenarioId, jobId: string): Attempt[] {
    return this.rows('SELECT * FROM dispatch_attempts WHERE tenant_id = ? AND scenario_id = ? AND dispatch_id = ? ORDER BY attempt_number', this.context.tenantId, id, jobId);
  }
  private calls(id: ScenarioId, jobId: string): number { return this.attempts(id, jobId).filter(a => a.call_started).length; }
  private mode(id: ScenarioId): SimulatorMode {
    return this.rows<{ mode: SimulatorMode }>('SELECT mode FROM simulator_settings WHERE tenant_id = ? AND scenario_id = ?', this.context.tenantId, id)[0]?.mode ?? 'accepted';
  }
  protected override renderProposal(id: ScenarioId, input: EvaluationInput, opportunity: Opportunity, edit?: Edit) {
    const proposal = makeProposal(input, opportunity, edit);
    return proposal ? this.ledger().attach(id, opportunity, proposal, this.scenario(id).generation) : null;
  }
  protected override sync(id: ScenarioId): void {
    super.sync(id);
    // Upgrade old promo previews through a NEW draft, never changing already approved text in place.
    for (const row of this.opportunities(id)) {
      const revision = this.revision(id, row.current_revision_id)!;
      const payload = JSON.parse(revision.payload_json) as RevisionPayload;
      if (row.review_status !== 'rejected' && payload.proposal?.offer.kind === 'promo' && !payload.proposal.offer.promoCode) {
        const input = this.input(id);
        const current = evaluate(input).find(o => o.key === row.opportunity_key)!;
        this.writeRevision(id, row.opportunity_key, materialBasis(input, current), { opportunity: current,
          proposal: this.renderProposal(id, input, current) }, 'processed');
      } else if (row.review_status === 'approved' && row.approved_revision_id === row.current_revision_id &&
          !this.jobs(id).some(j => j.opportunity_key === row.opportunity_key)) {
        this.afterApproval(id, row.opportunity_key, row.current_revision_id, payload);
      }
    }
  }
  protected override beforeReset(id: ScenarioId): void {
    if (this.jobs(id).some(j => j.state === 'in_progress' || j.state === 'unknown')) throw new ReviewError(409, 'An in-progress or unknown request cannot be erased to release contact suppression. Finish/recover the claim and reconcile with sufficient evidence before reset.');
  }
  protected override beforeReviewMutation(id: ScenarioId, key: string): void {
    if (this.jobs(id).some(j => j.opportunity_key === key && protectedStates.includes(j.state))) {
      throw new ReviewError(409, 'This recovery request is in progress, accepted or unknown. Its snapshot cannot be edited or replaced. Inspect delivery activity; investigate unknown outcomes.');
    }
  }
  protected override afterRevisionChanged(id: ScenarioId, key: string, _previous: string | null, payload: RevisionPayload): void {
    const job = this.jobs(id).find(j => j.opportunity_key === key);
    if (job && protectedStates.includes(job.state)) return; // Never recall an external request by editing evidence.
    if (job) {
      const facts = [...payload.opportunity.delivery.blockers, ...payload.opportunity.reasons].map(r => r.message).join(' ');
      this.stop(id, job, `Blocked before sending: approval or eligibility changed. ${facts}`);
    }
    this.ledger().reserveOrCancel(id, key, payload.opportunity.delivery.readiness === 'checks_satisfied' ? payload.proposal?.offer.promoCode ?? null : null);
  }
  protected override afterApproval(id: ScenarioId, key: string, revisionId: string, payload: RevisionPayload): void {
    const decision = this.rows('SELECT decision_id FROM review_decisions WHERE tenant_id = ? AND scenario_id = ? AND revision_id = ? AND kind = ? AND payload_hash = ?',
      this.context.tenantId, id, revisionId, 'approve', hash(payload));
    if (!decision.length || !payload.proposal) throw new ReviewError(409, 'An exact persisted approval is required before queueing.');
    const o = payload.opportunity;
    let job = this.jobs(id).find(j => j.subject_key === o.subjectKey && j.match_id === o.matchId);
    if (job) {
      const old = this.binding(id, job.binding_id);
      if (old.revision_id === revisionId) return;
      if (protectedStates.includes(job.state)) throw new ReviewError(409, 'Accepted, uncertain or in-flight contact suppression prevents another recovery request, even on another channel/revision.');
      if (this.calls(id, job.dispatch_id) >= MAX_CALLS) throw new ReviewError(409, 'The bounded simulator submission limit has been reached. Investigate instead of creating another request.');
    } else {
      const jobId = randomUUID();
      this.db.prepare('INSERT INTO dispatches VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, ?)')
        .run(this.context.tenantId, id, jobId, o.subjectKey, o.matchId, key, 'queued', 'Approved snapshot awaiting an explicit simulated worker run.', this.auditClock());
      job = this.job(id, jobId);
    }
    const bindingId = randomUUID();
    const idempotencyKey = `demo-${hash([this.context.tenantId, id, this.scenario(id).generation, job.dispatch_id, revisionId])}`;
    this.db.prepare('INSERT OR IGNORE INTO dispatch_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.context.tenantId, id, bindingId, job.dispatch_id, revisionId, JSON.stringify(payload), hash(payload), idempotencyKey, this.auditClock());
    const binding = this.rows<Binding>('SELECT * FROM dispatch_bindings WHERE tenant_id = ? AND scenario_id = ? AND revision_id = ?', this.context.tenantId, id, revisionId)[0]!;
    this.db.prepare("UPDATE dispatches SET binding_id = ?, state = 'queued', explanation = ?, next_check_at = NULL, claim_token = NULL, lease_until = NULL, provider_reference = NULL, updated_at = ? WHERE tenant_id = ? AND scenario_id = ? AND dispatch_id = ?")
      .run(binding.binding_id, 'Approved exact snapshot queued. No simulator request has been made for this revision.', this.auditClock(), this.context.tenantId, id, job.dispatch_id);
    if (payload.proposal.offer.promoCode) this.ledger().activate(id, payload.proposal.offer.promoCode, revisionId);
    this.event(id, 'dispatch_queued', 'Persisted one logical recovery send with an immutable approved snapshot. Nothing was sent.', key, revisionId);
  }
  protected override readInbox(id: ScenarioId): Inbox {
    const inbox = super.readInbox(id);
    const dispatches: DispatchView[] = this.jobs(id).map(job => {
      const binding = this.binding(id, job.binding_id);
      return { id: job.dispatch_id, subjectKey: job.subject_key, matchId: job.match_id, revisionId: binding.revision_id,
        state: job.state, explanation: job.explanation, nextCheckAt: job.next_check_at, updatedAt: job.updated_at,
        mode: this.mode(id), providerReference: job.provider_reference, idempotencyKey: binding.idempotency_key,
        payload: JSON.parse(binding.payload_json) as RevisionPayload, canRetry: job.state === 'failed' && this.calls(id, job.dispatch_id) < MAX_CALLS,
        attempts: this.attempts(id, job.dispatch_id).map(a => ({ id: a.attempt_id, number: a.attempt_number, state: a.state,
          startedAt: a.started_at, evaluationAt: a.evaluation_at, callStarted: Boolean(a.call_started),
          idempotencyKey: this.binding(id, a.binding_id).idempotency_key, mode: a.mode,
          providerReference: a.provider_reference, explanation: a.explanation,
          payload: JSON.parse(this.binding(id, a.binding_id).payload_json) as RevisionPayload })) };
    });
    return { ...inbox, dispatches, promos: this.ledger().list(id), purchases: this.ledger().purchases(id), simulatorMode: this.mode(id) };
  }
  setSimulator(id: ScenarioId, generation: string, value: unknown): void {
    const mode = simulatorMode(value);
    transaction(this.db, () => {
      this.generation(id, generation);
      if (this.jobs(id).some(j => j.state === 'in_progress')) throw new ReviewError(409, 'Do not change simulator mode while a request is in progress.');
      this.db.prepare('INSERT INTO simulator_settings VALUES (?, ?, ?) ON CONFLICT (tenant_id, scenario_id) DO UPDATE SET mode = excluded.mode')
        .run(this.context.tenantId, id, mode);
      this.event(id, 'simulator_configured', `Selected synthetic simulator mode ${mode} for this scenario. This does not retry or reconcile any request.`);
    });
  }
  /** Only advance the injected clock; never relabel old evidence as fresh. */
  advanceClock(id: ScenarioId, generation: string, minutes: number): void {
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 10_080) throw new ReviewError(422, 'Advance the demo clock by one minute to seven days.');
    transaction(this.db, () => {
      this.generation(id, generation);
      const at = new Date(timestamp(this.input(id).clock.now()) + minutes * 60_000).toISOString();
      this.db.prepare('UPDATE scenarios SET evaluation_at = ? WHERE tenant_id = ? AND scenario_id = ?').run(at, this.context.tenantId, id);
      this.event(id, 'demo_clock_advanced', `Advanced the scenario clock ${minutes} minutes without refreshing evidence.`);
      this.sync(id);
    });
  }
  private checkingInput(id: ScenarioId, ownJobId: string): EvaluationInput {
    const input = this.input(id);
    const jobs = this.jobs(id).filter(j => protectedStates.includes(j.state));
    const contacts = input.evidence.contacts.filter(c => {
      const dispatchId = (c as Contact & { dispatchId?: string }).dispatchId;
      return dispatchId !== ownJobId && !jobs.some(j => j.dispatch_id === dispatchId);
    });
    for (const job of jobs) {
      if (job.dispatch_id !== ownJobId) contacts.push({ tenantId: this.context.tenantId,
        subjectKey: job.subject_key, matchId: job.match_id, at: this.attempts(id, job.dispatch_id).at(-1)!.evaluation_at,
        kind: 'recovery', state: job.state === 'in_progress' ? 'pending' : job.state === 'accepted' ? 'accepted' : 'unknown' });
    }
    return { ...input, evidence: { ...input.evidence, contacts } };
  }
  private freshCheck(id: ScenarioId, job: Job, binding: Binding): { kind: 'ready' | 'quiet' | 'blocked'; explanation: string } {
    const row = this.opportunities(id).find(o => o.opportunity_key === job.opportunity_key);
    const payload = JSON.parse(binding.payload_json) as RevisionPayload;
    if (!row || row.review_status !== 'approved' || row.current_revision_id !== binding.revision_id || row.approved_revision_id !== binding.revision_id || !payload.proposal ||
        !this.rows('SELECT decision_id FROM review_decisions WHERE tenant_id = ? AND scenario_id = ? AND revision_id = ? AND kind = ? AND payload_hash = ?',
          this.context.tenantId, id, binding.revision_id, 'approve', binding.payload_hash).length) return { kind: 'blocked', explanation: 'The exact current approval is missing or stale. Review the new draft; this request was not sent.' };
    const input = this.checkingInput(id, job.dispatch_id);
    if (payload.proposal.offer.promoCode) {
      try { this.ledger().requireActiveForDispatch(id, payload.proposal.offer.promoCode, binding.revision_id); }
      catch (error) { return { kind: 'blocked', explanation: error instanceof Error ? error.message : 'The approved promo is no longer active.' }; }
    }
    if (timestamp(input.clock.now()) >= timestamp(payload.proposal.offer.expiresAt)) return { kind: 'blocked', explanation: 'The approved offer has expired. No simulator call was made.' };
    const current = evaluate(input).find(o => o.key === job.opportunity_key);
    if (!current) return { kind: 'blocked', explanation: 'Current source evidence for this recovery opportunity is missing.' };
    const selectedInput = { ...input, evidence: { ...input.evidence, opportunities: input.evidence.opportunities.map(o =>
      o.subjectKey === job.subject_key && o.tenantId === this.context.tenantId && o.matchId === job.match_id ? { ...o, preferredChannel: payload.proposal!.channel } : o) } };
    const selected = evaluate(selectedInput).find(o => o.key === job.opportunity_key)!;
    if (selected.status !== 'recommend' || selected.proposedChannel !== payload.proposal.channel ||
        selected.delivery.blockers.some(b => b.code !== 'QUIET_HOURS')) return { kind: 'blocked', explanation:
      `Fresh checks block this approved request: ${[...selected.reasons, ...selected.delivery.blockers].map(b => b.message).join(' ')}` };
    const normal = current.delivery.blockers.every(b => b.code === 'QUIET_HOURS')
      ? { ...current, delivery: { readiness: 'checks_satisfied' as const, blockers: [] } } : current;
    if (materialBasis(input, normal) !== row.basis_hash) return { kind: 'blocked', explanation: 'Material recipient, source, commercial or policy facts changed. A new draft and approval are required.' };
    if (selected.delivery.blockers.some(b => b.code === 'QUIET_HOURS')) return { kind: 'quiet', explanation: 'Deferred for recipient quiet hours. The approved job and exact snapshot are preserved; no attempt was made.' };
    try {
      const rendered = this.renderProposal(id, input, current, proposalEdit(payload.proposal));
      if (canonical(rendered) !== canonical(payload.proposal)) return { kind: 'blocked', explanation: 'The approved recipient, channel, message or commercial terms no longer match. Require a new revision and approval.' };
    } catch (error) { return { kind: 'blocked', explanation: error instanceof Error ? error.message : 'Current approved terms are no longer eligible.' }; }
    return { kind: 'ready', explanation: 'Fresh individual engine, approval and exact-snapshot checks passed.' };
  }
  private nextOpening(id: ScenarioId, job: Job): string | null {
    const input = this.input(id);
    const zone = input.evidence.opportunities.find(o => o.subjectKey === job.subject_key && o.matchId === job.match_id)?.recipientTimeZone;
    if (!zone) return null;
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' });
    const now = timestamp(input.clock.now());
    for (let offset = 1; offset <= 26 * 60; offset += 1) {
      const next = Math.floor(now / 60_000) * 60_000 + offset * 60_000;
      const hour = Number(formatter.format(next));
      if (hour >= input.policy.quietHours.startHour && hour < input.policy.quietHours.endHour) return new Date(next).toISOString();
    }
    return null;
  }
  private stop(id: ScenarioId, job: Job, explanation: string): void {
    this.db.prepare("UPDATE dispatches SET state = 'blocked', explanation = ?, claim_token = NULL, lease_until = NULL, next_check_at = NULL, updated_at = ? WHERE tenant_id = ? AND scenario_id = ? AND dispatch_id = ?")
      .run(explanation, this.auditClock(), this.context.tenantId, id, job.dispatch_id);
    this.ledger().reserveOrCancel(id, job.opportunity_key, null);
  }
  claimNext(id: ScenarioId, generation: string, dispatchId?: string, expectedRevisionId?: string): Claim | null {
    this.recoverClaims(id, generation);
    return transaction(this.db, () => {
      this.generation(id, generation); this.sync(id);
      const job = dispatchId ? this.job(id, dispatchId) : this.jobs(id).find(j => j.state === 'queued');
      if (!job) return null;
      const binding = this.binding(id, job.binding_id);
      if (expectedRevisionId !== undefined && expectedRevisionId !== binding.revision_id) throw new ReviewError(409, 'This queued snapshot changed. Reload delivery activity.');
      if (job.state !== 'queued') return null;
      const check = this.freshCheck(id, job, binding);
      if (check.kind === 'quiet') {
        this.db.prepare('UPDATE dispatches SET explanation = ?, next_check_at = ?, updated_at = ? WHERE tenant_id = ? AND scenario_id = ? AND dispatch_id = ?')
          .run(check.explanation, this.nextOpening(id, job), this.auditClock(), this.context.tenantId, id, job.dispatch_id);
        return null;
      }
      if (check.kind === 'blocked' || this.calls(id, job.dispatch_id) >= MAX_CALLS) {
        this.stop(id, job, check.kind === 'blocked' ? check.explanation : 'Bounded submission limit reached; investigate.');
        this.event(id, 'dispatch_blocked', check.explanation, job.opportunity_key, binding.revision_id);
        return null;
      }
      const token = randomUUID(); const attemptId = randomUUID(); const at = this.auditClock();
      const number = (this.attempts(id, job.dispatch_id).at(-1)?.attempt_number ?? 0) + 1;
      const evaluationAt = this.input(id).clock.now(); const mode = this.mode(id);
      this.db.prepare("UPDATE dispatches SET state = 'in_progress', claim_token = ?, lease_until = ?, explanation = ?, updated_at = ? WHERE tenant_id = ? AND scenario_id = ? AND dispatch_id = ? AND state = 'queued'")
        .run(token, new Date(timestamp(at) + LEASE_MS).toISOString(), 'Worker atomically claimed the immutable approved request.', at, this.context.tenantId, id, job.dispatch_id);
      this.db.prepare('INSERT INTO dispatch_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?)')
        .run(this.context.tenantId, id, attemptId, job.dispatch_id, binding.binding_id, number, 'in_progress', at, evaluationAt, mode, 'Claimed; provider-call boundary has not been crossed.');
      this.event(id, 'dispatch_claimed', 'A worker claimed this exact request. Edits cannot replace it while in flight.', job.opportunity_key, binding.revision_id);
      return { scenario: id, dispatchId: job.dispatch_id, bindingId: binding.binding_id, token, attemptId,
        payload: JSON.parse(binding.payload_json) as RevisionPayload, idempotencyKey: binding.idempotency_key, mode, evaluationAt };
    });
  }
  /** Exposed for crash/interleaving tests. The API only calls runQueued, never accepts a client claim. */
  callClaim(claim: Claim): SimulatedResult | null {
    const allowed = transaction(this.db, () => {
      const job = this.job(claim.scenario, claim.dispatchId);
      if (job.state !== 'in_progress' || job.claim_token !== claim.token || job.binding_id !== claim.bindingId || !job.lease_until || timestamp(job.lease_until) <= timestamp(this.auditClock())) return null;
      if (this.attempts(claim.scenario, job.dispatch_id).find(a => a.attempt_id === claim.attemptId)?.call_started) return null;
      const binding = this.binding(claim.scenario, claim.bindingId);
      const check = this.freshCheck(claim.scenario, job, binding);
      if (check.kind !== 'ready') {
        if (check.kind === 'quiet') this.db.prepare("UPDATE dispatches SET state = 'queued', claim_token = NULL, lease_until = NULL, explanation = ?, next_check_at = ? WHERE tenant_id = ? AND scenario_id = ? AND dispatch_id = ?")
          .run(check.explanation, this.nextOpening(claim.scenario, job), this.context.tenantId, claim.scenario, job.dispatch_id);
        else this.stop(claim.scenario, job, check.explanation);
        this.db.prepare("UPDATE dispatch_attempts SET state = 'blocked', explanation = ? WHERE tenant_id = ? AND scenario_id = ? AND attempt_id = ?")
          .run(check.explanation, this.context.tenantId, claim.scenario, claim.attemptId);
        this.event(claim.scenario, 'dispatch_blocked', check.explanation, job.opportunity_key, binding.revision_id);
        return null;
      }
      const evaluationAt = this.input(claim.scenario).clock.now();
      this.db.prepare('UPDATE dispatch_attempts SET call_started = 1, evaluation_at = ?, explanation = ? WHERE tenant_id = ? AND scenario_id = ? AND attempt_id = ?')
        .run(evaluationAt, 'Durable provider-call boundary entered; a crash from here must be treated as potentially accepted.', this.context.tenantId, claim.scenario, claim.attemptId);
      return evaluationAt;
    });
    if (!allowed) return null;
    return this.simulator().send(claim.scenario, claim.idempotencyKey, claim.payload, claim.mode, allowed);
  }
  finishClaim(claim: Claim, result: SimulatedResult): void {
    transaction(this.db, () => {
      const job = this.job(claim.scenario, claim.dispatchId);
      if (job.state !== 'in_progress' || job.claim_token !== claim.token || job.binding_id !== claim.bindingId) return;
      this.db.prepare('UPDATE dispatches SET state = ?, provider_reference = ?, explanation = ?, claim_token = NULL, lease_until = NULL, updated_at = ? WHERE tenant_id = ? AND scenario_id = ? AND dispatch_id = ?')
        .run(result.state, result.providerReference, result.explanation, this.auditClock(), this.context.tenantId, claim.scenario, job.dispatch_id);
      this.db.prepare('UPDATE dispatch_attempts SET state = ?, provider_reference = ?, explanation = ? WHERE tenant_id = ? AND scenario_id = ? AND attempt_id = ?')
        .run(result.state, result.providerReference, result.explanation, this.context.tenantId, claim.scenario, claim.attemptId);
      if (result.state === 'accepted' || result.state === 'unknown') this.rememberContact(claim.scenario, job, result.state,
        this.attempts(claim.scenario, job.dispatch_id).find(a => a.attempt_id === claim.attemptId)!.evaluation_at);
      this.event(claim.scenario, `dispatch_${result.state}`, result.explanation, job.opportunity_key, this.binding(claim.scenario, claim.bindingId).revision_id);
    });
  }
  runQueued(id: ScenarioId, generation: string, dispatchId?: string, expectedRevisionId?: string): number {
    this.recoverClaims(id, generation);
    let attempted = 0;
    // Snapshot IDs: quiet-hour deferrals cannot spin or add newly queued requests to this run.
    const candidates = dispatchId ? [dispatchId] : this.jobs(id).filter(j => j.state === 'queued').map(j => j.dispatch_id);
    for (const candidate of candidates) {
      const claim = this.claimNext(id, generation, candidate, expectedRevisionId);
      if (!claim) continue;
      const result = this.callClaim(claim);
      if (result) { this.finishClaim(claim, result); attempted += 1; }
    }
    return attempted;
  }
  private rememberContact(id: ScenarioId, job: Job, state: 'accepted' | 'unknown', at: string): void {
    const input = this.input(id);
    const contacts = input.evidence.contacts.filter(c => (c as Contact & { dispatchId?: string }).dispatchId !== job.dispatch_id);
    const contact: Contact & { dispatchId: string } = { tenantId: this.context.tenantId, subjectKey: job.subject_key,
      matchId: job.match_id, at, kind: 'recovery', state, dispatchId: job.dispatch_id };
    contacts.push(contact);
    this.db.prepare('UPDATE scenarios SET input_json = ? WHERE tenant_id = ? AND scenario_id = ?')
      .run(JSON.stringify({ carts: input.carts, policy: input.policy, evidence: { ...input.evidence, contacts } }), this.context.tenantId, id);
  }
  recoverClaims(id: ScenarioId, generation: string): number {
    return transaction(this.db, () => {
      this.generation(id, generation);
      let recovered = 0;
      for (const job of this.jobs(id)) {
        if (job.state !== 'in_progress' || !job.lease_until || timestamp(job.lease_until) > timestamp(this.auditClock())) continue;
        const explanation = 'Abandoned worker claim expired. A provider call cannot be ruled out; outcome unknown. Reconcile or investigate, never blindly retry.';
        const attempt = this.attempts(id, job.dispatch_id).at(-1)!;
        this.db.prepare("UPDATE dispatches SET state = 'unknown', claim_token = NULL, lease_until = NULL, explanation = ?, updated_at = ? WHERE tenant_id = ? AND scenario_id = ? AND dispatch_id = ?")
          .run(explanation, this.auditClock(), this.context.tenantId, id, job.dispatch_id);
        this.db.prepare("UPDATE dispatch_attempts SET state = 'unknown', explanation = ? WHERE tenant_id = ? AND scenario_id = ? AND attempt_id = ?")
          .run(explanation, this.context.tenantId, id, attempt.attempt_id);
        this.rememberContact(id, job, 'unknown', attempt.evaluation_at);
        this.event(id, 'dispatch_unknown', explanation, job.opportunity_key, this.binding(id, job.binding_id).revision_id);
        recovered += 1;
      }
      return recovered;
    });
  }
  reconcile(id: ScenarioId, generation: string, dispatchId: string): SimulatedResult {
    return transaction(this.db, () => {
      this.generation(id, generation);
      const job = this.job(id, dispatchId);
      if (job.state !== 'unknown') throw new ReviewError(409, 'Only an unknown outcome needs reconciliation. This action never submits a new message.');
      const binding = this.binding(id, job.binding_id);
      const result = this.simulator().lookup(id, binding.idempotency_key);
      this.db.prepare('UPDATE dispatches SET state = ?, explanation = ?, provider_reference = ?, updated_at = ? WHERE tenant_id = ? AND scenario_id = ? AND dispatch_id = ?')
        .run(result.state, result.explanation, result.providerReference, this.auditClock(), this.context.tenantId, id, job.dispatch_id);
      const attempt = this.attempts(id, job.dispatch_id).at(-1)!;
      this.db.prepare('UPDATE dispatch_attempts SET state = ?, explanation = ?, provider_reference = ? WHERE tenant_id = ? AND scenario_id = ? AND attempt_id = ?')
        .run(result.state, result.explanation, result.providerReference, this.context.tenantId, id, attempt.attempt_id);
      if (result.state !== 'failed') this.rememberContact(id, job, result.state, attempt.evaluation_at);
      else {
        const input = this.input(id);
        this.db.prepare('UPDATE scenarios SET input_json = ? WHERE tenant_id = ? AND scenario_id = ?').run(JSON.stringify({ carts: input.carts, policy: input.policy,
          evidence: { ...input.evidence, contacts: input.evidence.contacts.filter(c => (c as Contact & { dispatchId?: string }).dispatchId !== job.dispatch_id) } }), this.context.tenantId, id);
      }
      this.event(id, 'dispatch_reconciled', result.explanation, job.opportunity_key, binding.revision_id);
      return result;
    });
  }
  retryDefiniteFailure(id: ScenarioId, generation: string, dispatchId: string): void {
    transaction(this.db, () => {
      this.generation(id, generation);
      const job = this.job(id, dispatchId);
      if (job.state !== 'failed' || this.calls(id, dispatchId) >= MAX_CALLS) throw new ReviewError(409, 'Only a definitely failed request below the two-submission limit may be retried. Unknown/accepted/in-flight requests cannot be retried.');
      this.db.prepare("UPDATE dispatches SET state = 'queued', explanation = ?, updated_at = ? WHERE tenant_id = ? AND scenario_id = ? AND dispatch_id = ?")
        .run('Explicit bounded retry queued with the same immutable request and idempotency key; worker must recheck eligibility.', this.auditClock(), this.context.tenantId, id, dispatchId);
      this.event(id, 'dispatch_retry_queued', 'Explicit definite-failure retry queued. Same logical request/key; at most two simulator submissions.', job.opportunity_key, this.binding(id, job.binding_id).revision_id);
    });
  }
  redeem(id: ScenarioId, generation: string, request: RedemptionRequest) {
    return transaction(this.db, () => {
      this.generation(id, generation);
      const purchase = this.ledger().redeem(id, request);
      this.event(id, 'simulated_purchase', 'Simulated checkout atomically consumed one code and recorded one purchase. This is not real revenue or measured incremental lift.');
      this.sync(id);
      return purchase;
    });
  }
  cancelPromo(id: ScenarioId, generation: string, code: string): void {
    transaction(this.db, () => { this.generation(id, generation); this.ledger().cancel(id, code); this.event(id, 'promo_cancelled', 'Cancelled an unused simulated promo code.'); });
  }
  /** Same explicit evidence-change controls as review; no automatic freshness renewal. */
  override simulateChange(id: ScenarioId, generation: string, selection: Selection, change: 'purchase' | 'revoke_consent'): void {
    super.simulateChange(id, generation, selection, change);
  }
}
