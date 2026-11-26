import type { ReactNode } from 'react';
import { ApiError } from '../api';

const STATUS: Record<string, { label: string; icon: string; tone: string }> = {
  RECEIVED: { label: 'Received', icon: '⏳', tone: 'info' },
  PROCESSING: { label: 'Reading document', icon: '⏳', tone: 'info' },
  NEEDS_REVIEW: { label: 'Needs review', icon: '✎', tone: 'warn' },
  EXTRACTION_FAILED: { label: 'Manual entry needed', icon: '✎', tone: 'warn' },
  AWAITING_APPROVAL: { label: 'Awaiting approval', icon: '⏸', tone: 'warn' },
  APPROVED: { label: 'Approved', icon: '✔', tone: 'ok' },
  QUEUED: { label: 'Queued', icon: '⏳', tone: 'info' },
  SENDING: { label: 'Sending', icon: '➤', tone: 'info' },
  DELIVERED: { label: 'Delivered', icon: '✔', tone: 'ok' },
  REJECTED: { label: 'Rejected', icon: '✖', tone: 'bad' },
  DELIVERY_FAILED: { label: 'Delivery failed', icon: '⚠', tone: 'bad' },
  CANCELLED: { label: 'Cancelled', icon: '⊘', tone: 'muted' },
};
const SIM_STATES = new Set(['QUEUED', 'SENDING', 'DELIVERED', 'DELIVERY_FAILED']);

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, icon: '•', tone: 'muted' };
  return (
    <span className={`badge tone-${s.tone}`}>
      <span aria-hidden="true">{s.icon}</span> {s.label}
      {SIM_STATES.has(status) && <span className="sim"> · Simulated</span>}
    </span>
  );
}

export const SimBadge = () => <span className="badge tone-sim">Simulated</span>;

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="sk-row" />)}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div role="alert" className="alert alert-bad">
      <p>{error.status === 0 ? error.message : `Something went wrong: ${error.message}`}</p>
      {onRetry && <button className="btn" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children}
    </div>
  );
}

export const fmt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '');
