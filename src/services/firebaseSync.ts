/**
 * Firebase Firestore Cloud Sync Service (Zero-dependency REST API)
 * Seamlessly syncs trade history and metrics to Firestore when configured,
 * with 100% offline fallback to localStorage.
 */

const FIREBASE_PROJECT_ID = import.meta.env.VITE_FIREBASE_PROJECT_ID || '';
const FIREBASE_API_KEY = import.meta.env.VITE_FIREBASE_API_KEY || '';

const FIRESTORE_BASE_URL = FIREBASE_PROJECT_ID
  ? `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`
  : '';

export interface CloudTradeRecord {
  id: string;
  symbol: string;
  type: string;
  side: string;
  price: number;
  quantity: number;
  leverage: number;
  pnl?: number;
  timestamp: string;
  reason?: string;
  confidence?: number;
}

export const firebaseSync = {
  isConfigured(): boolean {
    return Boolean(FIREBASE_PROJECT_ID);
  },

  /**
   * Save a completed trade to Firestore
   */
  async saveTrade(trade: CloudTradeRecord): Promise<boolean> {
    if (!this.isConfigured()) return false;

    try {
      const url = `${FIRESTORE_BASE_URL}/trades/${trade.id}${FIREBASE_API_KEY ? `?key=${FIREBASE_API_KEY}` : ''}`;
      const fields: Record<string, any> = {
        symbol: { stringValue: trade.symbol },
        type: { stringValue: trade.type },
        side: { stringValue: trade.side },
        price: { doubleValue: trade.price },
        quantity: { doubleValue: trade.quantity },
        leverage: { integerValue: trade.leverage.toString() },
        timestamp: { stringValue: trade.timestamp }
      };

      if (trade.pnl !== undefined) fields.pnl = { doubleValue: trade.pnl };
      if (trade.reason) fields.reason = { stringValue: trade.reason };
      if (trade.confidence) fields.confidence = { doubleValue: trade.confidence };

      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      });

      return res.ok;
    } catch (err) {
      console.warn('Firebase sync warning:', err);
      return false;
    }
  },

  /**
   * Sync portfolio summary metrics to Firestore
   */
  async syncMetrics(metrics: Record<string, any>): Promise<boolean> {
    if (!this.isConfigured()) return false;

    try {
      const url = `${FIRESTORE_BASE_URL}/stats/latest${FIREBASE_API_KEY ? `?key=${FIREBASE_API_KEY}` : ''}`;
      const fields: Record<string, any> = {};

      for (const [k, v] of Object.entries(metrics)) {
        if (typeof v === 'number') {
          fields[k] = { doubleValue: v };
        } else if (typeof v === 'string') {
          fields[k] = { stringValue: v };
        } else if (typeof v === 'boolean') {
          fields[k] = { booleanValue: v };
        }
      }

      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      });

      return res.ok;
    } catch {
      return false;
    }
  }
};
