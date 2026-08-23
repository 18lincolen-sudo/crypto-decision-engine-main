import { detectMarketRegime, evaluateSignals, routeTradeType, calculateRiskParameters, evaluateExit, calculateTradingFee, simulateSlippage, calculateATR } from '../src/services/tradeEngine';
import { coinGeckoApi } from '../src/services/coinGeckoApi';
import { bybitApi } from '../src/services/bybitApi';

console.log('imports OK', typeof detectMarketRegime, typeof coinGeckoApi.getCurrentPrices, typeof bybitApi.getKlineData);
const candles = [{ timestamp: 1, open: 100, high: 110, low: 90, close: 105, volume: 1 }];
const r = detectMarketRegime(candles as any, 105);
console.log('regime', JSON.stringify(r));
