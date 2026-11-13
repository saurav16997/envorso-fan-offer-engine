'use client';

import { useState } from 'react';
import type { Inbox } from '../src/review/types.js';
import type { DispatchState, PromoView } from '../src/outcome/types.js';

type Command = (action: string, values?: Record<string, unknown>) => Promise<boolean>;
const labels: Record<DispatchState, string> = { queued: 'Queued · awaiting dispatch', in_progress: 'In progress · snapshot locked',
  accepted: 'Provider accepted · simulated', failed: 'Definitely failed', unknown: 'Outcome unknown', blocked: 'Blocked before sending' };
const next: Record<DispatchState, string> = {
  queued: 'Run the worker explicitly. It will recheck current evidence and this exact approval.',
  in_progress: 'Let the worker finish. After a crash, recover expired claims to unknown and investigate.',
  accepted: 'No retry. This is simulated provider acceptance, not confirmed fan delivery.',
  failed: 'A rejection before acceptance is established. At most one explicit retry is allowed after fresh checks.',
  unknown: 'Reconcile or investigate. Do not retry, create a new key, change channel or release contact suppression.',
  blocked: 'Resolve the evidence and review a fresh proposal if eligible. No simulator call was made by this blocked attempt.',
};
const money = (cents: number): string => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const at = (iso: string): string => `${new Date(iso).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
const fan = (value: string): string => value.replace(/^(fan|guest):/, '');

export default function DeliveryActivity({ data, busy, command, initialDispatchId }: { data: Inbox; busy: boolean; command: Command; initialDispatchId?: string | null }) {
  const jobs = data.dispatches ?? [];
  const [active, setActive] = useState<string | null>(initialDispatchId ?? null);
  const job = jobs.find(j => j.id === active) ?? jobs[0];
  const review = data.items.find(i => i.key === job?.payload.opportunity.key);
  const p = job?.payload.proposal;
  const promo = data.promos?.find(code => code.code === p?.offer.promoCode);
  const redeem = (code: PromoView) => command('redeem', { checkout: { code: code.code, subjectKey: code.subjectKey,
    matchId: code.matchId, section: code.section, seats: code.seats, eligibleSubtotalCents: code.subtotalCents } });
  return <div className="outcomes">
    <div className="outcome-intro"><strong>Simulation, end to end</strong><p>One approved proposal is not a send. One logical request may have several attempts. Provider acceptance is not confirmed delivery. A simulated purchase is not measured incremental revenue.</p></div>
    <div className="outcome-totals" aria-label="Simulated outcome summary">
      <div><span>Awaiting worker</span><strong>{jobs.filter(j => j.state === 'queued').length}</strong></div>
      <div><span>Provider accepted</span><strong>{jobs.filter(j => j.state === 'accepted').length}</strong></div>
      <div><span>Unknown · investigate</span><strong>{jobs.filter(j => j.state === 'unknown').length}</strong></div>
      <div><span>Simulated purchases</span><strong>{data.purchases?.length ?? 0}</strong></div>
    </div>
    <details className="outcome-controls">
      <summary>Delivery demo controls · {data.label}</summary>
      <p>These controls apply only to this isolated scenario. No network email/push request or real checkout is implemented.</p>
      <label htmlFor="simulator-outcome">Simulator outcome</label>
      <select id="simulator-outcome" value={data.simulatorMode ?? 'accepted'} disabled={busy || jobs.some(j => j.state === 'in_progress')}
        onChange={e => void command('simulator-mode', { mode: e.target.value })}>
        <option value="accepted">Accepted with a simulated receipt</option>
        <option value="rejected">Definitely rejected before acceptance</option>
        <option value="accepted_timeout">Accepted, response lost · lookup supported</option>
        <option value="unknown_timeout">Timeout · no sufficient provider evidence</option>
      </select>
      <div className="form-actions"><button className="button primary" disabled={busy || !jobs.some(j => j.state === 'queued')} onClick={() => void command('dispatch')}>Run queued delivery</button>
        <button className="button" disabled={busy || !jobs.some(j => j.state === 'in_progress')} onClick={() => void command('recover-claims')}>Recover abandoned claims</button>
        <button className="button" disabled={busy} onClick={() => void command('advance-clock', { minutes: 61 })}>Advance demo clock 61 minutes</button></div>
      <p className="field-help">Clock advancement does not refresh evidence. Claims use a separate two-minute real worker lease; expired claims become unknown, never automatic retries.</p>
    </details>
    {jobs.length ? <>
      <div className="table-scroll"><table><caption className="sr-only">Persistent simulated delivery activity for this scenario</caption><thead><tr><th>Fan / approved channel</th><th>Outcome</th><th>Attempts</th><th>Latest scenario clock</th><th>Receipt</th></tr></thead>
        <tbody>{jobs.map(j => <tr key={j.id} className={job?.id === j.id ? 'selected-row' : ''}><td><button className="fan-button" aria-pressed={job?.id === j.id} aria-label={`Inspect send ${fan(j.subjectKey)}`} onClick={() => setActive(j.id)}>{fan(j.subjectKey)} ↗</button><small>{j.payload.proposal?.channel === 'email' ? 'Email' : 'Push'} · exact approved snapshot</small></td>
          <td><span className={`dispatch-state ${j.state}`}>{labels[j.state]}</span></td><td>{j.attempts.length}</td><td><small>{j.attempts.at(-1) ? at(j.attempts.at(-1)!.evaluationAt) : 'No attempt yet'}</small></td><td>{j.providerReference ? 'Available' : j.state === 'unknown' ? 'Uncertain' : 'None'}</td></tr>)}</tbody></table></div>
      {job && p && <section className="outcome-receipt" aria-label={`Simulated receipt for ${fan(job.subjectKey)}`}>
        <div className="section-heading"><h3>{fan(job.subjectKey)} · {p.channel === 'email' ? 'Email' : 'Push'} request</h3><span className={`dispatch-state ${job.state}`}>{labels[job.state]}</span></div>
        <p className="outcome-explanation">{job.explanation}</p><p className="next-action"><strong>Next action:</strong> {job.state === 'failed' && !job.canRetry ? 'The two-submission limit is exhausted. Investigate; no further retry is allowed.' : next[job.state]}</p>
        {job.nextCheckAt && <p className="field-help">Next local-window check: {at(job.nextCheckAt)}. Fresh eligibility and evidence are still required then.</p>}
        <div className="receipt-grid"><section><h4>Exact approved message</h4><p className="recipient"><strong>To:</strong> {p.recipient.destination}</p><strong>{p.content.subject}</strong><div className="message-body">{p.content.body}</div><p>Destination: {p.content.ctaUrl} · simulated integration</p>{p.destinationContent && <section><h4>Detailed destination content</h4><div className="message-body">{p.destinationContent.body}</div></section>}</section>
          <section><h4>Persisted outcome</h4><dl className="technical"><dt>Last recorded (worker time)</dt><dd>{at(job.updatedAt)}</dd><dt>Simulated provider receipt</dt><dd>{job.providerReference ?? 'No established acceptance receipt'}</dd><dt>Fan delivery</dt><dd>Not confirmed. No real provider is connected.</dd><dt>Attempt scope</dt><dd>{data.label}; each attempt records its injected scenario clock separately.</dd></dl>
            {promo && <div className="promo-receipt"><h4>Issued simulated promo</h4><code>{promo.code}</code><p>{promo.percent}% of {money(promo.subtotalCents)} · cap {money(promo.maximumDiscountCents)}</p><p>State: <strong>{promo.state}</strong> · expires {at(promo.expiresAt)}</p><p>Single use is enforced transactionally in this simulated checkout. Real ticketing enforcement remains unimplemented.</p></div>}
            {data.purchases?.filter(order => order.code === promo?.code).map(order => <div key={order.id} className="simulated-purchase"><strong>Simulated purchase recorded</strong><p>Subtotal {money(order.subtotalCents)} · discount {money(order.discountCents)} · simulated paid amount {money(order.paidCents)}</p><small>{at(order.evaluationAt)} · no real payment or causal lift claim</small></div>)}
          </section></div>
        <details className="evidence"><summary>Attempts, immutable snapshots & technical references</summary><dl className="technical"><dt>Logical send</dt><dd>{job.id}</dd><dt>Approved revision</dt><dd>{job.revisionId}</dd><dt>Stable request key</dt><dd>{job.idempotencyKey}</dd></dl>
          {job.attempts.map(a => <details key={a.id}><summary>Attempt {a.number} · {a.state} · {at(a.evaluationAt)}</summary><p>{a.explanation}</p><p>Provider-call boundary crossed: {a.callStarted ? 'Yes · acceptance may be possible' : 'No recorded call boundary'}</p><p>Mode: {a.mode} · provider reference: {a.providerReference ?? 'unknown / not available'}</p><pre>{a.idempotencyKey}</pre><div className="message-body">{a.payload.proposal?.content.body}</div></details>)}</details>
        <details className="outcome-controls request-controls"><summary>Demo actions for {fan(job.subjectKey)}</summary>
          <p>Operator simulations, separate from marketer approval. Unknown outcomes never expose a retry action.</p><div className="form-actions">
            {job.state === 'queued' && <button className="button primary" disabled={busy} onClick={() => void command('dispatch', { dispatchId: job.id, revisionId: job.revisionId })}>Run this queued request</button>}
            {job.state === 'unknown' && <button className="button primary" disabled={busy} onClick={() => void command('reconcile', { dispatchId: job.id })}>Reconcile uncertain outcome</button>}
            {job.canRetry && <button className="button" disabled={busy} onClick={() => void command('retry-definite', { dispatchId: job.id })}>Queue one definite-failure retry</button>}
            {review && <><button className="button" disabled={busy} onClick={() => void command('demo-change', { selection: { revisionId: review.revisionId, expectedVersion: review.version }, change: 'revoke_consent' })}>Simulate consent change after approval</button>
              <button className="button" disabled={busy} onClick={() => void command('demo-change', { selection: { revisionId: review.revisionId, expectedVersion: review.version }, change: 'purchase' })}>Simulate purchase after approval</button></>}
            {promo && (promo.state === 'active' || promo.state === 'redeemed') && <button className="button" disabled={busy} onClick={() => void redeem(promo)}>{promo.state === 'redeemed' ? 'Attempt second redemption (expect rejection)' : 'Simulate promo redemption'}</button>}
          </div></details>
      </section>}
    </> : <div className="empty"><h3>Nothing queued yet</h3><p>Approve an exact eligible revision first. Approval queues a logical request; only an explicit demo worker run can attempt it.</p></div>}
  </div>;
}
