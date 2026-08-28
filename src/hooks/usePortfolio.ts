
import { useState, useEffect } from 'react';
import { Portfolio, PortfolioItem, PortfolioAnalysis, CryptoRecommendation } from '../types/crypto';

const PORTFOLIO_STORAGE_KEY = 'crypto-portfolio';

export function usePortfolio() {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);

  useEffect(() => {
    const savedPortfolio = localStorage.getItem(PORTFOLIO_STORAGE_KEY);
    if (savedPortfolio) {
      const parsed = JSON.parse(savedPortfolio);
      // Migrate old portfolios that don't have quantity
      if (parsed.items) {
        parsed.items = parsed.items.map((item: Record<string, unknown>) => ({
          ...item,
          quantity: Number(item.quantity) || (Number(item.investmentAmount) / Number(item.purchasePrice)) || 0
        }));
      }
      setPortfolio(parsed);
    } else {
      // Create default portfolio
      const defaultPortfolio: Portfolio = {
        id: 'default',
        name: 'התיק שלי',
        items: [],
        totalInvestment: 0,
        totalProfit: 0,
        createdAt: new Date().toISOString()
      };
      setPortfolio(defaultPortfolio);
      localStorage.setItem(PORTFOLIO_STORAGE_KEY, JSON.stringify(defaultPortfolio));
    }
  }, []);

  const updatePortfolio = (newPortfolio: Portfolio) => {
    setPortfolio(newPortfolio);
    localStorage.setItem(PORTFOLIO_STORAGE_KEY, JSON.stringify(newPortfolio));
  };

  const addToPortfolio = (symbol: string, allocation: number, investmentAmount: number, purchasePrice: number) => {
    if (!portfolio) return;

    const existingIndex = portfolio.items.findIndex(item => item.symbol === symbol);
    let newItems: PortfolioItem[];

    const quantity = investmentAmount / purchasePrice;

    const newItem: PortfolioItem = {
      symbol,
      allocation,
      quantity,
      investmentAmount,
      purchasePrice,
      purchaseDate: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      // Update existing item - add to investment
      newItems = [...portfolio.items];
      const existingItem = newItems[existingIndex];
      const totalInvestment = existingItem.investmentAmount + investmentAmount;
      const totalQuantity = existingItem.quantity + quantity;
      const avgPrice = totalInvestment / totalQuantity;
      
      newItems[existingIndex] = {
        ...existingItem,
        allocation,
        quantity: totalQuantity,
        investmentAmount: totalInvestment,
        purchasePrice: avgPrice
      };
    } else {
      // Add new item
      newItems = [...portfolio.items, newItem];
    }

    // Normalize allocations to 100%
    const totalAllocation = newItems.reduce((sum, item) => sum + item.allocation, 0);
    if (totalAllocation > 100) {
      const factor = 100 / totalAllocation;
      newItems = newItems.map(item => ({
        ...item,
        allocation: Math.round(item.allocation * factor * 100) / 100
      }));
    }

    const totalInvestment = newItems.reduce((sum, item) => sum + item.investmentAmount, 0);

    updatePortfolio({
      ...portfolio,
      items: newItems,
      totalInvestment
    });
  };

  const removeFromPortfolio = (symbol: string) => {
    if (!portfolio) return;

    const newItems = portfolio.items.filter(item => item.symbol !== symbol);
    const totalInvestment = newItems.reduce((sum, item) => sum + item.investmentAmount, 0);

    updatePortfolio({
      ...portfolio,
      items: newItems,
      totalInvestment
    });
  };

  const calculatePortfolioAnalysis = (recommendations: CryptoRecommendation[]): PortfolioAnalysis | null => {
    if (!portfolio || portfolio.items.length === 0) return null;

    let totalValue = 0;
    let totalInvestment = 0;
    let weightedPerformance = 0;
    let buySignals = 0;
    let sellSignals = 0;

    const holdings: PortfolioAnalysis['holdings'] = [];

    portfolio.items.forEach(item => {
      const recommendation = recommendations.find(rec => rec.symbol === item.symbol);
      const currentPrice = recommendation?.currentPrice || 0;
      
      // Calculate current value based on quantity and current price
      const currentValue = item.quantity * currentPrice;
      const profit = currentValue - item.investmentAmount;
      const profitPercentage = item.investmentAmount > 0 ? (profit / item.investmentAmount) * 100 : 0;
      
      // Calculate actual allocation based on current values
      totalValue += currentValue;
      totalInvestment += item.investmentAmount;
      
      holdings.push({
        symbol: item.symbol,
        currentValue,
        allocation: 0, // Will be calculated after we have totalValue
        quantity: item.quantity,
        profit,
        profitPercentage
      });

      if (recommendation) {
        const weight = currentValue / totalValue || 0;
        weightedPerformance += recommendation.priceChange24h * weight;

        if (recommendation.recommendation === 'buy') buySignals++;
        else if (recommendation.recommendation === 'sell') sellSignals++;
      }
    });

    // Calculate actual allocations based on current values
    holdings.forEach(holding => {
      holding.allocation = totalValue > 0 ? (holding.currentValue / totalValue) * 100 : 0;
    });

    const totalProfit = totalValue - totalInvestment;
    const totalProfitPercentage = totalInvestment > 0 ? (totalProfit / totalInvestment) * 100 : 0;
    
    // Calculate daily profit based on 24h performance
    const dailyProfit = (totalValue * weightedPerformance) / 100;

    // Overall recommendation logic
    const portfolioRecommendations = recommendations.filter(rec => 
      portfolio.items.some(item => item.symbol === rec.symbol)
    );

    const buyRatio = portfolioRecommendations.length > 0 ? buySignals / portfolioRecommendations.length : 0;
    const sellRatio = portfolioRecommendations.length > 0 ? sellSignals / portfolioRecommendations.length : 0;

    let overallRec: 'buy' | 'sell' | 'hold' = 'hold';
    let confidence = 50;
    let reasoning = '';

    if (buyRatio > 0.6) {
      overallRec = 'buy';
      confidence = Math.round(buyRatio * 100);
      reasoning = `${buySignals} מתוך ${portfolioRecommendations.length} מטבעות מציגים אותות קנייה חזקים`;
    } else if (sellRatio > 0.6) {
      overallRec = 'sell';
      confidence = Math.round(sellRatio * 100);
      reasoning = `${sellSignals} מתוך ${portfolioRecommendations.length} מטבעות מציגים אותות מכירה`;
    } else {
      reasoning = 'אותות מעורבים בתיק, מומלץ להמתין או לבצע פעולות זהירות';
    }

    return {
      totalValue,
      totalInvestment,
      totalProfit,
      totalProfitPercentage,
      performance24h: weightedPerformance,
      dailyProfit,
      recommendations: {
        overall: overallRec,
        confidence,
        reasoning
      },
      cryptoAnalysis: portfolioRecommendations,
      holdings
    };
  };

  return {
    portfolio,
    addToPortfolio,
    removeFromPortfolio,
    updatePortfolio,
    calculatePortfolioAnalysis
  };
}
