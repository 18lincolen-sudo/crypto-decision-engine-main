/**
 * Production optimization utilities
 */
import { isProduction } from './production';

// Safe production initializations
export const initializeProductionOptimizations = () => {
  if (!isProduction) return;

  try {
    // Service Worker Registration for PWA
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/service-worker.js').catch(() => {
          // ignore registration failures
        });
      });
    }
  } catch (e) {
    console.warn('Production init notice:', e);
  }
};
