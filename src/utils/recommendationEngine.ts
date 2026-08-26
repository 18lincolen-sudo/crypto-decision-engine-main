import { CryptoRecommendation, RecommendationType, TechnicalIndicators, CryptoData, FearGreedIndex } from '../types/crypto';

interface RecommendationParams {
  cryptoData: CryptoData;
  indicators: TechnicalIndicators;
  fearGreedIndex: FearGreedIndex;
}

// Helper function to calculate suggested amounts based on market conditions
function calculateSuggestedAmounts(
  recommendation: RecommendationType,
  confidence: number,
  currentPrice: number,
  marketCap: number,
  volume24h: number
) {
  // Base amounts in USD
  const baseInvestment = 1000; // $1000 base investment
  
  // Adjust based on confidence
  const confidenceMultiplier = confidence / 100;
  
  // Adjust based on market cap (smaller cap = smaller amounts). marketCap <= 0
  // means it's genuinely unknown (Bybit/Binance ticker data has no supply
  // figure to compute a real market cap from) — treat as neutral rather than
  // silently assuming the worst (smallest, riskiest) tier.
  let marketCapMultiplier = 1;
  if (marketCap > 0) {
    if (marketCap < 100000000) { // Under $100M market cap
      marketCapMultiplier = 0.3;
    } else if (marketCap < 1000000000) { // Under $1B market cap
      marketCapMultiplier = 0.6;
    } else if (marketCap < 10000000000) { // Under $10B market cap
      marketCapMultiplier = 0.8;
    }
  }

  // Adjust based on volume (lower volume = smaller amounts)
  const volumeToMarketCapRatio = marketCap > 0 ? volume24h / marketCap : 0;
  let volumeMultiplier = Math.min(volumeToMarketCapRatio * 10, 1); // Cap at 1
  volumeMultiplier = Math.max(volumeMultiplier, 0.1); // Floor at 0.1
  
  const finalMultiplier = confidenceMultiplier * marketCapMultiplier * volumeMultiplier;
  
  let suggestedUsdAmount = 0;
  let suggestedCryptoAmount = 0;
  
  if (recommendation === 'buy') {
    suggestedUsdAmount = Math.round(baseInvestment * finalMultiplier);
    suggestedCryptoAmount = suggestedUsdAmount / currentPrice;
  } else if (recommendation === 'sell') {
    // For sell recommendations, suggest selling a percentage based on confidence
    const sellPercentage = Math.min(confidence / 100 * 0.5, 0.8); // Max 80% sell
    suggestedUsdAmount = Math.round(baseInvestment * finalMultiplier);
    suggestedCryptoAmount = (suggestedUsdAmount / currentPrice) / (1 - sellPercentage);
  }
  
  return {
    suggestedUsdAmount: Math.max(suggestedUsdAmount, 50), // Minimum $50
    suggestedCryptoAmount: Math.max(suggestedCryptoAmount, 0.001), // Minimum amount
    confidenceMultiplier,
    marketCapMultiplier,
    volumeMultiplier
  };
}

export function generateRecommendation({
  cryptoData,
  indicators,
  fearGreedIndex
}: RecommendationParams): CryptoRecommendation {
  const { rsi, ma20, volumeTrend, bollingerBands, volumeProfile } = indicators;
  const currentPrice = cryptoData.current_price;
  const priceChange24h = cryptoData.price_change_percentage_24h || 0;
  const marketCap = cryptoData.market_cap || 0;
  const volume24h = cryptoData.total_volume || 0;
  
  let recommendation: RecommendationType = 'hold';
  let confidence = 0;
  let reasoning = '';
  
  console.log(`Analyzing ${cryptoData.symbol}:`, {
    currentPrice,
    priceChange24h,
    rsi,
    ma20,
    volumeTrend,
    bollingerBands,
    volumeProfile,
    fearGreedIndex: fearGreedIndex.value,
    marketCap,
    volume24h
  });
  
  // Fear & Greed factor
  const isFearful = fearGreedIndex.value < 25;
  const isGreedy = fearGreedIndex.value > 75;
  
  // RSI Analysis
  const isOversold = rsi < 30;
  const isOverbought = rsi > 70;
  const isNeutralRSI = rsi >= 40 && rsi <= 60;
  
  // Price vs Moving Average
  const belowMA = currentPrice < ma20;
  const aboveMA = currentPrice > ma20;
  const priceDiffPercent = ((currentPrice - ma20) / ma20) * 100;
  
  // Bollinger Bands Analysis
  const belowLowerBB = bollingerBands.position === 'below';
  const aboveUpperBB = bollingerBands.position === 'above';
  const betweenBB = bollingerBands.position === 'between';
  
  // Volume Profile Analysis
  const nearPOC = Math.abs(currentPrice - volumeProfile.poc) / currentPrice < 0.02; // 2% tolerance
  const inValueArea = volumeProfile.position === 'in_value_area';
  const aboveValueArea = volumeProfile.position === 'above_vah';
  const belowValueArea = volumeProfile.position === 'below_val';
  
  // Volume confirmation
  const volumeSupport = volumeTrend === 'increasing';
  const volumeDecline = volumeTrend === 'decreasing';
  
  // Market momentum
  const strongUptrend = priceChange24h > 5;
  const strongDowntrend = priceChange24h < -5;
  
  // Enhanced Buy signals with new indicators
  if (isOversold && belowLowerBB && isFearful && volumeSupport && belowValueArea) {
    recommendation = 'buy';
    confidence = 98;
    reasoning = `🎯 אות קנייה חזק מאוד: RSI oversold (${rsi.toFixed(1)}), מחיר מתחת ל-Bollinger Lower Band (${bollingerBands.lower.toFixed(2)}), פחד קיצוני בשוק (${fearGreedIndex.value}), נפח עולה, ומחיר מתחת ל-Value Area`;
  } else if (isOversold && (belowLowerBB || belowValueArea) && isFearful) {
    recommendation = 'buy';
    confidence = 90;
    reasoning = `💚 אות קנייה חזק: RSI oversold (${rsi.toFixed(1)}), מחיר בזון oversold (BB או VP), פחד בשוק (${fearGreedIndex.value})`;
  } else if (belowMA && belowLowerBB && volumeSupport) {
    recommendation = 'buy';
    confidence = 85;
    reasoning = `📈 אות קנייה: מחיר מתחת לממוצע נע ו-Bollinger Lower, נפח גבוה - זמן טוב לרכישה`;
  } else if (isOversold || belowLowerBB || (belowValueArea && nearPOC)) {
    recommendation = 'buy';
    confidence = 75;
    reasoning = `🔄 אות קנייה בינוני: ${isOversold ? 'RSI נמוך' : belowLowerBB ? 'מחיר מתחת ל-Bollinger' : 'קרוב ל-POC בזון נמוך'} - שקול רכישה הדרגתית`;
  }
  // Enhanced Sell signals with new indicators
  else if (isOverbought && aboveUpperBB && isGreedy && !volumeDecline && aboveValueArea) {
    recommendation = 'sell';
    confidence = 95;
    reasoning = `🔴 אות מכירה חזק מאוד: RSI overbought (${rsi.toFixed(1)}), מחיר מעל Bollinger Upper Band (${bollingerBands.upper.toFixed(2)}), חמדנות בשוק (${fearGreedIndex.value}), מעל Value Area High`;
  } else if (isOverbought && (aboveUpperBB || aboveValueArea) && strongUptrend) {
    recommendation = 'sell';
    confidence = 88;
    reasoning = `⚠️ אות מכירה חזק: RSI overbought (${rsi.toFixed(1)}), מחיר בזון overbought עם עלייה של ${priceChange24h.toFixed(1)}%`;
  } else if (aboveMA && aboveUpperBB && isGreedy) {
    recommendation = 'sell';
    confidence = 80;
    reasoning = `📊 שקול מכירה: מחיר מעל ממוצע נע ו-Bollinger Upper עם חמדנות בשוק`;
  } else if (isOverbought || aboveUpperBB || (aboveValueArea && priceDiffPercent > 10)) {
    recommendation = 'sell';
    confidence = 70;
    reasoning = `⚠️ שקול מכירה: ${isOverbought ? 'RSI גבוה' : aboveUpperBB ? 'מעל Bollinger Upper' : 'מעל Value Area עם פרמיום גבוה'}`;
  }
  // Enhanced Hold conditions
  else if (isNeutralRSI && betweenBB && inValueArea && Math.abs(priceDiffPercent) < 3) {
    recommendation = 'hold';
    confidence = 85;
    reasoning = `⚖️ מצב יציב מעולה: RSI נייטרלי (${rsi.toFixed(1)}), מחיר בין רצועות Bollinger ובתוך Value Area - המתן לאותות ברורים יותר`;
  } else if (betweenBB && inValueArea) {
    recommendation = 'hold';
    confidence = 75;
    reasoning = `🎯 מחיר באיזור הוגן: בין רצועות Bollinger ובתוך Value Area - המתן לפריצה לכיוון כלשהו`;
  } else if (strongDowntrend && !isOversold && !belowLowerBB) {
    recommendation = 'hold';
    confidence = 65;
    reasoning = `⏳ המתן: ירידה חזקה של ${Math.abs(priceChange24h).toFixed(1)}% אך עדיין לא בזון oversold - המתן לרמות נמוכות יותר`;
  } else {
    recommendation = 'hold';
    confidence = 55;
    reasoning = `🤔 אותות מעורבים: RSI ${rsi.toFixed(1)}, BB ${bollingerBands.position}, VP ${volumeProfile.position} - המתן להבהרה`;
  }
  
  // Adjust confidence based on volume and additional factors
  if (volumeSupport && (recommendation === 'buy' || recommendation === 'sell')) {
    confidence = Math.min(98, confidence + 5);
  }
  
  if (volumeDecline && (recommendation === 'buy' || recommendation === 'sell')) {
    confidence = Math.max(30, confidence - 10);
  }
  
  // Additional confidence from multiple indicators alignment
  if (recommendation === 'buy' && isOversold && belowLowerBB && belowValueArea) {
    confidence = Math.min(98, confidence + 8);
  }
  
  if (recommendation === 'sell' && isOverbought && aboveUpperBB && aboveValueArea) {
    confidence = Math.min(98, confidence + 8);
  }
  
  // Calculate suggested amounts based on current market conditions
  const amounts = calculateSuggestedAmounts(
    recommendation, 
    confidence, 
    currentPrice, 
    marketCap, 
    volume24h
  );
  
  // Enhanced time-based recommendations with amounts
  const now = new Date();
  const israelTime = new Date(now.getTime() + (2 * 60 * 60 * 1000)); // Israel timezone
  const israelHour = israelTime.getHours();
  
  if (recommendation === 'buy') {
    reasoning += ` | 💰 סכום מומלץ: ${amounts.suggestedUsdAmount}$ (${amounts.suggestedCryptoAmount.toFixed(6)} ${cryptoData.symbol.toUpperCase()})`;
    
    if (belowLowerBB && belowValueArea) {
      reasoning += ` | 🎯 זון קנייה מעולה: מתחת ל-BB ומתחת ל-Value Area`;
    }
  } else if (recommendation === 'sell') {
    const sellValue = amounts.suggestedCryptoAmount * currentPrice;
    reasoning += ` | 💸 כמות מומלצת למכירה: ${amounts.suggestedCryptoAmount.toFixed(6)} ${cryptoData.symbol.toUpperCase()} (~${sellValue.toFixed(0)}$)`;
    
    if (aboveUpperBB && aboveValueArea) {
      reasoning += ` | ⚠️ זון מכירה מעולה: מעל BB ומעל Value Area High`;
    }
  }
  
  console.log(`Final recommendation for ${cryptoData.symbol}:`, {
    recommendation,
    confidence,
    reasoning,
    amounts,
    indicators: {
      rsi,
      bollingerBands,
      volumeProfile
    }
  });
  
  return {
    symbol: cryptoData.symbol.toUpperCase(),
    recommendation,
    confidence,
    reasoning,
    indicators,
    currentPrice,
    priceChange24h,
    suggestedAmounts: {
      usd: amounts.suggestedUsdAmount,
      crypto: amounts.suggestedCryptoAmount
    }
  };
}
