'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { Edit, Inbox, Issue, Proposal, ReviewItem, ScenarioId, Selection } from '../src/review/types.js';
import DeliveryActivity from './DeliveryActivity.js';
import CopySuggestion from './CopySuggestion.js';
import OpportunityContext from './OpportunityContext.js';

type Group = 'ready' | 'attention' | 'waiting' | 'history' | 'delivery';
const labels: Record<Group, string> = { ready: 'Ready to review', attention: 'Needs attention', waiting: 'Waiting / excluded', history: 'Review history', delivery: 'Delivery activity' };
const scenarioLabels = { original: 'Original eight carts', grouped: 'Synthetic review workload', promo: 'Synthetic promo review' };
const usd = (value: number): string => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value / 100);
const when = (value: string): string => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(value));
const auditWhen = (value: string): string => `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const reference = (i: ReviewItem): string => i.payload.opportunity.subjectKey.replace(/^(fan|guest):/, '');
const select = (i: ReviewItem): Selection => ({ revisionId: i.revisionId, expectedVersion: i.version });
function category(i: ReviewItem): Group {
  const o = i.payload.opportunity;
  if (i.reviewStatus !== 'draft') return 'history';
  if (o.status === 'hold' || (o.status === 'recommend' && o.delivery.readiness === 'blocked') || o.reasons.some(r => r.code === 'ENTITLEMENT_UNCERTAIN')) return 'attention';
  return o.status === 'recommend' ? 'ready' : 'waiting';
}
const compatible = (p: Proposal): string => [p.channel, p.match.id, p.policyVersion, p.templateVersion, p.offer.kind].join('|');
const exposure = (i: ReviewItem): string => {
  const cost = i.payload.proposal?.exposure ?? i.payload.opportunity.incentiveExposure;
  return cost.kind === 'known' ? usd(cost.maximumDiscountCents) : 'Unknown';
};
function activity(i: ReviewItem, clock: string): string {
  const minutes = Math.floor((Date.parse(clock) - Date.parse(i.payload.opportunity.latestActivityAt)) / 60_000);
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
}
function stateLabel(i: ReviewItem): string {
  if (i.reviewStatus === 'approved') return 'Approved · awaiting dispatch';
  if (i.reviewStatus === 'rejected') return 'Rejected · closed';
  return category(i) === 'ready' ? 'Ready for review' : category(i) === 'attention' ? 'Needs attention' : i.payload.opportunity.status === 'defer' ? 'Waiting' : 'Excluded';
}
const introductionEdit = (p: Proposal): Edit => ({ channel: p.channel, offer: p.offer.kind, percent: p.offer.percent, introduction: p.content.introduction, subject: p.content.subject });

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => { ref.current?.close(); before?.focus(); };
  }, []);
  return <dialog ref={ref} aria-labelledby={headingId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="dialog-header"><h2 id={headingId}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog">×</button></header>{children}
  </dialog>;
}

function Preview({ proposal, fan, revisionId }: { proposal: Proposal; fan: string; revisionId: string }) {
  const [basketOpen, setBasketOpen] = useState(false);
  const basketHeading = useRef<HTMLHeadingElement>(null);
  const basketTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!basketOpen) return; const frame = requestAnimationFrame(() => basketHeading.current?.focus()); return () => cancelAnimationFrame(frame); }, [basketOpen]);
  function returnToMessage() { setBasketOpen(false); requestAnimationFrame(() => basketTrigger.current?.focus()); }
  return <div className="preview">
    {basketOpen ? <section className="dialog-content" aria-label="Simulated basket preview" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); returnToMessage(); } }}>
      <h3 tabIndex={-1} ref={basketHeading}>Simulated basket preview</h3>
      <p>Read-only snapshot. No approval, delivery, redemption or purchase occurs here.</p>
      <dl className="technical"><dt>Fan reference</dt><dd>{fan}</dd><dt>Proposal revision</dt><dd>{revisionId}</dd>
        <dt>Source cart</dt><dd>{proposal.basket.cartId}</dd><dt>Match</dt><dd>{proposal.match.label} · {when(proposal.match.kickoffAt)} · {proposal.match.id}</dd>
        <dt>Quantity</dt><dd>{proposal.basket.seats}</dd><dt>Section</dt><dd>{proposal.basket.section}</dd><dt>Observed value</dt><dd>{usd(proposal.basket.valueCents)}</dd>
        <dt>Offer terms in this revision</dt><dd>{proposal.offer.terms}</dd>{proposal.offer.promoCode && <><dt>Promo code</dt><dd>{proposal.offer.promoCode}</dd></>}
        <dt>Offer expiration</dt><dd>{when(proposal.offer.expiresAt)}</dd></dl>
      <p>Pricing and availability are synthetic observations, not a current quote. Seats are not reserved or guaranteed adjacent. Real checkout and production deep links are not connected. Viewing terms does not establish approval or current eligibility.</p>
      <button type="button" className="button" onClick={returnToMessage}>Back to message preview</button>
    </section> : <>
    <div className="preview-meta"><span>{proposal.channel === 'email' ? 'Email preview' : 'Push preview'}</span><span>Review preview</span></div>
    <p className="recipient"><strong>To</strong> {proposal.recipient.destination}</p>
    <h4>{proposal.content.subject}</h4><div className="message-body">{proposal.content.body}</div>
    {proposal.destinationContent && <section aria-label="Detailed destination content"><h4>Detailed destination content</h4><div className="message-body">{proposal.destinationContent.body}</div><p className="fine-print">Deep-link destination: {proposal.destinationContent.url}</p></section>}
    <button type="button" ref={basketTrigger} className="preview-cta" onClick={() => setBasketOpen(true)}>{proposal.content.ctaLabel} <span aria-hidden="true">↗</span></button>
    <p className="fine-print">SIMULATION · Synthetic match, basket and permission evidence. Viewing an old preview does not establish present eligibility. Example destination and link; no working production deep link, messaging or ticketing integration. Single use is enforced only in simulated checkout. {proposal.channel === 'push' && 'Notification title/body above are the complete push; detailed content opens at the separate destination.'}</p>
    </>}
  </div>;
}

export default function InboxApp({ initial }: { initial: Inbox }) {
  const [data, setData] = useState(initial);
  const [tab, setTab] = useState<Group>('ready');
  const [receiptId, setReceiptId] = useState<string | null>(null);
  function viewReceipt(id: string) { setActiveKey(null); setEdit(null); setReceiptId(id); setTab('delivery'); }
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReviewItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<readonly Issue[]>([]);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const alert = useRef<HTMLDivElement>(null);
  const current = data.items.find(i => i.key === activeKey) ?? null;
  const counts = { ready: 0, attention: 0, waiting: 0, history: 0, delivery: data.items.filter(i => data.dispatches?.some(j => j.payload.opportunity.key === i.key)).length };
  for (const i of data.items) counts[category(i)] += 1;
  const visible = data.items.filter(i => category(i) === tab);
  const reviewEvents = data.history.filter(e => ['approved', 'rejected', 'edited', 'approval_invalidated', 'demo_evidence_changed', 'scenario_reset'].includes(e.kind));
  const readyExposure = data.items.filter(i => category(i) === 'ready').reduce((sum, i) => {
    const value = i.payload.proposal?.exposure;
    return sum + (value?.kind === 'known' ? value.maximumDiscountCents : 0);
  }, 0);

  async function load(id: ScenarioId, switching = false): Promise<void> {
    const response = await fetch(`/api/inbox?scenario=${id}`, { cache: 'no-store' });
    const body = await response.json() as Inbox & { error?: string };
    if (!response.ok) throw new Error(body.error ?? 'Could not refresh the inbox.');
    setData(body);
    if (switching) { setTab('ready'); setActiveKey(null); }
  }
  async function switchScenario(id: ScenarioId): Promise<void> {
    setBusy(true); setError(null); setNotice(null); setSelected([]); setEdit(null); setActiveKey(null);
    try { await load(id, true); window.history.replaceState(null, '', `/?scenario=${id}`); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not change scenario.'); }
    finally { setBusy(false); }
  }
  async function command(action: string, values: Record<string, unknown> = {}): Promise<boolean> {
    setBusy(true); setError(null); setNotice(null); setIssues([]);
    try {
      const response = await fetch('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, scenario: data.scenario, generation: data.generation, ...values }) });
      const result = await response.json() as { inbox?: Inbox; message?: string; error?: string; issues?: Issue[] };
      if (!response.ok || !result.inbox) {
        setError(result.error ?? 'The review could not be saved.'); setIssues(result.issues ?? []);
        await load(data.scenario); setEdit(null);
        setTimeout(() => alert.current?.focus(), 0);
        return false;
      }
      setData(result.inbox); setNotice(result.message ?? 'Saved.'); setSelected([]); setEdit(null);
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : 'The local server could not be reached. Reload before acting again.'); return false; }
    finally { setBusy(false); }
  }
  function inspect(i: ReviewItem): void { setActiveKey(i.key); setEdit(null); }
  function closeReview(): void {
    const fan = current ? reference(current) : null;
    if (current && category(current) !== tab) setTab(category(current));
    setActiveKey(null); setEdit(null);
    setTimeout(() => { if (fan) document.getElementById(`review-${fan}`)?.focus(); }, 0);
  }
  function toggle(i: ReviewItem): void {
    setSelected(items => items.some(x => x.revisionId === i.revisionId) ? items.filter(x => x.revisionId !== i.revisionId) : [...items, i]);
  }
  function batchable(i: ReviewItem): boolean {
    const p = i.payload.proposal;
    return category(i) === 'ready' && p?.offer.kind === 'reminder' && p.exposure.kind === 'known' && p.exposure.maximumDiscountCents === 0 &&
      (!selected[0]?.payload.proposal || compatible(p) === compatible(selected[0].payload.proposal));
  }
  function batchReason(i: ReviewItem): string {
    const p = i.payload.proposal;
    if (p?.offer.kind === 'promo') return 'Discounts require individual review.';
    if (category(i) !== 'ready' || !p || p.exposure.kind !== 'known' || p.exposure.maximumDiscountCents !== 0) return 'Only eligible zero-incentive reminders can join a batch.';
    if (selected[0]?.payload.proposal && compatible(p) !== compatible(selected[0].payload.proposal)) return 'Different channel, match, template or policy from the selected batch. Clear the batch to choose this row.';
    return '';
  }
  const p = current?.payload.proposal;
  const o = current?.payload.opportunity;
  const basket = p?.basket ?? (o ? (() => { const c = o.sourceCarts.find(c => c.source.cartId === o.canonicalCartId)!;
    return { cartId: c.source.cartId, seats: c.source.seats, section: c.source.section, valueCents: c.cartValueCents }; })() : null);

  return <>
    <header className="topbar"><a href="/" className="brand"><span className="brand-mark" aria-hidden="true">E<span /></span><span>ENVORSO <b>SPORTS</b></span></a>
      <div className="workspace-name"><span className="club-dot" /> Seawolves <span className="divider">/</span> Marketing</div>
      <div className="actor"><span className="avatar" aria-hidden="true">DM</span><span>Demo marketer<small>Fixed local role · no authentication</small></span></div>
    </header>
    <main id="main">
      <section className="page-heading"><div><p className="eyebrow">FAN RECOVERY</p><h1>Recovery inbox</h1><p className="subtitle">A little follow-up. A considered decision.</p></div>
        <div className="scenario-control"><label htmlFor="scenario">Demo scenario</label><select id="scenario" value={data.scenario} disabled={busy} onChange={e => void switchScenario(e.target.value as ScenarioId)}>
          {Object.entries(scenarioLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
          <span className="demo-badge"><span /> Local proof of concept · simulations only</span></div>
      </section>
      <div className="clock-strip"><span className="clock-symbol" aria-hidden="true">◷</span><strong>Paused demo clock</strong><span>{when(data.evaluationAt)}</span><span className="clock-note">Synthetic readiness evidence. No live fan activity.</span>
        <button className="text-button" disabled={busy} onClick={() => void command('process')}>↻ Reprocess evidence</button></div>
      <p className="field-help">The scenario clock is paused and differs from real time. Reprocess evidence rechecks existing records; it does not fetch fresh data. This prototype has no live refresh integration.</p>
      <section className="summary" aria-label="Daily review summary">
        <div className="summary-lead"><span className="summary-icon" aria-hidden="true">↗</span><div><strong>{counts.ready} {counts.ready === 1 ? 'recommendation needs' : 'recommendations need'} your review</strong><p>{data.scenario === 'grouped' ? 'Review routine reminders together. Give exceptions individual attention.' : 'Review the recipient, the reason and the exact message before approving.'}</p></div></div>
        <div className="metric"><span>Needs attention</span><strong>{counts.attention.toString().padStart(2, '0')}</strong></div>
        <div className="metric" aria-label="Ready-to-review discount cap"><span>Ready-to-review discount cap</span><strong>{usd(readyExposure)}</strong><small>Drafts in Ready to review only. Maximum potential discount cost, not spend, recovered revenue or total operating cost. Reminders: $0. Approved, rejected and delivered proposals are excluded.</small></div>
      </section>
      {notice && <div className="notice" role="status"><span aria-hidden="true">✓</span><span>{notice}</span><button aria-label="Dismiss success" className="icon-button" onClick={() => setNotice(null)}>×</button></div>}
      {busy && <div className="working-notice" role="status">Checking local evidence and saving the current operation…</div>}
      {error && <div className="error-message" role="alert" ref={alert} tabIndex={-1}><strong>Review needs attention</strong><p>{error}</p>
        {issues.length > 0 && <ul>{issues.map(issue => <li key={issue.revisionId}>{reference(data.items.find(i => i.revisionId === issue.revisionId) ?? selected.find(i => i.revisionId === issue.revisionId) ?? current ?? data.items[0]!)}: {issue.message}</li>)}</ul>}
        <button className="text-button" disabled={busy} onClick={async () => { setBusy(true); try { await load(data.scenario); setSelected([]); setError(null); } catch { setError('Refresh failed. Check the local server and try again.'); } finally { setBusy(false); } }}>Reload current revisions</button></div>}
      <div className="inbox-layout delivery-layout" aria-busy={busy}>
        <section className="queue" aria-label="Recommendations">
          <div className="tabs" role="tablist" aria-label="Review queues">{(Object.keys(labels) as Group[]).map(group => <button key={group} role="tab" id={`tab-${group}`} aria-selected={tab === group} aria-controls="queue-panel" disabled={busy}
            className={tab === group ? 'active' : ''} tabIndex={tab === group ? 0 : -1}
            onKeyDown={event => {
              const groups = Object.keys(labels) as Group[];
              const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
              if (!offset) return;
              event.preventDefault();
              const next = groups[(groups.indexOf(group) + offset + groups.length) % groups.length]!;
              setTab(next); setSelected([]); setEdit(null); setActiveKey(null); document.getElementById(`tab-${next}`)?.focus();
            }} onClick={() => { setTab(group); setSelected([]); setEdit(null); setActiveKey(null); }}>
            {labels[group]} <span>{counts[group]}</span></button>)}</div>
          <div className="queue-heading"><div><h2>{labels[tab]}</h2><p>{tab === 'ready' ? 'Your approval applies to this exact message and revision.' : tab === 'attention'
            ? 'Resolve these checks before approving. Permission cannot be overridden.' : tab === 'waiting' ? 'Timing and exclusions are handled by policy. No routine approval needed.' : tab === 'delivery' ? 'Durable simulated requests and receipts. Provider acceptance does not confirm fan delivery.' : 'Persisted decisions and exact revisions. Inspect delivery activity for subsequent outcomes.'}</p></div>
            <span className="queue-count">{tab === 'delivery' ? `${counts.delivery} logical requests` : `${visible.length} ${visible.length === 1 ? 'opportunity' : 'opportunities'}`}</span></div>
          {tab === 'ready' && <div className="selection-bar"><span>{selected.length ? `${selected.length} selected · $0 incentive` : 'Select compatible reminder rows for grouped review'}</span>
            <button className={selected.length ? 'button primary small' : 'button small'} disabled={busy || !selected.length} onClick={() => { setConfirmed(false); setBatchOpen(true); }}>Review selected ({selected.length})</button></div>}
          <div id="queue-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
            {tab === 'delivery' ? <DeliveryActivity key={`${data.generation}:${receiptId}`} data={data} busy={busy} command={command} initialDispatchId={receiptId} /> : visible.length > 0 ? <div className="table-scroll"><table><caption className="sr-only">{labels[tab]} for the fixed Seawolves demo tenant</caption><thead><tr>
              {tab === 'ready' && <th className="check-cell"><span className="sr-only">Select for batch</span></th>}<th>Fan / match</th><th>Basket</th><th>Latest activity</th><th>Action / channel</th><th>Incentive</th><th>Context / next step</th><th><span className="sr-only">Review status</span></th>
            </tr></thead><tbody>{visible.map(i => {
              const proposal = i.payload.proposal;
              const source = i.payload.opportunity.sourceCarts.find(c => c.source.cartId === i.payload.opportunity.canonicalCartId)!;
              const selectedRow = i.key === activeKey;
              return <tr key={i.key} className={selectedRow ? 'selected-row' : ''}>
                {tab === 'ready' && <td className="check-cell"><input type="checkbox" aria-label={`Select ${reference(i)} for batch review`} aria-describedby={batchReason(i) ? `batch-reason-${reference(i)}` : undefined} checked={selected.some(x => x.revisionId === i.revisionId)}
                  disabled={busy || !batchable(i)} onChange={() => toggle(i)} /></td>}
                <td><strong>{reference(i)}</strong><button id={`review-${reference(i)}`} className="button small row-review" onClick={() => inspect(i)} aria-label={`Review ${reference(i)}`}>Review</button>
                  {batchReason(i) && tab === 'ready' && <small id={`batch-reason-${reference(i)}`}>{batchReason(i)}</small>}
                  <small>Home match · {proposal ? when(proposal.match.kickoffAt).split(',')[0] : 'See evidence'}</small></td>
                <td><strong>{source.source.seats} {source.source.seats === 1 ? 'seat' : 'seats'} · {usd(source.cartValueCents)}</strong><small>{source.source.section}</small></td>
                <td><strong>{activity(i, data.evaluationAt)}</strong><small>{i.payload.opportunity.sourceCartIds.length} source {i.payload.opportunity.sourceCartIds.length === 1 ? 'cart' : 'carts'}</small></td>
                <td><span className={`action-label ${proposal?.offer.kind === 'promo' ? 'promo' : ''}`}>{proposal ? proposal.offer.kind === 'promo' ? `${proposal.offer.percent}% incentive` : 'Reminder only' : i.payload.opportunity.status === 'defer' ? 'Wait' : i.payload.opportunity.status === 'suppress' ? 'No contact' : 'Hold'}</span><small>{proposal ? proposal.channel === 'email' ? 'Email' : 'Push' : 'No channel selected'}</small></td>
                <td><span className="cost">{exposure(i)}</span></td><td><OpportunityContext compact item={i} inbox={data} receipt={viewReceipt} /></td><td><span className={`state-dot ${category(i)}`} title={stateLabel(i)} />{tab === 'history' ? <span className="row-status">{i.reviewStatus === 'approved' ? 'Approved' : 'Rejected'}</span> : <span className="sr-only">{stateLabel(i)}</span>}</td>
              </tr>;
            })}</tbody></table></div> : <div className="empty"><span aria-hidden="true">✓</span><h3>{tab === 'ready' ? 'You’re up to date' : tab === 'history' ? 'No reviewed opportunities yet' : 'Nothing in this queue'}</h3><p>{tab === 'ready' ? 'There are no proposals waiting for approval here. Other queues remain available to inspect.' : 'Your persisted review decisions will appear here as you work.'}</p></div>}
            {tab === 'history' && <div className="history-list"><h3>Audit history · {reviewEvents.length} audit events</h3>{reviewEvents.length ? reviewEvents.map(event => <details key={event.id}><summary><span className={`audit-mark ${event.kind}`} aria-hidden="true">{event.kind === 'approved' ? '✓' : '•'}</span><span>{event.kind.replaceAll('_', ' ')}<small>{event.description}</small></span><time>{auditWhen(event.at)}</time></summary>
              <dl className="technical"><dt>Actor</dt><dd>{event.actorId}</dd><dt>Revision</dt><dd>{event.revisionId ?? 'Scenario event'}</dd></dl></details>) : <p className="muted">No review actions have been recorded in this scenario.</p>}</div>}
          </div>
          <footer className="queue-footer"><span className="shield" aria-hidden="true">◇</span> {data.sourceNote}</footer>
        </section>
        {tab !== 'delivery' && current && <Dialog title={`${reference(current)} · ${p?.channel === 'push' ? 'Push' : p ? 'Email' : 'No channel'} · ${p?.offer.kind === 'promo' ? `${p.offer.percent}% incentive` : p ? 'Reminder' : stateLabel(current)}`} onClose={closeReview}><aside className="detail-panel" aria-labelledby="detail-title">
          {error && <p role="alert">{error}</p>}
          {current && o && basket ? <>
            <div className="detail-top"><span className="eyebrow">RECOMMENDATION DETAIL</span><span className={`status-pill ${category(current)}`}>{stateLabel(current)}</span></div>
            <h2 id="detail-title" ref={detailTitle} tabIndex={-1}>{reference(current)}</h2><OpportunityContext item={current} inbox={data} receipt={viewReceipt} /><p className="detail-subtitle">{p?.match.label ?? 'Seawolves home match'}{p ? ` · ${when(p.match.kickoffAt)}` : ''}</p>
            {!edit && p && o.status === 'recommend' && o.delivery.readiness === 'checks_satisfied' && current.reviewStatus !== 'rejected' && <div className="review-actions">
              {current.reviewStatus === 'draft' ? <button className="button primary" disabled={busy} onClick={() => void command('approve', { selection: select(current) })}>Approve revision {current.revisionNumber} <span aria-hidden="true">✓</span></button>
                : <p className="approved-note">✓ Approved, awaiting dispatch. Nothing has been sent.</p>}
              <div><button className="button" disabled={busy} onClick={() => setEdit(introductionEdit(p))}>{current.reviewStatus === 'approved' ? 'Edit & create new draft' : 'Edit proposal'}</button>
                <button className="button danger-text" disabled={busy} onClick={() => { setRejectReason(''); setRejectOpen(true); }}>Reject</button></div>
            </div>}
            <p className="field-help">Inspect the complete message and any destination below before approving this exact revision.</p>
            <div className="basket-summary"><div><span>Proposed basket</span><strong>{basket.seats} {basket.seats === 1 ? 'seat' : 'seats'} · {basket.section}</strong><small>Latest source basket · {o.sourceCartIds.length} {o.sourceCartIds.length === 1 ? 'cart' : 'carts'} retained</small></div><strong>{usd(basket.valueCents)}</strong></div>
            <div className="detail-cost"><span>Maximum incentive exposure</span><strong>{exposure(current)}</strong></div>
            <details className="alternative"><summary>Why {p?.offer.kind === 'promo' ? 'individual review?' : 'not a discount?'}</summary><p>{p?.offer.kind === 'promo'
              ? 'This proposal gives away ticket margin. Inspect its exact terms and incentive exposure individually; it cannot enter reminder batch approval.'
              : o.proposedAction?.kind === 'promo' ? 'This revision was edited to a reminder. Its incentive exposure is zero; a future discount would require another revision and approval.'
                : 'A reminder is the default. A discount needs separate timing, yield, first-time-buyer and commercial eligibility. Older source activity cannot unlock a coupon after newer activity.'}</p></details>
            {p && <section className="detail-section"><div className="section-heading"><h3>Exact message preview</h3><span>Revision {current.revisionNumber}</span></div>{edit && <p className="field-help">This is the saved preview; viewing it does not establish present eligibility. Save a new draft to regenerate wording, terms and exposure.</p>}<Preview key={current.revisionId} proposal={p} fan={reference(current)} revisionId={current.revisionId} /></section>}
            {edit && p && <form className="edit-form" aria-label="Edit proposal" onSubmit={(event: FormEvent) => { event.preventDefault(); void command('edit', { selection: select(current), edit }); }}>
              <h3>Edit this proposal</h3><label htmlFor="edit-channel">Channel</label><select id="edit-channel" value={edit.channel} onChange={e => setEdit({ ...edit, channel: e.target.value as Edit['channel'] })}>{current.permittedChannels.map(channel => <option key={channel} value={channel}>{channel === 'email' ? 'Email' : 'Push'}</option>)}</select>
              <p className="field-help">The server rechecks this exact channel’s consent and destination. Invalid choices cannot be saved.</p>
              <label htmlFor="edit-offer">Offer</label><select id="edit-offer" value={edit.offer} onChange={e => setEdit({ ...edit, offer: e.target.value as Edit['offer'], percent: e.target.value === 'reminder' ? null : o.proposedAction?.kind === 'promo' ? o.proposedAction.percent : 10 })}>
                <option value="reminder">Reminder only · $0 incentive</option>{o.proposedAction?.kind === 'promo' && <option value="promo">Individually reviewed promo</option>}</select>
              {edit.offer === 'promo' && <><label htmlFor="edit-percent">Discount percentage</label><input id="edit-percent" type="number" min={1} max={o.proposedAction?.kind === 'promo' ? o.proposedAction.percent : 10} value={edit.percent ?? ''} onChange={e => setEdit({ ...edit, percent: Number(e.target.value) })} /></>}
              {edit.channel === 'email' && <><label htmlFor="edit-subject">Email subject</label><input id="edit-subject" value={edit.subject ?? p.content.subject} maxLength={70} required onChange={e => setEdit({ ...edit, subject: e.target.value })} /></>}
              <label htmlFor="edit-introduction">Message introduction</label><textarea id="edit-introduction" value={edit.introduction} maxLength={edit.channel === 'push' ? 100 : 240} rows={4} required onChange={e => setEdit({ ...edit, introduction: e.target.value })} autoFocus />
              <p className="field-help">Keep facts, numbers, URLs and offer terms in the locked sections. Free wording still needs your factual review; simple checks cannot guarantee correctness.</p>
              <CopySuggestion key={`${data.generation}:${current.revisionId}:${edit.channel}:${edit.offer}`} scenario={data.scenario} generation={data.generation} item={current} edit={edit} busy={busy} useWording={setEdit} />
              <div className="form-actions"><button className="button primary" disabled={busy} type="submit">Save new draft</button><button className="button" type="button" disabled={busy} onClick={() => setEdit(null)}>Cancel edit</button></div>
            </form>}
            {category(current) === 'attention' && <p className="attention-note">This item requires evidence resolution. Marketers cannot override missing, revoked or conflicting permission.</p>}
            <details className="evidence"><summary>Source baskets & technical evidence</summary><pre>{JSON.stringify({ reasons: o.reasons, blockers: o.delivery.blockers }, null, 2)}</pre><p>Every source basket is retained. Grouping does not claim identical baskets or add their values.</p>
              {o.sourceCarts.map(c => <div className="source-cart" key={c.source.cartId}><strong>{c.source.cartId} · {c.source.source}</strong><p>{c.source.seats} seats · {c.source.section} · {usd(c.cartValueCents)}</p><small>Shop spend: {typeof c.shopSpendCents === 'number' ? usd(c.shopSpendCents) : c.shopSpendCents === 'not_synced' ? 'Not synced' : 'Unknown'}</small><details><summary>Original source fields</summary><pre>{JSON.stringify(c.source, null, 2)}</pre></details></div>)}
              <dl className="technical"><dt>Opportunity key</dt><dd>{current.key}</dd><dt>Revision</dt><dd>{current.revisionId}</dd><dt>Policy</dt><dd>{o.policyVersion}</dd><dt>Exact latest activity</dt><dd>{o.latestActivityAt}</dd><dt>Missing information</dt><dd>{o.missingInformation.join(', ') || 'None in modeled checks'}</dd><dt>Recipient reference</dt><dd>{p?.recipient.reference ?? 'No proposal'}</dd></dl>
            </details>
            <details className="evidence"><summary>Immutable revision history ({current.revisions.length})</summary>{current.revisions.map(r => <details key={r.id}><summary>Revision {r.number} · {auditWhen(r.at)}</summary>{r.payload.proposal ? <Preview proposal={r.payload.proposal} fan={r.payload.opportunity.subjectKey.replace(/^(fan|guest):/, '')} revisionId={r.id} /> : <p>No contact proposal in this revision.</p>}<small className="raw-id">{r.id}</small></details>)}</details>
            <details className="evidence"><summary>Wording provenance & generation history</summary><p>Current source: {data.copyProvenance?.find(c => c.revisionId === current.revisionId)?.source.replaceAll('_', ' ') ?? 'template'}. Metadata records assistance, not factual correctness.</p>
              {current.revisions.map(r => <p key={r.id}>Revision {r.number}: {data.copyProvenance?.find(c => c.revisionId === r.id)?.source.replaceAll('_', ' ') ?? 'template'}</p>)}
              {data.copyHistory?.filter(g => current.revisions.some(r => r.id === g.revisionId)).map(g => <p key={g.id}>{g.state} · {g.provider} · {g.model} · {g.promptVersion} · {auditWhen(g.at)}<small className="raw-id">{g.id}</small></p>)}
            </details>
            <details className="demo-controls"><summary>Local demo controls</summary><p>Change synthetic evidence to demonstrate stale review protection. These changes persist only in this scenario.</p><div className="form-actions"><button className="button small" disabled={busy} onClick={() => void command('demo-change', { selection: select(current), change: 'revoke_consent' })}>Simulate revoked consent</button><button className="button small" disabled={busy} onClick={() => void command('demo-change', { selection: select(current), change: 'purchase' })}>Simulate purchase</button></div></details>
          </> : <div className="empty"><h2 id="detail-title">Inspect a recommendation</h2><p>Choose a fan reference to see evidence and the full message preview.</p></div>}
        </aside></Dialog>}
      </div>
      <footer className="page-footer"><span>Persisted review and simulated outcomes. No real providers, checkout or payment processing.</span><button className="text-button danger-text" disabled={busy} onClick={() => { setConfirmation(''); setResetOpen(true); }}>Reset this demo scenario…</button></footer>
    </main>
    {batchOpen && <Dialog title={`Review ${selected.length} selected reminders`} onClose={() => setBatchOpen(false)}>
      <div className="dialog-content"><p>Only the exact selected revisions below will be approved. No new recipients will be added. Every selected item must pass its current checks or none will be approved.</p><div className="batch-total"><strong>{selected.length} explicit recipients</strong><strong>$0 incentive exposure</strong></div>
        {selected.map(i => <section className="batch-preview" key={i.revisionId}><h3>{reference(i)} · {i.payload.proposal?.channel === 'email' ? 'Email' : 'Push'} · revision {i.revisionNumber}</h3><Preview proposal={i.payload.proposal!} fan={reference(i)} revisionId={i.revisionId} /></section>)}
        <label className="confirmation-check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I reviewed every selected recipient and exact message preview.</label>
      </div><div className="dialog-actions"><button className="button" disabled={busy} onClick={() => setBatchOpen(false)}>Back to inbox</button><button className="button primary" disabled={busy || !confirmed} onClick={async () => { const ok = await command('batch', { selections: selected.map(select) }); if (ok) setBatchOpen(false); else { setBatchOpen(false); setSelected([]); } }}>Approve selected reminders</button></div>
    </Dialog>}
    {rejectOpen && current && <Dialog title={`Reject ${reference(current)}?`} onClose={() => setRejectOpen(false)}><form onSubmit={async e => { e.preventDefault(); if (await command('reject', { selection: select(current), reason: rejectReason || null })) setRejectOpen(false); }}>
      <div className="dialog-content"><p>This closes the opportunity. Reprocessing and restarting will preserve the rejection.</p><label htmlFor="reject-reason">Reason (optional)</label><select id="reject-reason" value={rejectReason} onChange={e => setRejectReason(e.target.value)}><option value="">No reason supplied</option><option value="not_relevant">Not relevant</option><option value="prefer_no_contact">Prefer no contact</option><option value="data_concern">Data concern</option><option value="other">Other</option></select></div>
      <div className="dialog-actions"><button className="button" type="button" disabled={busy} onClick={() => setRejectOpen(false)}>Cancel</button><button className="button danger" disabled={busy} type="submit">Reject opportunity</button></div></form></Dialog>}
    {resetOpen && <Dialog title="Reset this scenario?" onClose={() => setResetOpen(false)}><form onSubmit={async e => { e.preventDefault(); if (await command('reset', { confirmation })) { setResetOpen(false); setActiveKey(null); setTab('ready'); } }}>
      <div className="dialog-content"><p>This permanently deletes recommendations, approvals, rejections and history for <strong>{data.label}</strong> in this tenant, then seeds a new generation. Other scenarios stay unchanged. Old tabs become stale.</p><label htmlFor="reset-confirmation">Type RESET {data.scenario} to confirm</label><input id="reset-confirmation" autoComplete="off" value={confirmation} onChange={e => setConfirmation(e.target.value)} /></div>
      {data.dispatches?.some(j => j.state === 'in_progress' || j.state === 'unknown') && <p className="error-message">This scenario has an in-progress or unknown outcome. Reset cannot release its contact suppression. Reconcile or investigate first.</p>}
      <div className="dialog-actions"><button className="button" type="button" onClick={() => setResetOpen(false)}>Cancel</button><button className="button danger" disabled={busy || confirmation !== `RESET ${data.scenario}` || data.dispatches?.some(j => j.state === 'in_progress' || j.state === 'unknown')} type="submit">Delete history & reset scenario</button></div></form></Dialog>}
  </>;
}
