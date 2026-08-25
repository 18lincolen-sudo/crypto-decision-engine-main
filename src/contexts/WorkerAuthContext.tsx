import { createContext, useContext, useState, ReactNode } from 'react';
import { resolveWorkerBaseUrl } from '../services/workerConfig';

// Shared worker connection state — lives above the router so it survives
// in-app navigation between pages (RealTradingBot, ExecutiveDashboard, ...).
//
// BOT_ADMIN_TOKEN is persisted to localStorage on THIS device by explicit
// user request, so it only has to be entered once per browser instead of
// after every full page reload. This is a deliberate security trade-off:
// the token authorizes live trading control (start/stop real orders), and
// localStorage is readable by any script running on this origin and by
// anyone with access to this browser profile. Only opt into this on a
// device you trust. If that trade-off ever needs reverting, drop the
// localStorage read/write below and go back to a plain useState('').
const ADMIN_TOKEN_KEY = 'workerAdminToken';

interface WorkerAuthContextValue {
  baseUrl: string;
  adminToken: string;
  setBaseUrl: (url: string) => void;
  setAdminToken: (token: string) => void;
  persistBaseUrl: () => void;
}

const WorkerAuthContext = createContext<WorkerAuthContextValue | null>(null);

export function WorkerAuthProvider({ children }: { children: ReactNode }) {
  const [baseUrl, setBaseUrlState] = useState<string>(() => resolveWorkerBaseUrl());
  const [adminToken, setAdminTokenState] = useState<string>(() => {
    try { return localStorage.getItem(ADMIN_TOKEN_KEY) || ''; } catch { return ''; }
  });

  const setBaseUrl = (url: string) => setBaseUrlState(url);
  const setAdminToken = (token: string) => {
    setAdminTokenState(token);
    try {
      if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
      else localStorage.removeItem(ADMIN_TOKEN_KEY);
    } catch { /* ignore */ }
  };
  const persistBaseUrl = () => {
    try {
      localStorage.setItem('workerConfig', JSON.stringify({ baseUrl }));
    } catch { /* ignore */ }
  };

  return (
    <WorkerAuthContext.Provider value={{ baseUrl, adminToken, setBaseUrl, setAdminToken, persistBaseUrl }}>
      {children}
    </WorkerAuthContext.Provider>
  );
}

export function useWorkerAuth(): WorkerAuthContextValue {
  const ctx = useContext(WorkerAuthContext);
  if (!ctx) throw new Error('useWorkerAuth must be used within a WorkerAuthProvider');
  return ctx;
}
