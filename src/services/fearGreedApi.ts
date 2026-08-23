
import { FearGreedIndex } from '../types/crypto';

const FEAR_GREED_API_URL = 'https://api.alternative.me/fng/';

export const fearGreedApi = {
  async getFearGreedIndex(): Promise<FearGreedIndex> {
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
      
      return {
        value: parseInt(latest.value),
        value_classification: latest.value_classification,
        timestamp: latest.timestamp
      };
    } catch (error) {
      console.warn('Error fetching Fear & Greed index:', error);
      
      // Return a neutral fallback value with current timestamp
      return {
        value: 50,
        value_classification: 'Neutral',
        timestamp: Math.floor(Date.now() / 1000).toString()
      };
    }
  }
};
