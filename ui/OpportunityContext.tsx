import { opportunityContext } from '../src/review/context.js';
import type { Inbox, ReviewItem } from '../src/review/types.js';
export default function OpportunityContext({ item, inbox, receipt, compact = false }: { item: ReviewItem; inbox: Inbox; receipt: (id: string) => void; compact?: boolean }) {
  const c = opportunityContext(item, inbox);
  if (compact) return <section className="opportunity-context compact-context" aria-label={`Context for ${item.payload.opportunity.subjectKey.replace(/^(fan|guest):/, '')}`}>
    <strong>{c.why.split('. ')[0]}</strong><p><b>Next:</b> {c.next.split('. ')[0]}</p>
    <details><summary>Facts, role & requirements</summary><OpportunityContext item={item} inbox={inbox} receipt={receipt} /></details>
  </section>;
  return <section className="opportunity-context" aria-label={`Context for ${item.payload.opportunity.subjectKey.replace(/^(fan|guest):/, '')}`}>
    <p>{c.happened}</p><strong>{c.why}</strong><p><b>Next:</b> {c.next}</p><p><b>Who resolves this:</b> {c.owner}</p><p><b>Next transition:</b> {c.transition}</p>
    {!!c.remaining.length && <details><summary>Remaining requirements ({c.remaining.length})</summary><ul>{c.remaining.map(r => <li key={r}>{r}</li>)}</ul><p>Resolving one requirement does not resolve the others.</p></details>}
    {c.receiptId && <button type="button" className="text-button" onClick={() => receipt(c.receiptId!)}>View existing receipt</button>}
  </section>;
}
