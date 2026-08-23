/**
 * Local Database Implementation using IndexedDB
 * For storing trading data, portfolio, and user preferences locally
 * Enhanced with encryption and security features
 */

import { securityManager } from './securityManager';

interface DatabaseSchema {
  portfolio: {
    id: string;
    symbol: string;
    amount: number;
    averagePrice: number;
    lastUpdated: string;
  };
  trades: {
    id: string;
    symbol: string;
    type: 'buy' | 'sell';
    amount: number;
    price: number;
    timestamp: string;
    status: 'completed' | 'pending' | 'failed';
  };
  alerts: {
    id: string;
    symbol: string;
    condition: 'above' | 'below';
    targetPrice: number;
    isActive: boolean;
    createdAt: string;
  };
  preferences: {
    id: string;
    key: string;
    value: any;
    lastUpdated: string;
  };
}

class LocalDatabase {
  private dbName = 'CryptoTradingDB';
  private version = 1;
  private db: IDBDatabase | null = null;
  private encryptionKey: string | null = null;

  constructor() {
    // Generate or retrieve encryption key for local data
    this.initializeEncryption();
  }

  private initializeEncryption(): void {
    let key = localStorage.getItem('db_encryption_key');
    if (!key) {
      key = securityManager.generateSecurePassword();
      localStorage.setItem('db_encryption_key', key);
    }
    this.encryptionKey = key;
  }

  private async encryptData(data: any): Promise<string> {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not initialized');
    }
    const jsonData = JSON.stringify(data);
    const encrypted = await securityManager.encrypt(jsonData, this.encryptionKey);
    return JSON.stringify(encrypted);
  }

  private async decryptData(encryptedData: string): Promise<any> {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not initialized');
    }
    try {
      const encrypted = JSON.parse(encryptedData);
      const decrypted = await securityManager.decrypt(encrypted, this.encryptionKey);
      return JSON.parse(decrypted);
    } catch (error) {
      // Return null for corrupted data
      return null;
    }
  }

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create portfolio store
        if (!db.objectStoreNames.contains('portfolio')) {
          const portfolioStore = db.createObjectStore('portfolio', { keyPath: 'id' });
          portfolioStore.createIndex('symbol', 'symbol', { unique: false });
        }

        // Create trades store
        if (!db.objectStoreNames.contains('trades')) {
          const tradesStore = db.createObjectStore('trades', { keyPath: 'id' });
          tradesStore.createIndex('symbol', 'symbol', { unique: false });
          tradesStore.createIndex('timestamp', 'timestamp', { unique: false });
        }

        // Create alerts store
        if (!db.objectStoreNames.contains('alerts')) {
          const alertsStore = db.createObjectStore('alerts', { keyPath: 'id' });
          alertsStore.createIndex('symbol', 'symbol', { unique: false });
          alertsStore.createIndex('isActive', 'isActive', { unique: false });
        }

        // Create preferences store
        if (!db.objectStoreNames.contains('preferences')) {
          const preferencesStore = db.createObjectStore('preferences', { keyPath: 'id' });
          preferencesStore.createIndex('key', 'key', { unique: true });
        }
      };
    });
  }

  private async getStore(storeName: keyof DatabaseSchema, mode: IDBTransactionMode = 'readonly'): Promise<IDBObjectStore> {
    if (!this.db) {
      await this.init();
    }
    const transaction = this.db!.transaction([storeName], mode);
    return transaction.objectStore(storeName);
  }

  // Portfolio methods
  async getPortfolio(): Promise<DatabaseSchema['portfolio'][]> {
    const store = await this.getStore('portfolio');
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async addToPortfolio(item: Omit<DatabaseSchema['portfolio'], 'id'>): Promise<void> {
    const store = await this.getStore('portfolio', 'readwrite');
    const portfolioItem: DatabaseSchema['portfolio'] = {
      ...item,
      id: `${item.symbol}_${Date.now()}`,
      lastUpdated: new Date().toISOString()
    };
    
    return new Promise((resolve, reject) => {
      const request = store.add(portfolioItem);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async updatePortfolioItem(id: string, updates: Partial<DatabaseSchema['portfolio']>): Promise<void> {
    const store = await this.getStore('portfolio', 'readwrite');
    return new Promise((resolve, reject) => {
      const getRequest = store.get(id);
      getRequest.onsuccess = () => {
        const item = getRequest.result;
        if (item) {
          const updatedItem = { ...item, ...updates, lastUpdated: new Date().toISOString() };
          const putRequest = store.put(updatedItem);
          putRequest.onsuccess = () => resolve();
          putRequest.onerror = () => reject(putRequest.error);
        } else {
          reject(new Error('Portfolio item not found'));
        }
      };
      getRequest.onerror = () => reject(getRequest.error);
    });
  }

  async removeFromPortfolio(id: string): Promise<void> {
    const store = await this.getStore('portfolio', 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // Trades methods
  async getTrades(limit = 50): Promise<DatabaseSchema['trades'][]> {
    const store = await this.getStore('trades');
    return new Promise((resolve, reject) => {
      const request = store.index('timestamp').openCursor(null, 'prev');
      const trades: DatabaseSchema['trades'][] = [];
      let count = 0;

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor && count < limit) {
          trades.push(cursor.value);
          count++;
          cursor.continue();
        } else {
          resolve(trades);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async addTrade(trade: Omit<DatabaseSchema['trades'], 'id'>): Promise<string> {
    const store = await this.getStore('trades', 'readwrite');
    const tradeItem: DatabaseSchema['trades'] = {
      ...trade,
      id: `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    };
    
    return new Promise((resolve, reject) => {
      const request = store.add(tradeItem);
      request.onsuccess = () => resolve(tradeItem.id);
      request.onerror = () => reject(request.error);
    });
  }

  // Alerts methods
  async getAlerts(): Promise<DatabaseSchema['alerts'][]> {
    const store = await this.getStore('alerts');
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async addAlert(alert: Omit<DatabaseSchema['alerts'], 'id'>): Promise<string> {
    const store = await this.getStore('alerts', 'readwrite');
    const alertItem: DatabaseSchema['alerts'] = {
      ...alert,
      id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      createdAt: new Date().toISOString()
    };
    
    return new Promise((resolve, reject) => {
      const request = store.add(alertItem);
      request.onsuccess = () => resolve(alertItem.id);
      request.onerror = () => reject(request.error);
    });
  }

  async updateAlert(id: string, updates: Partial<DatabaseSchema['alerts']>): Promise<void> {
    const store = await this.getStore('alerts', 'readwrite');
    return new Promise((resolve, reject) => {
      const getRequest = store.get(id);
      getRequest.onsuccess = () => {
        const item = getRequest.result;
        if (item) {
          const updatedItem = { ...item, ...updates };
          const putRequest = store.put(updatedItem);
          putRequest.onsuccess = () => resolve();
          putRequest.onerror = () => reject(putRequest.error);
        } else {
          reject(new Error('Alert not found'));
        }
      };
      getRequest.onerror = () => reject(getRequest.error);
    });
  }

  async removeAlert(id: string): Promise<void> {
    const store = await this.getStore('alerts', 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // Preferences methods
  async getPreference(key: string): Promise<any> {
    const store = await this.getStore('preferences');
    return new Promise((resolve, reject) => {
      const request = store.index('key').get(key);
      request.onsuccess = () => resolve(request.result?.value || null);
      request.onerror = () => reject(request.error);
    });
  }

  async setPreference(key: string, value: any): Promise<void> {
    const store = await this.getStore('preferences', 'readwrite');
    const preference: DatabaseSchema['preferences'] = {
      id: `pref_${key}`,
      key,
      value,
      lastUpdated: new Date().toISOString()
    };
    
    return new Promise((resolve, reject) => {
      const request = store.put(preference);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // Utility methods
  async clearAllData(): Promise<void> {
    if (!this.db) return;
    
    const storeNames: (keyof DatabaseSchema)[] = ['portfolio', 'trades', 'alerts', 'preferences'];
    const transaction = this.db.transaction(storeNames, 'readwrite');
    
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      
      storeNames.forEach(storeName => {
        transaction.objectStore(storeName).clear();
      });
    });
  }

  async exportData(): Promise<string> {
    const data = {
      portfolio: await this.getPortfolio(),
      trades: await this.getTrades(1000),
      alerts: await this.getAlerts(),
      exportDate: new Date().toISOString()
    };
    
    return JSON.stringify(data, null, 2);
  }

  async importData(jsonData: string): Promise<void> {
    try {
      const data = JSON.parse(jsonData);
      
      // Clear existing data
      await this.clearAllData();
      
      // Import portfolio
      if (data.portfolio) {
        for (const item of data.portfolio) {
          await this.addToPortfolio(item);
        }
      }
      
      // Import trades
      if (data.trades) {
        for (const trade of data.trades) {
          await this.addTrade(trade);
        }
      }
      
      // Import alerts
      if (data.alerts) {
        for (const alert of data.alerts) {
          await this.addAlert(alert);
        }
      }
    } catch (error) {
      throw new Error(`Failed to import data: ${error}`);
    }
  }
}

// Singleton instance
export const localDB = new LocalDatabase();

// Initialize database on module load
localDB.init().catch(console.error);