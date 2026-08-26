
import { FearGreedIndex } from '../types/crypto';

const FEAR_GREED_API_URL = 'https://api.alternative.me/fng/';
// The index updates once a day, but this is called every scan cycle (5 min
// default) by multiple independent callers (real bot + both sim engines) —
// unlike coinGeckoApi.ts/cryptoPriceAggregator.ts, this had no cache at all.
const CACHE_TTL_MS = 15 * 60 * 1000;
let cache: { data: FearGreedIndex; at: number } | null = null;

export const fearGreedApi = {
  async getFearGreedIndex(): Promise<FearGreedIndex> {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return cache.data;
    }
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout

      const response = await fetch(`${FEAR_GREED_API_URL}?limit=1`, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
        }
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      if (!data.data || !data.data[0]) {
        throw new Error('Invalid API response format');
      }
      
      const latest = data.data[0];

      const result: FearGreedIndex = {
        value: parseInt(latest.value),
        value_classification: latest.value_classification,
        timestamp: latest.timestamp
      };
      cache = { data: result, at: Date.now() };
      return result;
    } catch (error) {
      console.warn('Error fetching Fear & Greed index:', error);

      // Serve a stale cached value over a fabricated neutral one if we have
      // one — a real (if slightly old) sentiment reading beats a fake 50.
      if (cache) return cache.data;

      // Return a neutral fallback value with current timestamp
      return {
        value: 50,
        value_classification: 'Neutral',
        timestamp: Math.floor(Date.now() / 1000).toString()
      };
    }
  }
};
