
interface PortfolioSummaryProps {
  totalInvestment: number;
  totalAllocation: number;
}

const PortfolioSummary = ({ totalInvestment, totalAllocation }: PortfolioSummaryProps) => {
  return (
    <div className="p-4 bg-muted rounded-lg">
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-muted-foreground">סה"כ השקעה:</span>
          <div className="font-bold text-lg">${totalInvestment.toLocaleString()}</div>
        </div>
        <div>
          <span className="text-muted-foreground">סה"כ הקצאה:</span>
          <div className="font-bold text-lg">{totalAllocation.toFixed(1)}%</div>
        </div>
      </div>
    </div>
  );
};

export default PortfolioSummary;
