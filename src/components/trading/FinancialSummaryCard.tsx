
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DollarSign } from 'lucide-react';

interface FinancialSummaryCardProps {
  portfolioSummary: any;
}

const FinancialSummaryCard: React.FC<FinancialSummaryCardProps> = ({
  portfolioSummary
}) => {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 font-mono text-lg sm:text-xl">
          <DollarSign className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" />
          <span className="truncate">סיכום כספי</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {portfolioSummary ? (
          <div className="space-y-2 sm:space-y-3">
            <div className="flex justify-between items-center gap-2">
              <span className="font-mono text-sm sm:text-base truncate">יתרה כוללת:</span>
              <span className="font-bold font-mono text-sm sm:text-base truncate">
                ${portfolioSummary.totalBalance.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between items-center gap-2">
              <span className="font-mono text-sm sm:text-base truncate">PnL יומי:</span>
              <span className={`font-bold font-mono text-sm sm:text-base truncate ${portfolioSummary.dailyPnL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                ${portfolioSummary.dailyPnL.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between items-center gap-2">
              <span className="font-mono text-sm sm:text-base truncate">פוזיציות פתוחות:</span>
              <span className="font-mono text-sm sm:text-base truncate">{portfolioSummary.openPositions}</span>
            </div>
          </div>
        ) : (
          <div className="text-center text-muted-foreground font-mono text-sm sm:text-base p-4">
            מחבר לחשבון...
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default FinancialSummaryCard;
