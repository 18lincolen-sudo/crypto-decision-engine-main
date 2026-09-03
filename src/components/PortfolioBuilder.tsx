
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import { usePortfolio } from '../hooks/usePortfolio';
import { CryptoData } from '@cde/engine';
import PortfolioSummary from './portfolio/PortfolioSummary';
import CurrentPortfolioItems from './portfolio/CurrentPortfolioItems';
import AddCryptoForm from './portfolio/AddCryptoForm';

interface PortfolioBuilderProps {
  availableCryptos: CryptoData[];
  onClose: () => void;
}

const PortfolioBuilder = ({ availableCryptos, onClose }: PortfolioBuilderProps) => {
  const { portfolio, addToPortfolio, removeFromPortfolio } = usePortfolio();
  const [selectedCrypto, setSelectedCrypto] = useState('');
  const [allocation, setAllocation] = useState(0);
  const [investmentAmount, setInvestmentAmount] = useState(0);

  const handleAddCrypto = () => {
    if (selectedCrypto && allocation > 0 && investmentAmount > 0) {
      const crypto = availableCryptos.find(c => c.symbol.toUpperCase() === selectedCrypto);
      if (crypto) {
        addToPortfolio(selectedCrypto, allocation, investmentAmount, crypto.current_price);
        setSelectedCrypto('');
        setAllocation(0);
        setInvestmentAmount(0);
      }
    }
  };

  const totalAllocation = portfolio?.items.reduce((sum, item) => sum + (item.allocation || 0), 0) || 0;
  const remainingAllocation = 100 - totalAllocation;
  const totalInvestment = portfolio?.items.reduce((sum, item) => sum + (item.investmentAmount || 0), 0) || 0;

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle>בניית תיק השקעות</CardTitle>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-6">
        <PortfolioSummary 
          totalInvestment={totalInvestment}
          totalAllocation={totalAllocation}
        />

        <CurrentPortfolioItems 
          items={portfolio?.items || []}
          availableCryptos={availableCryptos}
          onRemoveItem={removeFromPortfolio}
        />

        <AddCryptoForm 
          selectedCrypto={selectedCrypto}
          allocation={allocation}
          investmentAmount={investmentAmount}
          remainingAllocation={remainingAllocation}
          availableCryptos={availableCryptos}
          portfolioItems={portfolio?.items || []}
          onCryptoChange={setSelectedCrypto}
          onAllocationChange={setAllocation}
          onInvestmentAmountChange={setInvestmentAmount}
          onAddCrypto={handleAddCrypto}
        />
      </CardContent>
    </Card>
  );
};

export default PortfolioBuilder;
