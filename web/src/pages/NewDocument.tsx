import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, useApi } from '../api';

export default function NewDocument({ online }: { online: boolean }) {
  const navigate = useNavigate();
  const approvers = useApi(() => api<{ approvers: { id: string; name: string }[] }>('/approvers'), []);
  const [file, setFile] = useState<File | null>(null);
  const [recipientName, setRecipientName] = useState('');
  const [recipientAddress, setRecipientAddress] = useState('');
  const [requiresApproval, setRequiresApproval] = useState(true);
  const [approverId, setApproverId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return setError('Choose a file to send.');
    setBusy(true);
    setError('');
    const fd = new FormData();
    fd.append('recipientName', recipientName);
    fd.append('recipientAddress', recipientAddress);
    fd.append('requiresApproval', String(requiresApproval));
    if (requiresApproval) fd.append('approverId', approverId || approvers.data?.approvers[0]?.id || '');
    fd.append('file', file);
    try {
      const r = await api<{ id: string }>('/documents', { method: 'POST', body: fd });
      navigate(`/documents/${r.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed');
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Send a document</h1>
      <form onSubmit={submit} className="card stack" aria-describedby="sim-note">
        <label>
          Document (PDF, PNG, JPEG or text, up to 10 MB)
          <input type="file" accept=".pdf,.png,.jpg,.jpeg,.txt,application/pdf,image/png,image/jpeg,text/plain" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        </label>
        <label>
          Recipient name
          <input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} required maxLength={200} />
        </label>
        <label>
          Recipient number or address
          <input value={recipientAddress} onChange={(e) => setRecipientAddress(e.target.value)} required maxLength={200} aria-describedby="addr-help" />
          <span id="addr-help" className="muted small block">
            Simulated mode: include <code>busy</code>, <code>slow</code>, <code>ambiguous</code>, <code>down</code> or <code>reject</code> to script a failure scenario.
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} />
          Requires approval before sending
        </label>
        {requiresApproval && (
          <label>
            Approver
            <select value={approverId} onChange={(e) => setApproverId(e.target.value)} required>
              {approvers.data?.approvers.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            {approvers.data?.approvers.length === 0 && <span className="error block">No approvers exist in your organisation.</span>}
          </label>
        )}
        <p id="sim-note" className="muted small">Delivery is simulated. Nothing leaves this system.</p>
        {error && <p role="alert" className="error">{error}</p>}
        <button className="btn btn-primary" disabled={busy || !online}>{busy ? 'Uploading…' : online ? 'Upload and read document' : 'Offline'}</button>
      </form>
    </>
  );
}
