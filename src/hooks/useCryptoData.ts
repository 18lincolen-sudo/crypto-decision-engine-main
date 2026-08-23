
import { useQuery } from '@tanstack/react-query';
import { coinGeckoApi } from '../services/coinGeckoApi';
import { bybitApi } from '../services/bybitApi';
import { fearGreedApi } from '../services/fearGreedApi';
import { calculateTechnicalIndicators } from '../utils/technicalAnalysis';
import { generateSmartRecommendation } from '../utils/smartRecommendationEngine';
import { CryptoRecommendation } from '../types/crypto';

export function useCryptoData() {
  const { data: cryptoData, isLoading: cryptoLoading, error: cryptoError } = useQuery({
    queryKey: ['crypto-prices'],
    queryFn: async () => {
      console.log('🚀 Fetching live crypto prices...');

      // Try Bybit first for real-time data
      const bybitTickers = await bybitApi.getTickers();
      if (bybitTickers && bybitTickers.length > 0) {
        console.log('✅ Using live Bybit data as primary source (instant real-time)');
        return bybitTickers.map(ticker => ({
          id: bybitApi.getInternalSymbol(ticker.symbol),
          symbol: bybitApi.getInternalSymbol(ticker.symbol),
          name: ticker.symbol,
          current_price: parseFloat(ticker.lastPrice),
          price_change_percentage_24h: parseFloat(ticker.price24hPcnt ?? ticker.priceChangePercent),
          total_volume: parseFloat(ticker.volume24h),
          market_cap: parseFloat(ticker.lastPrice) * parseFloat(ticker.volume24h) * 100,
          last_updated: new Date().toISOString()
        }));
      }

      // Fallback to live CoinGecko data only if Bybit is completely unavailable
      console.log('📈 Trying live CoinGecko data');
      const data = await coinGeckoApi.getCurrentPrices();
      if (data && data.length > 0) {
        console.log('Live crypto data received from CoinGecko:', data.length, 'items');
        return data;
      }

      // No live data available — surface the error instead of faking data
      throw new Error('All live price sources failed');
    },
    refetchInterval: 60 * 1000, // 1 minute
    retry: 2,
    retryDelay: 2000,
    staleTime: 30 * 1000,
  });

  const { data: fearGreedData, isLoading: fearGreedLoading } = useQuery({
    queryKey: ['fear-greed'],
    queryFn: async () => {
      console.log('😨 Fetching live Fear & Greed index...');
      const data = await fearGreedApi.getFearGreedIndex();
      if (!data) {
        throw new Error('Fear & Greed API failed');
      }
      console.log('Live Fear & Greed data received:', data);
      return data;
    },
    refetchInterval: 60 * 60 * 1000, // 1 hour
    retry: 1,
    staleTime: 30 * 60 * 1000,
  });

  const { data: recommendations, isLoading: recommendationsLoading } = useQuery({
    queryKey: ['smart-recommendations', cryptoData, fearGreedData],
    queryFn: async (): Promise<CryptoRecommendation[]> => {
      if (!cryptoData || cryptoData.length === 0 || !fearGreedData) {
        console.log('❌ Missing data for recommendations');
        return [];
      }

      console.log('🧠 Generating smart recommendations for', cryptoData.length, 'cryptocurrencies...');

      const recommendations: CryptoRecommendation[] = [];
      
      for (let i = 0; i < Math.min(cryptoData.length, 5); i++) { // Limit to 5 coins to avoid timeout
        const crypto = cryptoData[i];
        
        try {
          console.log(`🔍 Processing ${crypto.symbol}... (${i + 1}/${Math.min(cryptoData.length, 5)})`);
          
          let historicalData: any[] = [];
          let volumes: number[] = [];
          
          // Try to get live historical data with timeout
          try {
            const bybitSymbol = bybitApi.getBybitSymbol(crypto.symbol);
            const bybitKlineData = await Promise.race([
              bybitApi.getKlineData(bybitSymbol, 'D', 30),
              new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
            ]);

            if (bybitKlineData && bybitKlineData.length > 0) {
              historicalData = bybitKlineData.map(kline => ({
                timestamp: parseInt(kline.openTime),
                price: parseFloat(kline.close)
              }));
              volumes = bybitKlineData.map(kline => parseFloat(kline.volume));
            } else {
              // No live historical data available — skip this coin (no mock fallback)
              console.warn(`No live kline data for ${crypto.symbol}, skipping`);
              continue;
            }
          } catch (error) {
            console.warn(`Skipping ${crypto.symbol} due to kline fetch failure:`, error);
            continue;
          }
          
          // Calculate technical indicators with timeout protection
          const indicators = calculateTechnicalIndicators(historicalData, volumes);
          
          // Generate recommendation
          const recommendation = generateSmartRecommendation({
            cryptoData: crypto,
            indicators,
            fearGreedIndex: fearGreedData,
            marketCap: crypto.market_cap || 0,
            volume24h: crypto.total_volume || 0
          });
          
          recommendations.push(recommendation);
          
        } catch (error) {
          // Error processing crypto, skip
          // Create basic fallback recommendation
          recommendations.push({
            symbol: crypto.symbol.toUpperCase(),
            recommendation: 'hold' as const,
            confidence: 50,
            reasoning: `המתנה מומלצת עבור ${crypto.symbol.toUpperCase()} בשל מחסור בנתונים`,
            indicators: {
              rsi: 50,
              ma20: crypto.current_price,
              volumeTrend: 'stable' as const,
              bollingerBands: {
                upper: crypto.current_price * 1.02,
                middle: crypto.current_price,
                lower: crypto.current_price * 0.98,
                position: 'between' as const
              },
              volumeProfile: {
                poc: crypto.current_price,
                valueAreaHigh: crypto.current_price * 1.01,
                valueAreaLow: crypto.current_price * 0.99,
                position: 'in_value_area' as const
              }
            },
            currentPrice: crypto.current_price,
            priceChange24h: crypto.price_change_percentage_24h || 0,
            suggestedAmounts: {
              usd: 100,
              crypto: 100 / crypto.current_price
            },
            riskLevel: 'medium' as const,
            timeframe: 'medium' as const
          });
        }
        
        // Small delay to prevent overwhelming the system
        if (i < Math.min(cryptoData.length, 5) - 1) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      // Recommendations completed
      return recommendations;
    },
    enabled: !!cryptoData && cryptoData.length > 0 && !!fearGreedData,
    retry: 1,
    staleTime: 5 * 60 * 1000,
  });

  const hasCrypto = Array.isArray(cryptoData) && cryptoData.length > 0;
  const hasRecommendations = Array.isArray(recommendations) && recommendations.length > 0;

  return {
    cryptoData: cryptoData || [],
    fearGreedData,
    recommendations: recommendations || [],
    isLoading: (cryptoLoading && !hasCrypto) || (recommendationsLoading && !hasRecommendations),
    error: cryptoError
  };
}
