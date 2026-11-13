# Technical notes

The evaluator in src/domain validates runtime input, preserves source observations and distinguishes unknown/unsynced values from zero. Identity resolution needs explicit scoped evidence; ambiguous guest associations hold affected opportunities. One tenant/fan/match opportunity retains alternative baskets, using latest activity rather than summing values.

Hypothesis-v0.1 uses a four-hour reminder wait and expiry after seven days or two hours before kickoff. The separate promo needs at least 24 hours inactivity, low source/current sell-through, over 48 hours until kickoff, known zero account ticket history, fresh checks and commercial authorization. The 10% default remains subject to policy/commercial caps, a price floor and a 15% hard ceiling. Money uses integer cents; discounts round down. These thresholds are hypotheses, not measured optima.

ReviewStore persists scenario generations, immutable revisions, exact hashes and audit history. Compatible selected reminders are approved transactionally; discounts require individual review. Material changes invalidate approval. The UI cannot override permission. Historical previews do not establish current eligibility.

OutcomeStore atomically enqueues approval, deduplicates logical contacts and uses short fenced worker leases. Engine and snapshot checks run before local submission. Accepted/unknown/in-flight requests cannot be replaced silently. Expired claims become unknown, not presumed unsent. Explicit definite retries are bounded to two submissions; uncertainty needs provider evidence without new sends/keys. A final check cannot eliminate an external purchase/permission race after the call begins.

MessagingSimulator makes no network sends. Modes cover accepted, definitely rejected, accepted response lost and insufficient evidence. Its persistent journal is a local test contract, not a real provider retention guarantee. Promo codes appear before approval. Simulated checkout validates scope, expiry, current commercial/inventory conditions and consumes the code with one purchase transaction.

Payload v2 separates complete push notification (initial app limits: 50 title / 160 body code units) from detailed destination content. These are not universal provider limits. The local basket preview uses the exact displayed revision and ignores external URLs. Old unsent payloads become fresh drafts; historical decisions/receipts survive without reset.

CopyStore projects only club/channel/tone/offer category to optional Responses requests, excluding fan identifiers, destinations and history. Shape/length/claim/control/link validation, 12-second timeout, zero automatic retries and persisted request limits constrain drafting. The model cannot approve, send, price or redeem. Checks cannot prove factual accuracy; human review and templates remain necessary. Configuration stays server-side, with no API access required for the baseline.

Rows summarize reason/next step, with complete context available on expansion or individual Review. Batch selection is separate. The Ready-to-review discount cap includes only eligible drafts' potential maximum discount cost, not realized spend or revenue.

Production work remains: authenticated tenant access, authoritative evidence ingestion, operational owners/alerts/pause controls, provider-specific reconciliation, real ticketing/payment enforcement and broader testing. Synchronous SQLite demonstrates a bounded local workload, not production throughput.
