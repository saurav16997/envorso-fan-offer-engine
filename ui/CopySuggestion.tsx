'use client';
import { useRef, useState } from 'react';
import type { Edit, ReviewItem, ScenarioId } from '../src/review/types.js';
import type { Suggestion } from '../src/copy/store.js';

export default function CopySuggestion({ scenario, generation, item, edit, busy, useWording }: {
  scenario: ScenarioId; generation: string; item: ReviewItem; edit: Edit; busy: boolean; useWording: (edit: Edit) => void;
}) {
  const [loading, setLoading] = useState(false); const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [message, setMessage] = useState<string | null>(null); const pending = useRef(false);
  async function suggest() {
    if (pending.current) return; pending.current = true; setLoading(true); setMessage(null); setSuggestion(null);
    try {
      const response = await fetch('/api/copy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        scenario, generation, selection: { revisionId: item.revisionId, expectedVersion: item.version }, channel: edit.channel, offer: edit.offer }) });
      const result = await response.json() as Suggestion & { error?: string };
      if (!response.ok) { setMessage(result.error ?? 'Drafting unavailable. Your edits are unchanged.'); return; }
      setSuggestion(result); setMessage(result.message);
    } catch { setMessage('Drafting could not be reached. Your edits are unchanged; keep the template or edit manually.'); }
    finally { pending.current = false; setLoading(false); }
  }
  return <section className="copy-drafting" aria-label="Optional wording suggestion">
    <div className="section-heading"><h4>Optional wording help</h4><button type="button" className="button small" disabled={busy || loading} onClick={() => void suggest()}>{loading ? 'Drafting wording…' : 'Suggest wording'}</button></div>
    <p className="field-help">Suggests only the subject/opening. Facts and terms stay locked. Nothing is saved, approved or sent. One request at a time, at least 15 seconds apart.</p>
    {message && <p role="status">{message}</p>}
    {suggestion?.fixture && <p className="fixture-label"><strong>TEST FIXTURE — no live AI generation</strong></p>}
    {suggestion?.wording && <div className="wording-comparison"><div><h4>Current editor wording</h4>{edit.channel === 'email' && <strong>{edit.subject}</strong>}<p>{edit.introduction}</p></div>
      <div><h4>{suggestion.fixture ? 'Synthetic test suggestion' : 'AI suggestion · review required'}</h4>{suggestion.wording.subject && <strong>{suggestion.wording.subject}</strong>}<p>{suggestion.wording.introduction}</p></div>
      <div className="form-actions"><button className="button" type="button" disabled={busy} onClick={() => { useWording({ ...edit, subject: suggestion.wording!.subject ?? edit.subject ?? 'Your Seawolves ticket basket', introduction: suggestion.wording!.introduction, suggestionId: suggestion.id }); setSuggestion(null); setMessage('Placed in the editor. You can edit it; Save new draft is still required.'); }}>Use suggestion in editor</button>
        <button className="button" type="button" disabled={busy} onClick={() => { setSuggestion(null); setMessage('Suggestion discarded. Your editor wording is unchanged.'); }}>Discard suggestion</button></div>
    </div>}
  </section>;
}
