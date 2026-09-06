import { useEffect, useState } from 'react';
import { fearGreedApi } from '../services/fearGreedApi';

/**
 * Fetch-once Fear & Greed index, defaulting to 50 (neutral) until it loads.
 * Shared by the simulation contexts, which previously each duplicated this
 * exact fetch-on-mount effect.
 */
export function useFearGreedIndex(): number {
  const [fearGreedIndex, setFearGreedIndex] = useState(50);

  useEffect(() => {
    fearGreedApi.getFearGreedIndex()
      .then((fg) => { if (fg?.value) setFearGreedIndex(fg.value); })
      .catch(() => {});
  }, []);

  return fearGreedIndex;
}
