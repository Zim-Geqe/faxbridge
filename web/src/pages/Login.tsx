import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError, api } from '../api';

export default function Login({ onLogin }: { onLogin: (s: any) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const state = (useLocation().state ?? {}) as { next?: string; expired?: boolean };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/auth/login', { method: 'POST', json: { email, password } });
      onLogin(await api('/me'));
      navigate(state.next && state.next !== '/login' ? state.next : '/inbox', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <h1>FaxBridge</h1>
      <p className="muted">Store-and-forward document delivery with approval and audit.</p>
      {state.expired && <div role="status" className="alert alert-warn">Your session expired. Sign in to continue where you left off.</div>}
      <form onSubmit={submit} className="card stack">
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <p role="alert" className="error">{error}</p>}
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="muted small">Demo accounts (after <code>npm run seed</code>): sender@demo.test, approver@demo.test, admin@demo.test. Password: demo1234.</p>
    </main>
  );
}
