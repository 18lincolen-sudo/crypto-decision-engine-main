/**
 * Production utilities and environment helpers
 */

export const isProduction = import.meta.env.PROD;
export const isDevelopment = import.meta.env.DEV;

// Logger that only logs in development
export const logger = {
  log: (...args: unknown[]) => {
    if (isDevelopment) {
      console.log(...args);
    }
  },
  error: (...args: unknown[]) => {
    if (isDevelopment) {
      console.error(...args);
    }
  },
  warn: (...args: unknown[]) => {
    if (isDevelopment) {
      console.warn(...args);
    }
  },
  info: (...args: unknown[]) => {
    if (isDevelopment) {
      console.info(...args);
    }
  }
};

// Performance monitoring for production
export const performanceMonitor = {
  mark: (name: string) => {
    if (isProduction && typeof window !== 'undefined' && 'performance' in window) {
      performance.mark(name);
    }
  },
  measure: (name: string, startMark: string, endMark?: string) => {
    if (isProduction && typeof window !== 'undefined' && 'performance' in window) {
      performance.measure(name, startMark, endMark);
    }
  }
};

// Error reporting (you can integrate with services like Sentry)
export const errorReporter = {
  captureException: (error: Error, context?: Record<string, unknown>) => {
    if (isProduction) {
      // In production, you might want to send to an error tracking service
      // For now, we'll just log to console
      console.error('Production Error:', error, context);
    } else {
      console.error('Development Error:', error, context);
    }
  },
  captureMessage: (message: string, level: 'info' | 'warning' | 'error' = 'info') => {
    if (isProduction) {
      console[level === 'warning' ? 'warn' : level === 'error' ? 'error' : 'log'](message);
    }
  }
};

// Feature flags for production
export const featureFlags = {
  enableAdvancedTrading: true,
  enableRealTimeData: true,
  enableOfflineMode: true,
  enablePushNotifications: isProduction,
  enableAnalytics: import.meta.env.VITE_ENABLE_ANALYTICS === 'true'
};

// App metadata
export const appMetadata = {
  name: 'Crypto Decision Engine',
  version: '1.0.0',
  buildDate: new Date().toISOString(),
  environment: isProduction ? 'production' : 'development'
};