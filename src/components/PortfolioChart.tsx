
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { PortfolioAnalysis } from '../types/crypto';

interface PortfolioChartProps {
  analysis: PortfolioAnalysis;
}

const PortfolioChart = ({ analysis }: PortfolioChartProps) => {
  // Real per-holding current values (derived from live prices) — no fabricated history
  const performanceData = (analysis?.holdings || [])
    .filter(h => h.currentValue > 0)
    .map(holding => ({
      name: holding.symbol,
      value: Number(holding.currentValue.toFixed(2)),
      investment: Number((holding.currentValue - holding.profit).toFixed(2)),
      profit: Number(holding.profit.toFixed(2))
    }));

  // Prepare allocation data from actual holdings
  const allocationData = (analysis?.holdings || []).map((holding, index) => ({
    name: holding.symbol,
    value: holding.currentValue,
    allocation: holding.allocation,
    color: `hsl(${index * 137.5}, 70%, 50%)`
  })).filter(item => item.value > 0);

  const colors = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884D8', '#FF6B6B', '#4ECDC4', '#45B7D1'];

  if (!analysis) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center p-6">
          <p className="text-muted-foreground">אין נתונים זמינים להצגת גרפים</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Portfolio Value by Holding (real, live-derived) */}
      <Card>
        <CardHeader>
          <CardTitle>ערך נוכחי לפי מטבע (חי)</CardTitle>
        </CardHeader>
        <CardContent>
          {performanceData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={performanceData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 12 }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 12 }}
                  tickFormatter={(value) => `$${(value || 0).toLocaleString()}`}
                />
                <Tooltip
                  formatter={(value: number) => [`$${(value || 0).toLocaleString()}`, 'ערך נוכחי']}
                  labelFormatter={(label) => `מטבע: ${label}`}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="#2563eb"
                  strokeWidth={2}
                  dot={false}
                  name="ערך נוכחי"
                />
                <Line
                  type="monotone"
                  dataKey="investment"
                  stroke="#dc2626"
                  strokeWidth={1}
                  strokeDasharray="5 5"
                  dot={false}
                  name="השקעה מקורית"
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[300px]">
              <p className="text-muted-foreground">אין החזקות להצגת ערכים חיים</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Portfolio Allocation Chart */}
      <Card>
        <CardHeader>
          <CardTitle>חלוקת התיק (לפי ערך נוכחי)</CardTitle>
        </CardHeader>
        <CardContent>
          {allocationData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={allocationData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, allocation }) => `${name || 'Unknown'} ${(allocation || 0).toFixed(1)}%`}
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {allocationData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: number, name: string, props: any) => [
                    `$${(value || 0).toLocaleString()}`,
                    `ערך ${props.payload.name}`
                  ]}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[300px]">
              <p className="text-muted-foreground">אין נתונים להצגת חלוקת התיק</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default PortfolioChart;
