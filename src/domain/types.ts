/** Literal transcription of the supplied table. No operational facts live here. */
export interface SourceCart {
  readonly cartId: string;
  readonly fanId: string;
  readonly team: string;
  readonly source: 'Web' | 'App';
  readonly match: string;
  readonly seats: number;
  readonly section: string;
  readonly sectionSold: string;
  readonly cartValue: string;
  readonly abandoned: string;
  readonly lifetimeTickets: number | 'Unknown';
  readonly lastPurchase: string;
  readonly shopSpend12Months: string;
  readonly seasonPass: 'Yes' | 'No';
  readonly emailOptIn: 'Yes' | 'No';
  readonly pushOptIn: 'Yes' | 'No';
}

export type Channel = 'email' | 'push';
export type UnknownNumber = number | 'unknown' | 'not_synced';
export interface Cart {
  readonly tenantId: string;
  readonly matchId: string;
  readonly lastActivityAt: string;
  readonly identity:
    | { readonly kind: 'fan'; readonly fanId: string }
    | { readonly kind: 'guest'; readonly contactId: string;
        readonly associatedFanIds: readonly string[]; readonly provenance: string | null };
  readonly source: SourceCart;
  /** Lossless normalizations of source fields; newer operational facts belong in evidence. */
  readonly cartValueCents: number;
  readonly sectionSoldPercent: number;
  readonly lifetimeTickets: UnknownNumber;
  readonly shopSpendCents: UnknownNumber;
}

export interface FreshEvidence {
  readonly checkedAt: string;
  readonly validUntil: string;
}
export interface ScopedSubject {
  readonly tenantId: string;
  readonly subjectKey: string;
}
export interface MatchEvidence extends FreshEvidence {
  readonly tenantId: string;
  readonly matchId: string;
  readonly kickoffAt: string;
  readonly state: 'scheduled' | 'played' | 'cancelled';
  readonly availableSeatsBySection: Readonly<Record<string, number>>;
  /** Current sell-through snapshot. Missing section data cannot authorize a promo. */
  readonly sectionSoldPercentBySection: Readonly<Record<string, number>>;
}
export interface Consent extends FreshEvidence, ScopedSubject {
  readonly channel: Channel;
  readonly purpose: 'marketing' | 'transactional';
  readonly status: 'granted' | 'revoked';
  /** Authoritative grant/revocation event time, distinct from when it was checked. */
  readonly effectiveAt: string;
  readonly provenance: string;
}
export interface Destination extends ScopedSubject {
  readonly channel: Channel;
  readonly value: string;
  readonly verifiedOwner: boolean;
  readonly status: 'usable' | 'invalid' | 'revoked';
}
export interface Contact extends ScopedSubject {
  readonly matchId: string;
  readonly at: string;
  readonly kind: 'recovery' | 'other_engine_marketing';
  readonly state: 'accepted' | 'pending' | 'unknown';
}
export interface OpportunityEvidence extends ScopedSubject, FreshEvidence {
  readonly matchId: string;
  readonly purchase: 'not_purchased' | 'purchased' | 'unknown';
  readonly recoveryHistoryComplete: boolean;
  readonly clubHistoryComplete: boolean;
  readonly entitlement: 'unknown' | 'additional_seats' | 'cart_fully_covered';
  readonly preferredChannel: Channel | null;
  readonly recipientTimeZone: string | null;
}
export interface CommercialEvidence extends ScopedSubject, FreshEvidence {
  readonly matchId: string;
  readonly cartId: string;
  readonly currency: 'USD';
  readonly eligibleSubtotalCents: number;
  readonly minimumNetCents: number;
  readonly maximumDiscountCents: number;
  readonly maximumPercent: number;
  readonly approved: boolean;
  readonly provenance: string;
}
export interface OperationalEvidence {
  readonly tenants: readonly { readonly tenantId: string; readonly active: boolean }[];
  readonly matches: readonly MatchEvidence[];
  readonly opportunities: readonly OpportunityEvidence[];
  readonly destinations: readonly Destination[];
  readonly consents: readonly Consent[];
  readonly contacts: readonly Contact[];
  readonly commercial: readonly CommercialEvidence[];
}
export interface Policy {
  readonly version: string;
  readonly minimumWaitHours: number;
  readonly maximumInactivityHours: number;
  readonly kickoffCutoffHours: number;
  readonly promoWaitHours: number;
  readonly promoPercent: number;
  readonly promoSoldBelowPercent: number;
  readonly protectYieldAtPercent: number;
  readonly promoKickoffMoreThanHours: number;
  readonly contactCooldownHours: number;
  readonly evidenceMaxAgeHours: number;
  readonly quietHours: { readonly startHour: number; readonly endHour: number };
}
export interface Explanation { readonly code: string; readonly message: string }
export type Exposure =
  | { readonly kind: 'known'; readonly currency: 'USD'; readonly maximumDiscountCents: number }
  | { readonly kind: 'unknown'; readonly explanation: string };
export type Action =
  | { readonly kind: 'reminder' }
  | { readonly kind: 'promo'; readonly percent: number; readonly singleUseRequired: true;
      readonly redemptionEnforced: false; readonly eligibleSubtotalCents: number };
export interface Opportunity {
  readonly key: string;
  readonly tenantId: string;
  readonly subjectKey: string;
  readonly matchId: string;
  readonly sourceCartIds: readonly string[];
  readonly sourceCarts: readonly Cart[];
  readonly latestActivityAt: string;
  readonly canonicalCartId: string;
  readonly status: 'recommend' | 'defer' | 'hold' | 'suppress';
  readonly proposedAction: Action | null;
  readonly proposedChannel: Channel | null;
  readonly reasons: readonly Explanation[];
  readonly missingInformation: readonly string[];
  /** A snapshot only; never an authorization to send. */
  readonly delivery: { readonly readiness: 'blocked' | 'checks_satisfied';
    readonly blockers: readonly Explanation[] };
  readonly incentiveExposure: Exposure;
  readonly nextEligibleAt: string | null;
  readonly policyVersion: string;
}
export interface EvaluationInput {
  readonly carts: readonly Cart[];
  readonly evidence: OperationalEvidence;
  readonly policy: Policy;
  readonly clock: { readonly now: () => string };
}
