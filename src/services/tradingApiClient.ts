// Typed client for the local trading worker (server/tradingWorker.ts or server/dist/worker.js).
import type { SimBotConfig } from '../hooks/useSimulationBot';
import { resolveWorkerBaseUrl as resolveBaseUrl } from './workerConfig';
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
  openedSymbols?: Record<string, { at: number; type: 'SPOT' | 'FUTURES'; reason?: string; confidence?: number }>;
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
  hourlyHistory?: unknown[];
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

// Every function below accepts an optional `configuredBaseUrl` so callers that
// already hold the live WorkerAuthContext value (shared, synced across pages
// on this device) can pass it explicitly instead of relying on this module's
// own separate re-read of localStorage — avoids the two ever silently drifting.

export async function getSimState(configuredBaseUrl?: string): Promise<SimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/sim/state`);
  if (!res.ok) throw new Error(`Sim ${res.status}`);
  return (await res.json()) as SimBotStateResponse;
}

export async function pushSimState(leaderId: string, snapshot: SimBotSnapshot, configuredBaseUrl?: string): Promise<{ ok: boolean; updatedAt: number }> {
  const base = resolveBaseUrl(configuredBaseUrl);
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

export async function claimSimLeadership(leaderId: string, configuredBaseUrl?: string): Promise<{ claimed: boolean; leaderId: string | null }> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/sim/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leaderId })
  });
  if (!res.ok) throw new Error(`Sim claim ${res.status}`);
  return (await res.json()) as { claimed: boolean; leaderId: string | null };
}

export async function startSim(configuredBaseUrl?: string): Promise<SimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/sim/start`, { method: 'POST' });
  if (!res.ok) throw new Error(`Sim start ${res.status}`);
  return (await res.json()) as SimBotStateResponse;
}

export async function stopSim(configuredBaseUrl?: string): Promise<SimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/sim/stop`, { method: 'POST' });
  if (!res.ok) throw new Error(`Sim stop ${res.status}`);
  return (await res.json()) as SimBotStateResponse;
}

export async function resetSim(configuredBaseUrl?: string): Promise<SimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/sim/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`Sim reset ${res.status}`);
  return (await res.json()) as SimBotStateResponse;
}

export async function setSimConfig(config: SimBotConfig, configuredBaseUrl?: string): Promise<SimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/sim/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config })
  });
  if (!res.ok) throw new Error(`Sim config ${res.status}`);
  return (await res.json()) as SimBotStateResponse;
}

// ── Shared LEGACY Simulation Bot API (public, no admin token) ─────────────────
// Same shared-viewer model as the block above, running server/legacySimEngine.ts
// (original alg.md algorithm). Fully server-driven — no leader election, so
// there's no claim/push counterpart to mirror from the sim functions above.

export interface LegacySimBotStateResponse {
  running: boolean;
  config: SimBotConfig;
  snapshot: SimBotSnapshot | null;
  updatedAt: number;
}

export async function getLegacySimState(configuredBaseUrl?: string): Promise<LegacySimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/legacy-sim/state`);
  if (!res.ok) throw new Error(`Legacy sim ${res.status}`);
  return (await res.json()) as LegacySimBotStateResponse;
}

export async function startLegacySim(configuredBaseUrl?: string): Promise<LegacySimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/legacy-sim/start`, { method: 'POST' });
  if (!res.ok) throw new Error(`Legacy sim start ${res.status}`);
  return (await res.json()) as LegacySimBotStateResponse;
}

export async function stopLegacySim(configuredBaseUrl?: string): Promise<LegacySimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/legacy-sim/stop`, { method: 'POST' });
  if (!res.ok) throw new Error(`Legacy sim stop ${res.status}`);
  return (await res.json()) as LegacySimBotStateResponse;
}

export async function resetLegacySim(configuredBaseUrl?: string): Promise<LegacySimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/legacy-sim/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`Legacy sim reset ${res.status}`);
  return (await res.json()) as LegacySimBotStateResponse;
}

export async function setLegacySimConfig(config: SimBotConfig, configuredBaseUrl?: string): Promise<LegacySimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/legacy-sim/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config })
  });
  if (!res.ok) throw new Error(`Legacy sim config ${res.status}`);
  return (await res.json()) as LegacySimBotStateResponse;
}

// ── Shared "Bot Pro" API (public, no admin token) ──────────────────────────
// Same shared-viewer model as the two blocks above, running
// server/proSimEngine.ts (a literal alg.md implementation). Fully
// server-driven — no leader election, so no claim/push counterpart.

export interface ProSimBotStateResponse {
  running: boolean;
  config: SimBotConfig;
  snapshot: SimBotSnapshot | null;
  updatedAt: number;
}

export async function getProSimState(configuredBaseUrl?: string): Promise<ProSimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/pro-sim/state`);
  if (!res.ok) throw new Error(`Pro sim ${res.status}`);
  return (await res.json()) as ProSimBotStateResponse;
}

export async function startProSim(configuredBaseUrl?: string): Promise<ProSimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/pro-sim/start`, { method: 'POST' });
  if (!res.ok) throw new Error(`Pro sim start ${res.status}`);
  return (await res.json()) as ProSimBotStateResponse;
}

export async function stopProSim(configuredBaseUrl?: string): Promise<ProSimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/pro-sim/stop`, { method: 'POST' });
  if (!res.ok) throw new Error(`Pro sim stop ${res.status}`);
  return (await res.json()) as ProSimBotStateResponse;
}

export async function resetProSim(configuredBaseUrl?: string): Promise<ProSimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/pro-sim/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`Pro sim reset ${res.status}`);
  return (await res.json()) as ProSimBotStateResponse;
}

export async function setProSimConfig(config: SimBotConfig, configuredBaseUrl?: string): Promise<ProSimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/pro-sim/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config })
  });
  if (!res.ok) throw new Error(`Pro sim config ${res.status}`);
  return (await res.json()) as ProSimBotStateResponse;
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

