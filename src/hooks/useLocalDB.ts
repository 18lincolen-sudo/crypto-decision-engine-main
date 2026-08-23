import { useState, useEffect } from 'react';
import { localDB } from '@/utils/localDatabase';

interface LocalPortfolioItem {
  id: string;
  symbol: string;
  amount: number;
  averagePrice: number;
  lastUpdated: string;
}

interface LocalTrade {
  id: string;
  symbol: string;
  type: 'buy' | 'sell';
  amount: number;
  price: number;
  timestamp: string;
  status: 'completed' | 'pending' | 'failed';
}

interface LocalAlert {
  id: string;
  symbol: string;
  condition: 'above' | 'below';
  targetPrice: number;
  isActive: boolean;
  createdAt: string;
}

export function useLocalPortfolio() {
  const [portfolio, setPortfolio] = useState<LocalPortfolioItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPortfolio();
  }, []);

  const loadPortfolio = async () => {
    try {
      const data = await localDB.getPortfolio();
      setPortfolio(data);
    } catch (error) {
      console.error('Failed to load portfolio:', error);
    } finally {
      setLoading(false);
    }
  };

  const addToPortfolio = async (symbol: string, amount: number, price: number) => {
    try {
      await localDB.addToPortfolio({
        symbol,
        amount,
        averagePrice: price,
        lastUpdated: new Date().toISOString()
      });
      await loadPortfolio();
    } catch (error) {
      console.error('Failed to add to portfolio:', error);
      throw error;
    }
  };

  const updatePortfolioItem = async (id: string, updates: Partial<LocalPortfolioItem>) => {
    try {
      await localDB.updatePortfolioItem(id, updates);
      await loadPortfolio();
    } catch (error) {
      console.error('Failed to update portfolio item:', error);
      throw error;
    }
  };

  const removeFromPortfolio = async (id: string) => {
    try {
      await localDB.removeFromPortfolio(id);
      await loadPortfolio();
    } catch (error) {
      console.error('Failed to remove from portfolio:', error);
      throw error;
    }
  };

  return {
    portfolio,
    loading,
    addToPortfolio,
    updatePortfolioItem,
    removeFromPortfolio,
    refreshPortfolio: loadPortfolio
  };
}

export function useLocalTrades() {
  const [trades, setTrades] = useState<LocalTrade[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadTrades();
  }, []);

  const loadTrades = async () => {
    try {
      const data = await localDB.getTrades(100);
      setTrades(data);
    } catch (error) {
      console.error('Failed to load trades:', error);
    } finally {
      setLoading(false);
    }
  };

  const addTrade = async (trade: Omit<LocalTrade, 'id'>) => {
    try {
      await localDB.addTrade(trade);
      await loadTrades();
    } catch (error) {
      console.error('Failed to add trade:', error);
      throw error;
    }
  };

  return {
    trades,
    loading,
    addTrade,
    refreshTrades: loadTrades
  };
}

export function useLocalAlerts() {
  const [alerts, setAlerts] = useState<LocalAlert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadAlerts();
  }, []);

  const loadAlerts = async () => {
    try {
      const data = await localDB.getAlerts();
      setAlerts(data);
    } catch (error) {
      console.error('Failed to load alerts:', error);
    } finally {
      setLoading(false);
    }
  };

  const addAlert = async (alert: Omit<LocalAlert, 'id' | 'createdAt'>) => {
    try {
      await localDB.addAlert({
        ...alert,
        createdAt: new Date().toISOString()
      });
      await loadAlerts();
    } catch (error) {
      console.error('Failed to add alert:', error);
      throw error;
    }
  };

  const updateAlert = async (id: string, updates: Partial<LocalAlert>) => {
    try {
      await localDB.updateAlert(id, updates);
      await loadAlerts();
    } catch (error) {
      console.error('Failed to update alert:', error);
      throw error;
    }
  };

  const removeAlert = async (id: string) => {
    try {
      await localDB.removeAlert(id);
      await loadAlerts();
    } catch (error) {
      console.error('Failed to remove alert:', error);
      throw error;
    }
  };

  return {
    alerts,
    loading,
    addAlert,
    updateAlert,
    removeAlert,
    refreshAlerts: loadAlerts
  };
}

export function useLocalPreferences() {
  const getPreference = async (key: string) => {
    try {
      return await localDB.getPreference(key);
    } catch (error) {
      console.error('Failed to get preference:', error);
      return null;
    }
  };

  const setPreference = async (key: string, value: any) => {
    try {
      await localDB.setPreference(key, value);
    } catch (error) {
      console.error('Failed to set preference:', error);
      throw error;
    }
  };

  return {
    getPreference,
    setPreference
  };
}