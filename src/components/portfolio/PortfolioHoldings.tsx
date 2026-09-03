
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, BarChart3 } from 'lucide-react';
import { PortfolioAnalysis, CryptoRecommendation, CryptoData } from '@cde/engine';

interface PortfolioHoldingsProps {
  portfolioAnalysis: PortfolioAnalysis | null;
  recommendations: CryptoRecommendation[];
  cryptoData: CryptoData[] | null;
  onSelectCrypto: (crypto: CryptoRecommendation) => void;
  onSelectChart: (symbol: string) => void;
}

const PortfolioHoldings = ({ 
  portfolioAnalysis, 
  recommendations, 
  cryptoData, 
  onSelectCrypto, 
  onSelectChart 
}: PortfolioHoldingsProps) => {
  if (!portfolioAnalysis?.holdings || portfolioAnalysis.holdings.length === 0) {
    return null;
  }

  return (
    <div className="mb-8">
      <h3 className="text-xl font-semibold mb-4">החזקות בתיק</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {portfolioAnalysis.holdings.map((holding) => {
          const recommendation = recommendations.find(rec => rec.symbol === holding.symbol);
          const crypto = cryptoData?.find(c => c.symbol.toUpperCase() === holding.symbol);

          return (
            <Card key={holding.symbol} className="cursor-pointer hover:shadow-md transition-shadow">
              <CardHeader className="pb-3">
                <div className="flex justify-between items-start">
                  <CardTitle className="text-lg">{holding.symbol}</CardTitle>
                  <Badge className={`${
                    holding.profit >= 0 ? 'bg-green-500' : 'bg-red-500'
                  } text-white`}>
                    {holding.profit >= 0 ? '+' : ''}{holding.profitPercentage.toFixed(2)}%
                  </Badge>
                </div>
              </CardHeader>
              
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">כמות:</span>
                    <div className="font-medium">{holding.quantity.toFixed(6)}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">ערך נוכחי:</span>
                    <div className="font-medium">${holding.currentValue.toLocaleString()}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">הקצאה:</span>
                    <div className="font-medium">{holding.allocation.toFixed(1)}%</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">מחיר נוכחי:</span>
                    <div className="font-medium">${(crypto?.current_price || 0).toLocaleString()}</div>
                  </div>
                </div>

                <div className={`flex items-center justify-between p-2 rounded ${
                  holding.profit >= 0 ? 'bg-green-50' : 'bg-red-50'
                }`}>
                  <span className="text-sm font-medium">רווח/הפסד:</span>
                  <div className={`flex items-center ${
                    holding.profit >= 0 ? 'text-green-600' : 'text-red-600'
                  }`}>
                    {holding.profit >= 0 ? <TrendingUp className="w-4 h-4 mr-1" /> : <TrendingDown className="w-4 h-4 mr-1" />}
                    <span className="font-bold">
                      {holding.profit >= 0 ? '+' : ''}${holding.profit.toFixed(2)}
                    </span>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button 
                    size="sm" 
                    variant="outline" 
                    onClick={() => recommendation && onSelectCrypto(recommendation)}
                    className="flex-1"
                    disabled={!recommendation}
                  >
                    ניתוח
                  </Button>
                  <Button 
                    size="sm" 
                    variant="outline"
                    onClick={() => onSelectChart(holding.symbol)}
                    className="flex-1"
                  >
                    <BarChart3 className="w-4 h-4 mr-1" />
                    גרף
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
};

export default PortfolioHoldings;
