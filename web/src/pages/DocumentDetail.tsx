import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api, useApi } from '../api';
import { ErrorBox, Skeleton, StatusBadge, fmt } from '../components/ui';

const TERMINAL = new Set(['DELIVERED', 'REJECTED', 'CANCELLED']);
const STEPS = ['RECEIVED', 'NEEDS_REVIEW', 'AWAITING_APPROVAL', 'QUEUED', 'DELIVERED'];
const STEP_LABEL: Record<string, string> = { RECEIVED: 'Received', NEEDS_REVIEW: 'Reviewed', AWAITING_APPROVAL: 'Approved', QUEUED: 'Queued', DELIVERED: 'Delivered' };

function stepIndex(status: string, requiresApproval: boolean) {
  const order: Record<string, number> = {
    RECEIVED: 0, PROCESSING: 0, NEEDS_REVIEW: 1, EXTRACTION_FAILED: 1, AWAITING_APPROVAL: 2, APPROVED: 3,
    QUEUED: 3, SENDING: 3, DELIVERY_FAILED: 3, DELIVERED: 5, REJECTED: 2, CANCELLED: 3,
  };
  return order[status] ?? 0;
}

export default function DocumentDetail({ online }: { online: boolean }) {
  const { id } = useParams();
  const { data, error, loading, reload } = useApi(
    () => api<any>(`/documents/${id}`),
    [id],
    (d) => (d && TERMINAL.has(d.document.status) ? undefined : 2000),
  );
  if (error && !data) return error.status === 404 ? <p role="alert">This document does not exist or you do not have access. <Link to="/documents">Back to documents</Link></p> : <ErrorBox error={error} onRetry={reload} />;
  if (loading && !data) return <Skeleton rows={6} />;
  if (!data) return null;
  const { document: doc, extraction, delivery, approval, permissions, timeline } = data;

  return (
    <>
      <p><Link to="/documents">← Documents</Link></p>
      <div className="head">
        <div>
          <h1>{doc.filename}</h1>
          <p className="muted">To {doc.recipientName} · {doc.recipientAddress}</p>
        </div>
        <span aria-live="polite"><StatusBadge status={doc.status} /></span>
      </div>
      {error && <div role="alert" className="alert alert-warn">Could not refresh. Showing last known state. <button className="btn" onClick={reload}>Retry</button></div>}

      <ol className="steps" aria-label="Progress">
        {STEPS.map((s, i) => {
          const cur = stepIndex(doc.status, doc.requiresApproval);
          const state = doc.status === 'REJECTED' && s === 'AWAITING_APPROVAL' ? 'bad' : i < cur ? 'done' : i === cur ? 'current' : '';
          return (
            <li key={s} className={`step ${state}`} aria-current={state === 'current' ? 'step' : undefined}>
              <span aria-hidden="true">{state === 'done' ? '✔' : state === 'bad' ? '✖' : '○'}</span>{' '}
              {s === 'AWAITING_APPROVAL' && !doc.requiresApproval ? 'No approval needed' : doc.status === 'REJECTED' && s === 'AWAITING_APPROVAL' ? 'Rejected' : STEP_LABEL[s]}
              <span className="sr-only">{state === 'done' ? ' (complete)' : state === 'current' ? ' (current)' : ''}</span>
            </li>
          );
        })}
      </ol>

      {['RECEIVED', 'PROCESSING'].includes(doc.status) && <div role="status" className="alert alert-info">Reading the document and extracting fields…</div>}

      <div className="grid2">
        <section className="card" aria-labelledby="fields-h">
          <h2 id="fields-h">Extracted information</h2>
          {extraction ? <Fields id={doc.id} extraction={extraction} canEdit={permissions.canEdit} online={online} onChanged={reload} status={doc.status} /> : <p className="muted">Not available yet.</p>}
        </section>
        <section className="card" aria-labelledby="prev-h">
          <h2 id="prev-h">Document</h2>
          <Preview doc={doc} />
          <p className="mono small">SHA-256 {doc.sha256}</p>
        </section>
      </div>

      {permissions.canDecide && <ApprovalPanel id={doc.id} online={online} onDone={reload} />}
      {approval && (
        <section className="card" aria-labelledby="appr-h">
          <h2 id="appr-h">Approval</h2>
          <p>{approval.decision === 'approved' ? 'Approved' : 'Rejected'} by {approval.decidedBy} · {fmt(approval.decidedAt)}</p>
          {approval.reason && <p>Reason: {approval.reason}</p>}
        </section>
      )}
      {delivery && <DeliveryPanel id={doc.id} delivery={delivery} canRetry={permissions.canRetry} online={online} onDone={reload} />}
      <AuditPanel id={doc.id} timeline={timeline} />
    </>
  );
}

function Fields({ id, extraction, canEdit, online, onChanged, status }: any) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [confirms, setConfirms] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = Object.keys(edits).length > 0 || Object.keys(confirms).length > 0;

  const save = async () => {
    const fields = [
      ...Object.entries(edits).map(([key, value]) => ({ key, value, confirm: true })),
      ...Object.keys(confirms).filter((k) => !(k in edits) && confirms[k]).map((key) => ({ key, confirm: true })),
    ];
    if (!fields.length) return true;
    try {
      await api(`/documents/${id}/fields`, { method: 'PATCH', json: { fields } });
      setEdits({});
      setConfirms({});
      return true;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Save failed' });
      return false;
    }
  };
  const saveClick = async () => {
    setBusy(true);
    if (await save()) { setMsg({ ok: true, text: 'Saved.' }); onChanged(); }
    setBusy(false);
  };
  const submit = async () => {
    setBusy(true);
    setMsg(null);
    if (await save()) {
      try {
        await api(`/documents/${id}/submit`, { method: 'POST' });
        onChanged();
      } catch (e) {
        setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Submit failed' });
        onChanged();
      }
    }
    setBusy(false);
  };

  return (
    <>
      <p className="muted small">Read by <code>{extraction.provider}</code>. Fields below {Math.round(extraction.threshold * 100)}% confidence must be confirmed or corrected.</p>
      <ul className="fields">
        {extraction.fields.map((f: any) => {
          const flagged = f.flagged && !confirms[f.key] && !(f.key in edits);
          return (
            <li key={f.key} className={flagged ? 'flagged' : ''}>
              <label htmlFor={`f-${f.key}`}>{f.label}</label>
              <input id={`f-${f.key}`} value={edits[f.key] ?? f.value} disabled={!canEdit || !online}
                onChange={(e) => setEdits({ ...edits, [f.key]: e.target.value })} aria-describedby={`m-${f.key}`} />
              <span id={`m-${f.key}`} className="meta small">
                {f.corrected ? <span>✎ Corrected (was “{f.original || 'empty'}”)</span> : <span>{Math.round(f.confidence * 100)}% confidence</span>}
                {flagged && <strong> · ⚠ Needs confirmation</strong>}
                {f.confirmed && !f.corrected && f.confidence < extraction.threshold && <span> · ✔ Confirmed</span>}
                {f.source && !f.corrected && <span className="muted block">Source: “{f.source}”</span>}
              </span>
              {canEdit && flagged && (
                <label className="check small"><input type="checkbox" checked={!!confirms[f.key]} onChange={(e) => setConfirms({ ...confirms, [f.key]: e.target.checked })} /> Confirm this value is correct</label>
              )}
            </li>
          );
        })}
      </ul>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? '' : 'error'}>{msg.text}</p>}
      {canEdit && (
        <div className="actions">
          <button className="btn" onClick={saveClick} disabled={busy || !pending || !online}>Save changes</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !online}>
            {status === 'EXTRACTION_FAILED' ? 'Submit manual entry' : 'Submit for approval'}
          </button>
        </div>
      )}
    </>
  );
}

function Preview({ doc }: { doc: any }) {
  const src = `/api/documents/${doc.id}/file`;
  if (doc.mime.startsWith('image/')) return <img className="preview" src={src} alt={`Preview of ${doc.filename}`} />;
  return <iframe className="preview" src={src} title={`Preview of ${doc.filename}`} sandbox="" />;
}

function ApprovalPanel({ id, online, onDone }: { id: string; online: boolean; onDone: () => void }) {
  const key = useRef(crypto.randomUUID());
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const decide = async (decision: 'approved' | 'rejected') => {
    setBusy(true);
    setMsg('');
    try {
      await api(`/documents/${id}/decision`, { method: 'POST', headers: { 'Idempotency-Key': key.current }, json: { decision, reason: reason || undefined } });
      onDone();
    } catch (e) {
      setMsg(e instanceof ApiError ? (e.status === 409 ? `Already decided. ${e.message}` : e.message) : 'Failed');
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card approval" aria-labelledby="dec-h">
      <h2 id="dec-h">Your decision</h2>
      <p>Review the extracted information and document, then decide.</p>
      {rejecting && (
        <label>Reason for rejecting (required)
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} />
        </label>
      )}
      {msg && <p role="alert" className="error">{msg}</p>}
      <div className="actions">
        {!rejecting ? (
          <>
            <button className="btn btn-primary" disabled={busy || !online} onClick={() => decide('approved')}>Approve</button>
            <button className="btn btn-danger" disabled={busy || !online} onClick={() => setRejecting(true)}>Reject…</button>
          </>
        ) : (
          <>
            <button className="btn btn-danger" disabled={busy || !online || !reason.trim()} onClick={() => decide('rejected')}>Confirm rejection</button>
            <button className="btn" onClick={() => setRejecting(false)}>Back</button>
          </>
        )}
      </div>
    </section>
  );
}

function DeliveryPanel({ id, delivery, canRetry, online, onDone }: any) {
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<any>(null);
  const [err, setErr] = useState('');
  const act = async (what: 'retry' | 'cancel') => {
    setBusy(true);
    try { await api(`/documents/${id}/delivery/${what}`, { method: 'POST' }); onDone(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); } finally { setBusy(false); }
  };
  const loadReceipt = async () => {
    try { setReceipt(await api(`/documents/${id}/receipt`)); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); }
  };
  const nextIn = delivery.status === 'retry' ? fmt(delivery.nextAttemptAt) : '';
  return (
    <section className="card" aria-labelledby="del-h">
      <h2 id="del-h">Delivery {delivery.simulated && <span className="badge tone-sim">Simulated</span>}</h2>
      {delivery.simulated && <p className="muted small">Simulated delivery. No document was transmitted to any external party.</p>}
      <p>Status: <strong>{delivery.status}</strong> · Attempts {delivery.attempts}/{delivery.maxAttempts}{nextIn && <> · Next attempt {nextIn}</>}</p>
      {delivery.lastError && <p className="error">Last error: {delivery.lastError}</p>}
      {delivery.attemptLog.length > 0 && (
        <table className="table">
          <caption className="sr-only">Delivery attempts</caption>
          <thead><tr><th>#</th><th>Started</th><th>Outcome</th><th>Detail</th></tr></thead>
          <tbody>{delivery.attemptLog.map((a: any) => <tr key={a.attempt}><td>{a.attempt}</td><td>{fmt(a.startedAt)}</td><td>{a.outcome ?? 'in progress'}</td><td>{a.error ?? ''}</td></tr>)}</tbody>
        </table>
      )}
      {err && <p role="alert" className="error">{err}</p>}
      <div className="actions">
        {canRetry && <button className="btn btn-primary" disabled={busy || !online} onClick={() => act('retry')}>Retry delivery</button>}
        {canRetry && <button className="btn btn-danger" disabled={busy || !online} onClick={() => act('cancel')}>Cancel</button>}
        {delivery.status === 'delivered' && !receipt && <button className="btn" onClick={loadReceipt}>View receipt</button>}
      </div>
      {receipt && (
        <pre className="receipt" aria-label="Delivery receipt">{[
          receipt.simulated ? '*** SIMULATED DELIVERY RECEIPT ***' : '*** DELIVERY RECEIPT ***',
          receipt.notice ?? '',
          `Document:   ${receipt.filename}`,
          `SHA-256:    ${receipt.sha256}`,
          `Recipient:  ${receipt.recipientName} (${receipt.recipientAddress})`,
          `Provider:   ${receipt.provider} ref ${receipt.providerRef}`,
          `Attempts:   ${receipt.attempts}`,
          `Delivered:  ${fmt(receipt.deliveredAt)}`,
        ].filter(Boolean).join('\n')}</pre>
      )}
    </section>
  );
}

const EVENT_LABEL: Record<string, string> = {
  'document.received': 'Document received', 'processing.started': 'Processing started', 'extraction.completed': 'Fields extracted',
  'extraction.fallback': 'AI extraction failed, fallback used', 'extraction.failed': 'Extraction failed', 'review.fields_corrected': 'Fields corrected',
  'review.submitted': 'Review submitted', 'approval.approved': 'Approved', 'approval.rejected': 'Rejected', 'delivery.queued': 'Delivery queued',
  'delivery.sending': 'Sending attempt started', 'delivery.attempt_started': 'Sending attempt started', 'delivery.accepted': 'Accepted by provider',
  'delivery.retry_scheduled': 'Retry scheduled', 'delivery.ambiguous': 'Outcome unknown, will retry safely', 'delivery.acknowledged': 'Delivery acknowledged',
  'delivery.failed': 'Delivery failed', 'delivery.retry_requested': 'Retry requested', 'delivery.cancelled': 'Cancelled', 'access.denied': 'Access denied (other user)',
  'approval.unauthorised_attempt': 'Unauthorised decision attempt',
};

function AuditPanel({ id, timeline }: { id: string; timeline: any[] }) {
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const verify = async () => {
    setBusy(true);
    setErr('');
    try { setResult(await api(`/documents/${id}/audit/verify`, { method: 'POST' })); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); } finally { setBusy(false); }
  };
  return (
    <section className="card" aria-labelledby="aud-h">
      <h2 id="aud-h">History</h2>
      <ol className="timeline">
        {timeline.map((e) => (
          <li key={e.seq}>
            <span className="muted small">{fmt(e.created_at)}</span> {EVENT_LABEL[e.type] ?? e.type}
            {e.data?.simulated && <span className="sim"> · Simulated</span>}
            {e.data?.error && <span className="muted small block">{e.data.error}</span>}
            {e.data?.reason && <span className="muted small block">Reason: {e.data.reason}</span>}
          </li>
        ))}
      </ol>
      <div className="actions"><button className="btn" onClick={verify} disabled={busy}>{busy ? 'Verifying…' : 'Verify integrity'}</button></div>
      {err && <p role="alert" className="error">{err}</p>}
      {result && (
        <div role="status" className={`alert ${result.ok ? 'alert-ok' : 'alert-bad'}`}>
          {result.ok ? `✔ Verified: ${result.events} audit events chain correctly and the stored file matches its SHA-256.` : `✖ Integrity check failed: ${result.problems.join('; ')}`}
          <p className="small muted">Tamper-evident within this system; not proof against someone with full database control.</p>
        </div>
      )}
    </section>
  );
}
