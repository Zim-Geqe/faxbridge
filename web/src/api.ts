import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any = {}) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...init, headers, body, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'Network unavailable. Check your connection and try again.');
  }
  const text = await res.text();
  const data = text ? safeJson(text) : {};
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') onUnauthorized();
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data);
  }
  return data as T;
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return {};
  }
}

export interface Loaded<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/** Loads data, optionally polling. Keeps previous data visible while refreshing or when a refresh fails. */
export function useApi<T>(fn: () => Promise<T>, deps: unknown[], intervalMs?: number | ((d: T | null) => number | undefined)): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const dataRef = useRef<T | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const d = await fnRef.current();
        if (!alive) return;
        dataRef.current = d;
        setData(d);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof ApiError ? e : new ApiError(0, 'Unexpected error'));
      } finally {
        if (alive) {
          setLoading(false);
          const ms = typeof intervalMs === 'function' ? intervalMs(dataRef.current) : intervalMs;
          if (ms) timer = setTimeout(run, ms);
        }
      }
    };
    setLoading(true);
    run();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, error, loading, reload };
}

export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export interface User { id: string; name: string; email: string; role: 'sender' | 'approver' | 'admin' }
