/**
 * Firebase sync for the frontend — read/write trade records and simulation
 * results directly to Firestore as a fallback / secondary data source.
 *
 * Uses the Firebase Web SDK (v10+ modular) with the public project ID and
 * API key. No service-account / admin privileges are used here, so this is
 * safe to expose in the browser bundle.
 *
 * Environment variables (Vite build-time):
 *   VITE_FIREBASE_PROJECT_ID
 *   VITE_FIREBASE_API_KEY
 */

import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  getDocs,
  collection,
  query,
  where,
  orderBy,
  limit,
  Firestore
} from 'firebase/firestore';

// ── Config ──────────────────────────────────────────────────────────────────

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || ''
};

let app: FirebaseApp | null = null;
let db: Firestore | null = null;

function ensureFirebase(): { app: FirebaseApp; db: Firestore } | null {
  if (!firebaseConfig.projectId || !firebaseConfig.apiKey) {
    console.warn('[firebaseSync] VITE_FIREBASE_PROJECT_ID or VITE_FIREBASE_API_KEY is missing — Firebase sync disabled');
    return null;
  }
  if (!app) {
    app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
  }
  if (!db) {
    db = getFirestore(app);
  }
  return { app, db };
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface FirestoreTradeRecord {
  symbol: string;
  side: 'LONG' | 'SHORT' | 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  pnlPercent: number;
  leverage?: number;
  engine: 'intraday' | 'legacy' | 'pro';
  openedAt: string;
  closedAt: string;
  reason?: string;
  confidence?: number;
}

export interface FirestoreSimSnapshot {
  engine: 'intraday' | 'legacy' | 'pro';
  cash: number;
  totalProfit: number;
  winRate: number;
  totalTrades: number;
  closedTrades: number;
  updatedAt: number;
}

// ── Trade Records ────────────────────────────────────────────────────────────

const TRADES_COLLECTION = 'trade-records';

export async function saveTradeRecord(record: FirestoreTradeRecord): Promise<boolean> {
  const fb = ensureFirebase();
  if (!fb) return false;
  try {
    const ref = doc(fb.db, TRADES_COLLECTION, `${record.engine}-${record.symbol}-${Date.now()}`);
    await setDoc(ref, {
      ...record,
      savedAt: Date.now()
    });
    return true;
  } catch (e) {
    console.warn('[firebaseSync] saveTradeRecord failed:', e);
    return false;
  }
}

export async function getTradeHistory(
  engine?: 'intraday' | 'legacy' | 'pro',
  limitCount = 50
): Promise<FirestoreTradeRecord[]> {
  const fb = ensureFirebase();
  if (!fb) return [];
  try {
    const col = collection(fb.db, TRADES_COLLECTION);
    const q = engine
      ? query(col, where('engine', '==', engine), orderBy('closedAt', 'desc'), limit(limitCount))
      : query(col, orderBy('closedAt', 'desc'), limit(limitCount));
    const snap = await getDocs(q);
    return snap.docs.map(d => d.data() as FirestoreTradeRecord);
  } catch (e) {
    console.warn('[firebaseSync] getTradeHistory failed:', e);
    return [];
  }
}

// ── Simulation Snapshots ─────────────────────────────────────────────────────

const SIM_SNAPSHOTS_COLLECTION = 'sim-snapshots';

export async function saveSimSnapshot(snapshot: FirestoreSimSnapshot): Promise<boolean> {
  const fb = ensureFirebase();
  if (!fb) return false;
  try {
    const ref = doc(fb.db, SIM_SNAPSHOTS_COLLECTION, `${snapshot.engine}-latest`);
    await setDoc(ref, {
      ...snapshot,
      savedAt: Date.now()
    });
    return true;
  } catch (e) {
    console.warn('[firebaseSync] saveSimSnapshot failed:', e);
    return false;
  }
}

export async function getLatestSimSnapshot(
  engine: 'intraday' | 'legacy' | 'pro'
): Promise<FirestoreSimSnapshot | null> {
  const fb = ensureFirebase();
  if (!fb) return null;
  try {
    const ref = doc(fb.db, SIM_SNAPSHOTS_COLLECTION, `${engine}-latest`);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      return snap.data() as FirestoreSimSnapshot;
    }
    return null;
  } catch (e) {
    console.warn('[firebaseSync] getLatestSimSnapshot failed:', e);
    return null;
  }
}

// ── Health ───────────────────────────────────────────────────────────────────

export function isFirebaseConfigured(): boolean {
  return Boolean(firebaseConfig.projectId && firebaseConfig.apiKey);
}
