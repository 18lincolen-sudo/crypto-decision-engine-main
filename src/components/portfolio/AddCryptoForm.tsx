
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Plus } from 'lucide-react';
import { CryptoData, PortfolioItem } from '@cde/engine';

interface AddCryptoFormProps {
  selectedCrypto: string;
  allocation: number;
  investmentAmount: number;
  remainingAllocation: number;
  availableCryptos: CryptoData[];
  portfolioItems: PortfolioItem[];
  onCryptoChange: (crypto: string) => void;
  onAllocationChange: (allocation: number) => void;
  onInvestmentAmountChange: (amount: number) => void;
  onAddCrypto: () => void;
}

const AddCryptoForm = ({
  selectedCrypto,
  allocation,
  investmentAmount,
  remainingAllocation,
  availableCryptos,
  portfolioItems,
  onCryptoChange,
  onAllocationChange,
  onInvestmentAmountChange,
  onAddCrypto
}: AddCryptoFormProps) => {
  const selectedCryptoData = availableCryptos.find(c => c.symbol.toUpperCase() === selectedCrypto);
  const isFormValid = selectedCrypto && allocation > 0 && allocation <= remainingAllocation && investmentAmount > 0;

  return (
    <div className="space-y-4 border-t pt-4">
      <Label className="text-sm font-medium">הוסף מטבע לתיק:</Label>
      
      <div>
        <Label htmlFor="crypto-select">מטבע:</Label>
        <select 
          id="crypto-select"
          value={selectedCrypto}
          onChange={(e) => onCryptoChange(e.target.value)}
          className="w-full mt-1 p-2 border rounded"
        >
          <option value="">בחר מטבע</option>
          {availableCryptos
            .filter(crypto => !portfolioItems.some(item => item.symbol === crypto.symbol.toUpperCase()))
            .map(crypto => (
            <option key={crypto.id} value={crypto.symbol.toUpperCase()}>
              {crypto.symbol.toUpperCase()} - {crypto.name} (${(crypto.current_price || 0).toLocaleString()})
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="allocation">אחוז בתיק (%):</Label>
          <Input
            id="allocation"
            type="number"
            min="1"
            max={remainingAllocation}
            value={allocation || ''}
            onChange={(e) => onAllocationChange(Number(e.target.value))}
            placeholder={`עד ${remainingAllocation.toFixed(1)}%`}
          />
        </div>

        <div>
          <Label htmlFor="investment">סכום השקעה ($):</Label>
          <Input
            id="investment"
            type="number"
            min="1"
            value={investmentAmount || ''}
            onChange={(e) => onInvestmentAmountChange(Number(e.target.value))}
            placeholder="סכום בדולרים"
          />
        </div>
      </div>

      {selectedCrypto && investmentAmount > 0 && selectedCryptoData && (
        <div className="p-3 bg-blue-50 rounded-lg text-sm">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-muted-foreground">מטבע:</span>
              <div className="font-medium">{selectedCrypto}</div>
            </div>
            <div>
              <span className="text-muted-foreground">מחיר נוכחי:</span>
              <div className="font-medium">
                ${selectedCryptoData.current_price.toLocaleString()}
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">כמות שתרכש:</span>
              <div className="font-medium">
                {(investmentAmount / selectedCryptoData.current_price).toFixed(6)} {selectedCrypto}
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">השקעה:</span>
              <div className="font-medium">${investmentAmount.toLocaleString()}</div>
            </div>
          </div>
        </div>
      )}

      <Button 
        onClick={onAddCrypto}
        disabled={!isFormValid}
        className="w-full"
      >
        <Plus className="w-4 h-4 mr-2" />
        הוסף לתיק
      </Button>
    </div>
  );
};

export default AddCryptoForm;
