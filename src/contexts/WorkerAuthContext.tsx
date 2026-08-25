import { createContext, useContext, useState, ReactNode } from 'react';
import { resolveWorkerBaseUrl } from '../services/workerConfig';

// Shared worker connection state — lives above the router so it survives
// in-app navigation between pages (RealTradingBot, ExecutiveDashboard, ...).
// BOT_ADMIN_TOKEN is intentionally kept in React state only, NEVER written to
// localStorage — it is a real secret that authorizes live trading control.
// It resets on a full page reload (by design) but no longer resets just from
// switching pages, which was the actual bug: each page previously held its
// own local useState, so navigating away and back unmounted/remounted it.

interface WorkerAuthContextValue {
  baseUrl: string;
  adminToken: string;
  setBaseUrl: (url: string) => void;
  setAdminToken: (token: string) => void;
  persistBaseUrl: () => void;
}

const WorkerAuthContext = createContext<WorkerAuthContextValue | null>(null);

export function WorkerAuthProvider({ children }: { children: ReactNode }) {
  const [baseUrl, setBaseUrlState] = useState<string>(() => {
    // Purge any admin token persisted by an older build of this page.
    try { localStorage.removeItem('workerAdminToken'); } catch { /* ignore */ }
    return resolveWorkerBaseUrl();
  });
  const [adminToken, setAdminToken] = useState('');

  const setBaseUrl = (url: string) => setBaseUrlState(url);
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
