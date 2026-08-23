// Bybit API v5 — Authentication uses API Key + HMAC-SHA256(Secret Key).
// There is NO passphrase in Bybit. Only OKX/Coinbase use a passphrase.
// Obtain your API Key & Secret from: https://www.bybit.com/app/user/api-management
export interface BybitConfig {
  apiKey: string;
  secretKey: string;
  testnet: boolean;
}

export interface OrderParams {
  category?: 'spot' | 'linear';
  symbol: string;
  side: 'Buy' | 'Sell';
  orderType: 'Market' | 'Limit';
  qty: string;
  price?: string;
  takeProfit?: string;
  stopLoss?: string;
  tpslMode?: 'Full' | 'Partial';
  tpOrderType?: 'Market' | 'Limit';
  slOrderType?: 'Market' | 'Limit';
  reduceOnly?: boolean;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
}

export interface PositionInfo {
  symbol: string;
  side: string;
  size: string;
  positionValue: string;
  entryPrice: string;
  leverage: string;
  unrealisedPnl: string;
  markPrice: string;
  stopLoss?: string;
  takeProfit?: string;
  trailingStop?: string;
}

export interface AccountBalance {
  coin: string;
  walletBalance: string;
  availableBalance: string;
  usdValue?: string;
}

// Browser-compatible HMAC-SHA256 implementation
async function hmacSha256(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const messageData = encoder.encode(message);
  
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export class RealBybitAPI {
  private config: BybitConfig;
  private baseUrl: string;

  constructor(config: BybitConfig) {
    this.config = config;
    this.baseUrl = config.testnet 
      ? 'https://api-testnet.bybit.com'
      : 'https://api.bybit.com';
  }

  setCredentials(apiKey: string, secretKey: string, testnet: boolean = true) {
    this.config = { apiKey, secretKey, testnet };
    this.baseUrl = testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
  }

  updateConfig(config: BybitConfig) {
    this.config = config;
    this.baseUrl = config.testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
  }

  // Bybit v5 signature: timestamp + apiKey + queryString/body
  // Ref: https://bybit-exchange.github.io/docs/v5/guide/authentication
  private async generateSignature(timestamp: string, params: string): Promise<string> {
    const recvWindow = '5000';
    const message = timestamp + this.config.apiKey + recvWindow + params;
    return await hmacSha256(this.config.secretKey, message);
  }

  private async makeRequest(endpoint: string, method: 'GET' | 'POST' = 'GET', params: any = {}) {
    try {
      if (!this.config.apiKey || !this.config.secretKey) {
        throw new Error('API credentials not configured');
      }

      const sanitizedParams = this.sanitizeParams(params);
      const timestamp = Date.now().toString();
      const paramsString = method === 'GET' 
        ? new URLSearchParams(sanitizedParams).toString()
        : JSON.stringify(sanitizedParams);
      
      const signature = await this.generateSignature(timestamp, paramsString);
      
      const headers = {
        'X-BAPI-API-KEY': this.config.apiKey,
        'X-BAPI-SIGN': signature,
        'X-BAPI-SIGN-TYPE': '2',
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': '5000',
        'Content-Type': 'application/json',
      };

      const url = method === 'GET' && paramsString
        ? `${this.baseUrl}${endpoint}?${paramsString}`
        : `${this.baseUrl}${endpoint}`;

      const requestOptions: RequestInit = {
        method,
        headers,
        mode: 'cors',
        signal: AbortSignal.timeout(30000),
      };

      if (method === 'POST') {
        requestOptions.body = JSON.stringify(sanitizedParams);
      }

      const response = await fetch(url, requestOptions);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      if (typeof data !== 'object' || data === null) {
        throw new Error('Invalid response format');
      }
      
      if (data.retCode !== 0) {
        // 110043: Set leverage not modified (already set)
        if (data.retCode === 110043) {
          return { retCode: 0, retMsg: 'Leverage not modified' };
        }
        throw new Error(`API Error: ${data.retMsg || 'Unknown error'} (Code: ${data.retCode})`);
      }
      
      return this.sanitizeResponseData(data.result);
    } catch (error) {
      const sanitizedError = error instanceof Error ? error.message : 'Unknown error';
      console.error('API request failed:', sanitizedError);
      throw new Error(`Request failed: ${sanitizedError}`);
    }
  }

  private sanitizeParams(params: any): any {
    if (typeof params !== 'object' || params === null) {
      return {};
    }
    const sanitized: any = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string') {
        sanitized[key] = value.replace(/[<>'"&]/g, '').trim();
      } else if (typeof value === 'number' && isFinite(value)) {
        sanitized[key] = value;
      } else if (typeof value === 'boolean') {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  private sanitizeResponseData(data: any): any {
    if (typeof data !== 'object' || data === null) {
      return data;
    }
    if (Array.isArray(data)) {
      return data.map(item => this.sanitizeResponseData(item));
    }
    const sanitized: any = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string') {
        sanitized[key] = value.trim();
      } else if (typeof value === 'object') {
        sanitized[key] = this.sanitizeResponseData(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  async getAccountBalance(): Promise<AccountBalance[]> {
    const result = await this.makeRequest('/v5/account/wallet-balance', 'GET', {
      accountType: 'UNIFIED'
    });
    return result.list?.[0]?.coin || [];
  }

  /**
   * Returns full wallet-balance response wrapped as { result: { list } }
   * so ExecutiveDashboard can access res.result.list[0].
   * accountType: 'UNIFIED' | 'CONTRACT' | 'SPOT'
   */
  async getWalletBalance(accountType: 'UNIFIED' | 'CONTRACT' | 'SPOT' = 'UNIFIED'): Promise<{ result: { list: any[] } } | null> {
    try {
      const result = await this.makeRequest('/v5/account/wallet-balance', 'GET', { accountType });
      // makeRequest returns data.result directly — wrap it back for the dashboard
      if (result && result.list) {
        return { result };
      }
      return null;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[getWalletBalance] error:', msg);
      return null;
    }
  }

  async getPositions(category: 'linear' | 'spot' = 'linear'): Promise<PositionInfo[]> {
    const result = await this.makeRequest('/v5/position/list', 'GET', {
      category
    });
    return result.list || [];
  }

  async setLeverage(symbol: string, leverage: number, category: 'linear' = 'linear') {
    const levStr = Math.min(5, Math.max(1, leverage)).toString();
    return await this.makeRequest('/v5/position/set-leverage', 'POST', {
      category,
      symbol,
      buyLeverage: levStr,
      sellLeverage: levStr
    });
  }

  async placeOrder(orderParams: OrderParams) {
    const category = orderParams.category || 'linear';
    return await this.makeRequest('/v5/order/create', 'POST', {
      category,
      tpslMode: 'Full',
      tpOrderType: 'Market',
      slOrderType: 'Market',
      ...orderParams
    });
  }

  /**
   * Sets or updates Take Profit, Stop Loss, and Trailing Stop directly on Bybit exchange servers
   * Endpoint: /v5/position/trading-stop
   */
  async setTradingStop(params: {
    symbol: string;
    category?: 'linear' | 'spot';
    takeProfit?: string;
    stopLoss?: string;
    trailingStop?: string;
    positionIdx?: number;
  }) {
    const category = params.category || 'linear';
    return await this.makeRequest('/v5/position/trading-stop', 'POST', {
      category,
      symbol: params.symbol,
      takeProfit: params.takeProfit || '0',
      stopLoss: params.stopLoss || '0',
      trailingStop: params.trailingStop || '0',
      tpslMode: 'Full',
      tpOrderType: 'Market',
      slOrderType: 'Market',
      positionIdx: params.positionIdx ?? 0
    });
  }

  async cancelOrder(orderId: string, symbol: string, category: 'linear' | 'spot' = 'linear') {
    return await this.makeRequest('/v5/order/cancel', 'POST', {
      category,
      orderId,
      symbol
    });
  }

  async getOrderHistory(symbol?: string, category: 'linear' | 'spot' = 'linear', limit: number = 50) {
    const params: any = {
      category,
      limit
    };
    if (symbol) {
      params.symbol = symbol;
    }
    const result = await this.makeRequest('/v5/order/history', 'GET', params);
    return result.list || [];
  }

  async getCurrentPrice(symbol: string, category: 'linear' | 'spot' = 'linear'): Promise<number> {
    const result = await this.makeRequest('/v5/market/tickers', 'GET', {
      category,
      symbol
    });
    if (!result.list || result.list.length === 0) {
      throw new Error(`No price data found for ${symbol}`);
    }
    return parseFloat(result.list[0].lastPrice);
  }

  async testConnection(): Promise<{ ok: boolean; msg: string }> {
    try {
      // Use authenticated endpoint to verify both connectivity AND credentials validity
      await this.makeRequest('/v5/account/wallet-balance', 'GET', {
        accountType: 'UNIFIED'
      });
      return { ok: true, msg: 'חיבור הצליח — API Key ו-Secret תקינים ✓' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { ok: false, msg: `חיבור נכשל: ${msg}` };
    }
  }
}

export function createRealBybitApi(apiKey: string, secretKey: string, testnet: boolean): RealBybitAPI {
  return new RealBybitAPI({ apiKey, secretKey, testnet });
}
export default RealBybitAPI;
