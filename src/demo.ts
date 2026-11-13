import { evaluate } from './domain/engine.js';
import { agedPromoScenario, originalSample } from './fixtures/scenarios.js';

for (const [label, input] of [
  ['Original observations + SYNTHETIC operational evidence', originalSample()],
  ['Separate SYNTHETIC promo scenario: clock +24h; fresh explicit commercial allowance', agedPromoScenario()],
] as const) {
  console.log(`\n${label}\nClock: ${input.clock.now()}. No approval or send is performed.`);
  console.table(evaluate(input).map(o => ({ carts: o.sourceCartIds.join(', '), tenant: o.tenantId,
    fan: o.subjectKey, latestActivity: o.latestActivityAt, decision: o.status,
    action: o.proposedAction?.kind ?? 'none', channel: o.proposedChannel ?? 'none',
    incentiveCents: o.incentiveExposure.kind === 'known' ? o.incentiveExposure.maximumDiscountCents : 'unknown',
    deliveryChecks: o.delivery.readiness, reasons: o.reasons.map(r => r.code).join(', '),
  })));
}
