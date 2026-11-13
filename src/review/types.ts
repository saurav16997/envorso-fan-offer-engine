import type { Channel, Exposure, Opportunity } from '../domain/types.js';
import type { DispatchView, PromoView, PurchaseView, SimulatorMode } from '../outcome/types.js';

export type ScenarioId = 'original' | 'grouped' | 'promo';
export type ReviewStatus = 'draft' | 'approved' | 'rejected';
export interface DemoContext { readonly tenantId: string; readonly actorId: string }
export interface Selection { readonly revisionId: string; readonly expectedVersion: number }
export interface Edit {
  readonly channel: Channel;
  readonly offer: 'reminder' | 'promo';
  readonly percent: number | null;
  readonly introduction: string;
  readonly subject?: string;
  readonly suggestionId?: string;
}
export interface Proposal {
  readonly templateVersion: 'recovery-v1' | 'recovery-v2';
  readonly recipient: { readonly reference: string; readonly destination: string };
  readonly channel: Channel;
  readonly basket: { readonly cartId: string; readonly seats: number; readonly section: string; readonly valueCents: number };
  readonly match: { readonly id: string; readonly label: string; readonly kickoffAt: string };
  readonly offer: { readonly kind: 'reminder' | 'promo'; readonly percent: number | null;
    readonly eligibleSubtotalCents: number | null; readonly expiresAt: string; readonly terms: string;
    readonly singleUseRequired: boolean; readonly redemptionEnforced: false;
    readonly promoCode?: string; readonly simulationRedemptionEnforced?: true };
  readonly exposure: Exposure;
  readonly content: { readonly introduction: string; readonly subject: string; readonly body: string;
    readonly ctaLabel: string; readonly ctaUrl: string };
  readonly policyVersion: string;
  readonly destinationContent?: { readonly url: string; readonly body: string };
}
export interface RevisionPayload { readonly opportunity: Opportunity; readonly proposal: Proposal | null }
export interface ReviewItem {
  readonly key: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly version: number;
  readonly reviewStatus: ReviewStatus;
  readonly approvedRevisionId: string | null;
  readonly payload: RevisionPayload;
  readonly permittedChannels: readonly Channel[];
  readonly revisions: readonly { readonly id: string; readonly number: number; readonly at: string; readonly payload: RevisionPayload }[];
}
export interface CopyRecord { readonly id: string; readonly revisionId: string; readonly model: string; readonly promptVersion: string;
  readonly provider: string; readonly state: string; readonly at: string }
export interface CopyProvenance { readonly revisionId: string; readonly source: 'ai_assisted' | 'marketer_edited'; readonly generationId: string | null }
export interface AuditEvent {
  readonly id: string;
  readonly opportunityKey: string | null;
  readonly revisionId: string | null;
  readonly actorId: string;
  readonly at: string;
  readonly kind: string;
  readonly description: string;
}
export interface Inbox {
  readonly scenario: ScenarioId;
  readonly generation: string;
  readonly label: string;
  readonly description: string;
  readonly evaluationAt: string;
  readonly actorLabel: string;
  readonly tenantLabel: string;
  readonly sourceNote: string;
  readonly items: readonly ReviewItem[];
  readonly history: readonly AuditEvent[];
  readonly dispatches?: readonly DispatchView[];
  readonly promos?: readonly PromoView[];
  readonly purchases?: readonly PurchaseView[];
  readonly simulatorMode?: SimulatorMode;
  readonly copyHistory?: readonly CopyRecord[];
  readonly copyProvenance?: readonly CopyProvenance[];
}
export interface Issue { readonly revisionId: string; readonly message: string }
export class ReviewError extends Error {
  constructor(readonly status: number, message: string, readonly issues: readonly Issue[] = []) { super(message); }
}
