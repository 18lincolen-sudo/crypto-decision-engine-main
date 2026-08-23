
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { X } from 'lucide-react';
import { PortfolioItem, CryptoData } from '../../types/crypto';

interface CurrentPortfolioItemsProps {
  items: PortfolioItem[];
  availableCryptos: CryptoData[];
  onRemoveItem: (symbol: string) => void;
}

const CurrentPortfolioItems = ({ items, availableCryptos, onRemoveItem }: CurrentPortfolioItemsProps) => {
  return (
    <div>
      <Label className="text-sm font-medium">התיק הנוכחי:</Label>
      <div className="mt-2 space-y-2 max-h-40 overflow-y-auto">
        {items.map((item) => {
          const crypto = availableCryptos.find(c => c.symbol.toUpperCase() === item.symbol);
          
          const safeInvestmentAmount = item.investmentAmount || 0;
          const safePurchasePrice = item.purchasePrice || 0;
          const safeCurrentPrice = crypto?.current_price || 0;
          const safeAllocation = item.allocation || 0;
          const safeQuantity = item.quantity || 0;
          
          const currentValue = safeQuantity * safeCurrentPrice;
          const profit = currentValue - safeInvestmentAmount;
          const profitPercentage = safeInvestmentAmount > 0 ? (profit / safeInvestmentAmount) * 100 : 0;

          return (
            <div key={item.symbol} className="flex justify-between items-center p-3 bg-muted rounded">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{item.symbol}</span>
                  <Badge variant="secondary">{safeAllocation.toFixed(1)}%</Badge>
                </div>
                <div className="text-sm text-muted-foreground">
                  כמות: {safeQuantity.toFixed(6)} | 
                  השקעה: ${safeInvestmentAmount.toLocaleString()}
                </div>
                <div className="text-sm text-muted-foreground">
                  קנייה: ${safePurchasePrice.toLocaleString()} | 
                  נוכחי: ${safeCurrentPrice.toLocaleString()}
                </div>
                <div className={`text-sm font-medium ${profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  ערך נוכחי: ${currentValue.toFixed(2)} | 
                  רווח: {profit >= 0 ? '+' : ''}${profit.toFixed(2)} ({profitPercentage >= 0 ? '+' : ''}{profitPercentage.toFixed(2)}%)
                </div>
              </div>
              <Button 
                variant="ghost" 
                size="sm"
                onClick={() => onRemoveItem(item.symbol)}
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          );
        })}
        {items.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">התיק ריק</p>
        )}
      </div>
    </div>
  );
};

export default CurrentPortfolioItems;
