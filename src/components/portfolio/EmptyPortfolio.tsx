
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Coins, Plus } from 'lucide-react';

interface EmptyPortfolioProps {
  onStartBuilding: () => void;
}

const EmptyPortfolio = ({ onStartBuilding }: EmptyPortfolioProps) => {
  return (
    <Card>
      <CardContent className="flex items-center justify-center p-12">
        <div className="text-center">
          <Coins className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-xl font-semibold mb-2">התיק ריק</h3>
          <p className="text-muted-foreground mb-4">
            התחל לבנות את תיק השקעות שלך על ידי הוספת מטבעות קריפטו
          </p>
          <Button onClick={onStartBuilding}>
            <Plus className="w-4 h-4 mr-2" />
            הוסף השקעה ראשונה
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

export default EmptyPortfolio;
