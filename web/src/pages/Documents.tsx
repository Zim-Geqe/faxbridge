import { Link } from 'react-router-dom';
import { api, useApi } from '../api';
import { Empty, ErrorBox, Skeleton, StatusBadge, fmt } from '../components/ui';
import { useSession } from '../App';

export default function Documents() {
  const { session } = useSession();
  const { data, error, loading, reload } = useApi(() => api<{ documents: any[] }>('/documents'), [], 4000);
  return (
    <>
      <h1>Documents</h1>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data && <Skeleton />}
      {data && data.documents.length === 0 && (
        <Empty title="No documents yet">
          {session.user.role !== 'approver' ? <Link className="btn btn-primary" to="/new">Send your first document</Link> : <p>Documents assigned to you will appear here.</p>}
        </Empty>
      )}
      {data && data.documents.length > 0 && (
        <ul className="list">
          {data.documents.map((d) => (
            <li key={d.id}>
              <Link to={`/documents/${d.id}`} className="row-link">
                <span className="grow">
                  <strong>{d.filename}</strong>
                  <span className="muted block">To {d.recipientName}</span>
                  <span className="muted block small">{fmt(d.createdAt)}</span>
                </span>
                <StatusBadge status={d.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
