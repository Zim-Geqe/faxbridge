import { Link } from 'react-router-dom';
import { api, useApi } from '../api';
import { Empty, ErrorBox, Skeleton, StatusBadge, fmt } from '../components/ui';

const LABEL: Record<string, string> = { approval_request: 'Approval requested', delivery_failed: 'Delivery failed, action required' };

export default function Inbox() {
  const { data, error, loading, reload } = useApi(() => api<{ items: any[]; serverTime: string }>('/inbox'), [], 5000);
  return (
    <>
      <h1>Inbox</h1>
      <p className="muted">Items that need your action.</p>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data && <Skeleton />}
      {data && data.items.length === 0 && <Empty title="Nothing needs your attention">Documents you send are under <Link to="/documents">Documents</Link>.</Empty>}
      {data && data.items.length > 0 && (
        <ul className="list">
          {data.items.map((i) => (
            <li key={i.id}>
              <Link to={`/documents/${i.document_id}`} className="row-link">
                <span className="grow">
                  <strong>{LABEL[i.type] ?? i.type}</strong>
                  <span className="muted block">{i.filename} → {i.recipient_name}</span>
                  <span className="muted block small">{fmt(i.created_at)}</span>
                </span>
                <StatusBadge status={i.document_status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
