import { randomUUID } from 'node:crypto';
import { OutcomeStore } from '../outcome/store.js';
import { transaction } from '../review/database.js';
import { ReviewError } from '../review/types.js';
import { proposalEdit } from '../review/proposal.js';
import type { Edit, Inbox, ScenarioId, Selection } from '../review/types.js';
import { copyContext, LIMITS, PROMPT_VERSION, validateWording } from './policy.js';
import type { Wording } from './policy.js';
import { copyConfig } from './provider.js';
import type { CopyConfig, GenerationState } from './provider.js';

interface Generation { generation_id: string; revision_id: string; channel: 'email' | 'push'; offer_kind: string;
  state: GenerationState | 'pending'; wording_json: string | null; model: string; prompt_version: string; provider: string; started_at: string }
export interface Suggestion { id: string; outcome: GenerationState; wording: Wording | null; fixture: boolean; message: string }
export const generationMessages: Record<GenerationState, string> = {
  suggested: 'Suggestion ready for your factual review. Nothing was saved, approved or sent.',
  unavailable: 'Optional AI drafting is not configured. Your existing wording and templates remain usable.',
  timeout: 'Drafting timed out. Your wording is unchanged; no automatic retry was made.',
  refused: 'The model declined to draft. Your wording is unchanged; use the template or edit manually.',
  incomplete: 'The model did not complete a usable draft. Your wording is unchanged.',
  invalid: 'The suggestion failed wording checks and was discarded. Your wording is unchanged.',
  error: 'Drafting was unavailable. Your wording is unchanged; use the template or edit manually.',
  stale: 'The proposal changed during generation. This suggestion was discarded; reload and review the current revision.'
};

export class CopyStore extends OutcomeStore {
  private generationRow(id: ScenarioId, generationId: string): Generation | undefined {
    return this.rows<Generation>('SELECT * FROM copy_generations WHERE tenant_id = ? AND scenario_id = ? AND generation_id = ?', this.context.tenantId, id, generationId)[0];
  }
  protected override validateEditContext(id: ScenarioId, selection: Selection, edit: Edit): void {
    if (!edit.suggestionId) return;
    const source = this.generationRow(id, edit.suggestionId);
    if (!source || source.state !== 'suggested' || source.revision_id !== selection.revisionId || source.channel !== edit.channel || source.offer_kind !== edit.offer) {
      throw new ReviewError(409, 'This suggestion does not belong to this current revision, channel and offer. Discard it or request another.');
    }
  }
  protected override afterEditSaved(id: ScenarioId, revisionId: string, edit: Edit): void {
    const generation = edit.suggestionId ? this.generationRow(id, edit.suggestionId) : undefined;
    const wording = generation?.wording_json ? JSON.parse(generation.wording_json) as Wording : null;
    const source = wording && wording.introduction === edit.introduction.trim() &&
      (edit.channel === 'push' || wording.subject === edit.subject?.trim()) ? 'ai_assisted' : 'marketer_edited';
    this.db.prepare('INSERT INTO copy_revision_provenance VALUES (?, ?, ?, ?, ?)').run(this.context.tenantId, id, revisionId, source, generation?.generation_id ?? null);
    this.event(id, 'copy_saved', `Wording provenance: ${source}; ${generation ? `generation ${generation.generation_id}` : 'manual edit; no model generation used'}. Fresh approval is required.`, null, revisionId);
  }
  protected override readInbox(id: ScenarioId): Inbox {
    const inbox = super.readInbox(id);
    return { ...inbox, copyHistory: this.rows<Generation>('SELECT * FROM copy_generations WHERE tenant_id = ? AND scenario_id = ? ORDER BY started_at DESC', this.context.tenantId, id)
      .map(g => ({ id: g.generation_id, revisionId: g.revision_id, model: g.model, promptVersion: g.prompt_version, provider: g.provider, state: g.state, at: g.started_at })),
      copyProvenance: this.rows<{ revision_id: string; source: 'ai_assisted' | 'marketer_edited'; generation_id: string | null }>('SELECT * FROM copy_revision_provenance WHERE tenant_id = ? AND scenario_id = ?', this.context.tenantId, id)
        .map(p => ({ revisionId: p.revision_id, source: p.source, generationId: p.generation_id })) };
  }
  async suggest(id: ScenarioId, generation: string, selection: Selection, channel: 'email' | 'push', offer: 'reminder' | 'promo', config: CopyConfig = copyConfig()): Promise<Suggestion> {
    const start = transaction(this.db, () => {
      this.generation(id, generation); this.sync(id);
      const chosen = this.selected(id, selection);
      if (chosen.row.version !== selection.expectedVersion || chosen.row.review_status === 'rejected') throw new ReviewError(409, 'The proposal changed or closed. Reload before drafting.');
      this.beforeReviewMutation(id, chosen.row.opportunity_key); this.currentEligibility(id, chosen.payload);
      const base = chosen.payload.proposal!;
      const projected = this.renderProposal(id, this.input(id), chosen.payload.opportunity, { ...proposalEdit(base), channel, offer,
        percent: offer === 'reminder' ? null : base.offer.percent ?? (chosen.payload.opportunity.proposedAction?.kind === 'promo' ? chosen.payload.opportunity.proposedAction.percent : null) });
      if (!projected) throw new ReviewError(422, 'No eligible proposal for drafting.');
      const at = this.auditClock(); const now = Date.parse(at);
      // A crashed generation consumes its daily budget and expires without being resubmitted.
      this.db.prepare("UPDATE copy_generations SET state = 'timeout', finished_at = ? WHERE tenant_id = ? AND state = 'pending' AND started_at <= ?")
        .run(at, this.context.tenantId, new Date(now - 60_000).toISOString());
      const recent = this.rows<{ state: string; started_at: string }>('SELECT state, started_at FROM copy_generations WHERE tenant_id = ? ORDER BY started_at DESC', this.context.tenantId);
      if (recent.some(r => r.state === 'pending') || (recent[0] && now - Date.parse(recent[0].started_at) < LIMITS.cooldownMs)) throw new ReviewError(429, 'A wording request is already running or cooling down. Wait at least 15 seconds; your edits remain intact.');
      if (recent.filter(r => r.started_at.slice(0, 10) === at.slice(0, 10)).length >= LIMITS.dailyRequests) throw new ReviewError(429, 'The local daily wording-request limit is reached. Use the template or edit manually.');
      const requestId = randomUUID();
      this.db.prepare('INSERT INTO copy_generations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)').run(this.context.tenantId, id, requestId,
        chosen.row.opportunity_key, selection.revisionId, channel, offer, config.model, PROMPT_VERSION, config.provider, config.enabled && config.generate ? 'pending' : 'unavailable', at);
      this.event(id, 'copy_requested', `Optional wording request recorded; ${config.provider}; ${PROMPT_VERSION}. No review or dispatch action.`, chosen.row.opportunity_key, selection.revisionId);
      return { requestId, context: copyContext(projected) };
    });
    let outcome: GenerationState = 'unavailable'; let wording: Wording | null = null;
    if (config.enabled && config.generate) {
      const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([config.generate(start.context, abort.signal), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { abort.abort(); reject(new Error('timeout')); }, LIMITS.timeoutMs);
        })]);
        outcome = result.state;
        if (result.state === 'suggested') {
          try { wording = validateWording(result.value, channel); }
          catch { outcome = 'invalid'; }
        }
      } catch (error) { outcome = abort.signal.aborted || (error instanceof Error && error.name === 'APIConnectionTimeoutError') ? 'timeout' : 'error'; }
      finally { if (timer) clearTimeout(timer); }
    }
    return transaction(this.db, () => {
      // Reset, concurrent review, new evidence or a claimed send cannot make an old result applicable.
      const row = this.generationRow(id, start.requestId);
      if (!row) return { id: start.requestId, outcome: 'stale', wording: null, fixture: config.provider === 'test_fixture', message: generationMessages.stale };
      try {
        this.generation(id, generation); this.sync(id);
        const chosen = this.selected(id, selection);
        if (chosen.row.version !== selection.expectedVersion || chosen.row.review_status === 'rejected') throw new Error('stale');
        this.beforeReviewMutation(id, chosen.row.opportunity_key);
        if (row.state !== 'pending' && row.state !== 'unavailable') throw new Error('expired');
      } catch { outcome = 'stale'; wording = null; }
      this.db.prepare('UPDATE copy_generations SET state = ?, wording_json = ?, finished_at = ? WHERE tenant_id = ? AND scenario_id = ? AND generation_id = ?')
        .run(outcome, wording ? JSON.stringify(wording) : null, this.auditClock(), this.context.tenantId, id, start.requestId);
      this.event(id, 'copy_completed', `Optional wording generation outcome: ${outcome}; ${config.provider}; ${config.model}; ${PROMPT_VERSION}. No saved proposal changed.`, null, selection.revisionId);
      return { id: start.requestId, outcome, wording, fixture: config.provider === 'test_fixture', message: generationMessages[outcome] };
    });
  }
}
