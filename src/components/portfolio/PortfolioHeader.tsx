
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';

interface PortfolioHeaderProps {
  showPortfolioBuilder: boolean;
  onToggleBuilder: () => void;
}

const PortfolioHeader = ({ showPortfolioBuilder, onToggleBuilder }: PortfolioHeaderProps) => {
  return (
    <div className="mb-8">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-3xl font-bold">תיק השקעות</h1>
        <Button 
          onClick={onToggleBuilder}
          variant={showPortfolioBuilder ? "secondary" : "default"}
        >
          <Plus className="w-4 h-4 mr-2" />
          {showPortfolioBuilder ? 'סגור' : 'נהל תיק'}
        </Button>
      </div>
    </div>
  );
};

export default PortfolioHeader;
