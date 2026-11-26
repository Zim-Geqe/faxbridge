import { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, api, setUnauthorizedHandler, useOnline, type User } from './api';
import { Skeleton } from './components/ui';
import DocumentDetail from './pages/DocumentDetail';
import Documents from './pages/Documents';
import Inbox from './pages/Inbox';
import Login from './pages/Login';
import NewDocument from './pages/NewDocument';

interface Session {
  user: User;
  provider: { name: string; simulated: boolean };
}
const SessionCtx = createContext<{ session: Session; logout: () => Promise<void> } | null>(null);
export const useSession = () => useContext(SessionCtx)!;

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const location = useLocation();
  const navigate = useNavigate();
  const online = useOnline();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession(null);
      navigate('/login', { state: { next: location.pathname, expired: true }, replace: true });
    });
  });

  useEffect(() => {
    api<Session>('/me')
      .then(setSession)
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) console.warn(e);
      })
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <main className="page"><Skeleton rows={4} /></main>;

  if (!session) {
    return (
      <Routes>
        <Route path="/login" element={<Login onLogin={(s) => setSession(s)} />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ next: location.pathname }} />} />
      </Routes>
    );
  }

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setSession(null);
    navigate('/login');
  };
  const canUpload = session.user.role !== 'approver';

  return (
    <SessionCtx.Provider value={{ session, logout }}>
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <strong className="brand">FaxBridge</strong>
        <nav aria-label="Main" className="nav">
          <NavLink to="/inbox">Inbox</NavLink>
          <NavLink to="/documents">Documents</NavLink>
          {canUpload && <NavLink to="/new">New</NavLink>}
        </nav>
        <span className="who">{session.user.name} · {session.user.role}</span>
        <button className="btn btn-quiet" onClick={logout}>Sign out</button>
      </header>
      {session.provider.simulated && (
        <div className="sim-banner" role="note">
          Simulated delivery mode: no document is transmitted to any external party.
        </div>
      )}
      {!online && <div className="offline-banner" role="status">You are offline. Showing the last loaded data; actions are unavailable.</div>}
      <main id="main" className="page">
        <Routes>
          <Route path="/" element={<Navigate to="/inbox" replace />} />
          <Route path="/login" element={<Navigate to="/inbox" replace />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/documents" element={<Documents />} />
          <Route path="/documents/:id" element={<DocumentDetail online={online} />} />
          <Route path="/new" element={canUpload ? <NewDocument online={online} /> : <Navigate to="/inbox" replace />} />
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </main>
    </SessionCtx.Provider>
  );
}
