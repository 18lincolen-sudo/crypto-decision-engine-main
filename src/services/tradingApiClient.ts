// Typed client for the local trading worker (src/workers/tradingWorker.ts or dist/worker.js).
import type { SimBotConfig } from '../hooks/useSimulationBot';
// The browser never holds the Bybit secret and never signs orders.
// Base URL comes from VITE_TRADING_API_URL (set at build time for Netlify),
// falling back to a manually configured worker URL.

export interface WorkerHealth {
  publicRequests: number;
  publicFailures: number;
  execRequests: number;
  execFailures: number;
  lastScanAt: string | null;
}

export interface WorkerDecision {
  symbol: string;
  action: string;
  side?: string;
  confidence: number;
  reason?: string;
  skipped?: string;
  [key: string]: unknown;
}

export interface WorkerSkippedSymbol {
  symbol: string;
  reason: string;
}

export interface WorkerBotState {
  testnet: boolean;
  dryRun: boolean;
  mode: string;
  riskLevel: string;
  symbols: number;
  running: boolean;
  lastScanAt: string | null;
  lastError: string | null;
  scans: number;
  decisions: WorkerDecision[];
  orders: Record<string, unknown>[];
  skippedSymbols: WorkerSkippedSymbol[];
  health: WorkerHealth;
  openedSymbols?: string[];
  maxOpenPositions?: number;
}

export interface WorkerAccountSummary {
  availableUsdt: number;
  totalUsdt: number;
  openFuturesCount: number;
  positions: { symbol: string; side: string; size: number; leverage: number; entryPrice: number }[];
}

export interface WorkerDecisionsResponse {
  decisions: WorkerDecision[];
  skippedSymbols: WorkerSkippedSymbol[];
  lastScanAt: string | null;
  lastError: string | null;
}

export interface SimBotSnapshot {
  cash: number;
  positions: unknown[];
  positionsValue: number;
  equity: number;
  trades: unknown[];
  history: unknown[];
  pending: unknown[];
  totalFees: number;
  totalSlippageCost: number;
  winRate: number;
  totalTrades: number;
  closedTrades: number;
  lastEvaluation: string;
  evaluations: unknown[];
  minConfidence: number;
  hasSavedSession: boolean;
  nextTickAt: number;
  totalLeveragedExposureUsd: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  candleCount: number;
  [key: string]: unknown;
}

export interface SimBotStateResponse {
  running: boolean;
  config: SimBotConfig;
  snapshot: SimBotSnapshot | null;
  leaderId: string | null;
  leaderHeartbeat: number;
  updatedAt: number;
  epoch: number;
}

export interface TradingApiClient {
  baseUrl: string;
  getHealth(): Promise<Record<string, unknown>>;
  getState(): Promise<WorkerBotState>;
  getAccountSummary(): Promise<WorkerAccountSummary>;
  getDecisions(): Promise<WorkerDecisionsResponse>;
  start(): Promise<WorkerBotState>;
  stop(): Promise<WorkerBotState>;
}

// ── Shared Simulation Bot API (public, no admin token) ────────────────────────
// The simulation bot is a single shared instance for every viewer. One browser
// runs the engine (leader) and pushes snapshots; others read the same state.

export async function getSimState(): Promise<SimBotStateResponse> {
  const base = resolveBaseUrl();
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/sim/state`);
  if (!res.ok) throw new Error(`Sim ${res.status}`);
  return (await res.json()) as SimBotStateResponse;
}

export async function pushSimState(leaderId: string, snapshot: SimBotSnapshot): Promise<{ ok: boolean; updatedAt: number }> {
  const base = resolveBaseUrl();
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/sim/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leaderId, snapshot })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Sim push ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as { ok: boolean; updatedAt: number };
}

export async function claimSimLeadership(leaderId: string): Promise<{ claimed: boolean; leaderId: string | null }> {
  const base = resolveBaseUrl();
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/sim/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leaderId })
  });
  if (!res.ok) throw new Error(`Sim claim ${res.status}`);
  return (await res.json()) as { claimed: boolean; leaderId: string | null };
}

export async function startSim(): Promise<SimBotStateResponse> {
  const base = resolveBaseUrl();
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/sim/start`, { method: 'POST' });
  if (!res.ok) throw new Error(`Sim start ${res.status}`);
  return (await res.json()) as SimBotStateResponse;
}

export async function stopSim(): Promise<SimBotStateResponse> {
  const base = resolveBaseUrl();
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/sim/stop`, { method: 'POST' });
  if (!res.ok) throw new Error(`Sim stop ${res.status}`);
  return (await res.json()) as SimBotStateResponse;
}

export async function resetSim(): Promise<SimBotStateResponse> {
  const base = resolveBaseUrl();
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/sim/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`Sim reset ${res.status}`);
  return (await res.json()) as SimBotStateResponse;
}

export async function setSimConfig(config: SimBotConfig): Promise<SimBotStateResponse> {
  const base = resolveBaseUrl();
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/sim/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config })
  });
  if (!res.ok) throw new Error(`Sim config ${res.status}`);
  return (await res.json()) as SimBotStateResponse;
}

function resolveBaseUrl(configured?: string): string {
  const fromEnv = import.meta.env.VITE_TRADING_API_URL as string | undefined;
  // Prefer an explicitly configured (manually entered) URL over the build-time
  // VITE_TRADING_API_URL, so a saved Worker address is actually used.
  const base = (configured || fromEnv || '').replace(/\/$/, '');
  return base;
}

export function createTradingApiClient(configuredBaseUrl: string, adminToken: string): TradingApiClient {
  const baseUrl = resolveBaseUrl(configuredBaseUrl);

  async function authed<T>(path: string, method = 'GET'): Promise<T> {
    if (!baseUrl) throw new Error('כתובת Worker לא הוגדרה');
    if (!adminToken) throw new Error('BOT_ADMIN_TOKEN לא הוגדר');
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Worker ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  return {
    baseUrl,
    getHealth: async () => {
      if (!baseUrl) throw new Error('כתובת Worker לא הוגדרה');
      const res = await fetch(`${baseUrl}/health`);
      if (!res.ok) throw new Error(`Worker ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    },
    getState: () => authed<WorkerBotState>('/api/bot/state'),
    getAccountSummary: () => authed<WorkerAccountSummary>('/api/account/summary'),
    getDecisions: () => authed<WorkerDecisionsResponse>('/api/decisions'),
    start: () => authed<WorkerBotState>('/api/bot/start', 'POST'),
    stop: () => authed<WorkerBotState>('/api/bot/stop', 'POST')
  };
}
