import type { RevisionPayload } from '../review/types.js';

export type SimulatorMode = 'accepted' | 'rejected' | 'accepted_timeout' | 'unknown_timeout';
export type DispatchState = 'queued' | 'in_progress' | 'accepted' | 'failed' | 'unknown' | 'blocked';
export interface AttemptView {
  readonly id: string; readonly number: number; readonly state: string; readonly startedAt: string;
  readonly evaluationAt: string; readonly callStarted: boolean; readonly idempotencyKey: string;
  readonly providerReference: string | null; readonly explanation: string; readonly mode: SimulatorMode;
  readonly payload: RevisionPayload;
}
export interface DispatchView {
  readonly id: string; readonly subjectKey: string; readonly matchId: string; readonly revisionId: string;
  readonly state: DispatchState; readonly explanation: string; readonly nextCheckAt: string | null;
  readonly updatedAt: string; readonly mode: SimulatorMode; readonly providerReference: string | null;
  readonly idempotencyKey: string; readonly payload: RevisionPayload; readonly attempts: readonly AttemptView[];
  readonly canRetry: boolean;
}
export interface PromoView {
  readonly code: string; readonly subjectKey: string; readonly matchId: string; readonly section: string;
  readonly seats: number; readonly percent: number; readonly subtotalCents: number; readonly maximumDiscountCents: number;
  readonly expiresAt: string; readonly state: 'reserved' | 'active' | 'redeemed' | 'cancelled';
}
export interface PurchaseView {
  readonly id: string; readonly code: string; readonly subjectKey: string; readonly matchId: string;
  readonly subtotalCents: number; readonly discountCents: number; readonly paidCents: number; readonly evaluationAt: string;
}
export interface RedemptionRequest {
  readonly code: string; readonly subjectKey: string; readonly matchId: string; readonly section: string;
  readonly seats: number; readonly eligibleSubtotalCents: number;
}
export interface Claim {
  readonly scenario: import('../review/types.js').ScenarioId; readonly dispatchId: string; readonly bindingId: string;
  readonly token: string; readonly attemptId: string; readonly payload: RevisionPayload;
  readonly idempotencyKey: string; readonly mode: SimulatorMode; readonly evaluationAt: string;
}
export type SimulatedResult = { readonly state: 'accepted' | 'failed' | 'unknown'; readonly providerReference: string | null; readonly explanation: string };
