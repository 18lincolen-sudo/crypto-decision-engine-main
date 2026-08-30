
import { useEffect, useState, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { coinGeckoApi } from '../services/coinGeckoApi';
import { Loader2, AlertTriangle } from 'lucide-react';
import { CryptoChartData } from '../types/crypto';

interface CryptoChartProps {
  symbol: string | null;
  isOpen: boolean;
  onClose: () => void;
}

const CryptoChart = ({ symbol, isOpen, onClose }: CryptoChartProps) => {
  const [chartData, setChartData] = useState<CryptoChartData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchChartData = useCallback(async () => {
    if (!symbol) return;
    
    setIsLoading(true);
    setError(null);
    try {
      const coinId = coinGeckoApi.getCoinId(symbol.toLowerCase());
      const historicalData = await coinGeckoApi.getHistoricalPrices(coinId, 30);
      const volumeData = await coinGeckoApi.getVolumeData(coinId, 30);

      const formattedData: CryptoChartData[] = historicalData.map((price, index) => ({
        date: new Date(price.timestamp).toLocaleDateString('he-IL'),
        price: price.price,
        volume: volumeData[index] || 0
      }));

      setChartData(formattedData);
    } catch (error) {
      console.error('Error fetching live chart data:', error);
      setChartData([]);
      setError('שגיאה בטעינת נתונים חיים מה-API. נסה שוב מאוחר יותר.');
    } finally {
      setIsLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    if (symbol && isOpen) {
      fetchChartData();
    }
  }, [symbol, isOpen, fetchChartData]);

  if (!symbol) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-center">
            גרפי {symbol} - 30 ימים אחרונים
          </DialogTitle>
          <DialogDescription className="sr-only">
            גרף מחיר ונפח עבור {symbol} ל-30 הימים האחרונים
          </DialogDescription>
        </DialogHeader>
        
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-center">
              <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
              <p>טוען נתוני גרף...</p>
            </div>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-center text-red-400">
              <AlertTriangle className="w-8 h-8 mx-auto mb-2" />
              <p>{error}</p>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Price Chart */}
            <Card>
              <CardHeader>
                <CardTitle>מחיר {symbol}</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis 
                      dataKey="date" 
                      tick={{ fontSize: 12 }}
                      interval="preserveStartEnd"
                    />
                    <YAxis 
                      tick={{ fontSize: 12 }}
                      tickFormatter={(value) => `$${value.toLocaleString()}`}
                    />
                    <Tooltip 
                      formatter={(value: number) => [`$${value.toLocaleString()}`, 'מחיר']}
                      labelFormatter={(label) => `תאריך: ${label}`}
                    />
                    <Line 
                      type="monotone" 
                      dataKey="price" 
                      stroke="#2563eb" 
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Volume Chart */}
            <Card>
              <CardHeader>
                <CardTitle>נפח מסחר {symbol}</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis 
                      dataKey="date" 
                      tick={{ fontSize: 12 }}
                      interval="preserveStartEnd"
                    />
                    <YAxis 
                      tick={{ fontSize: 12 }}
                      tickFormatter={(value) => `${(value / 1000000).toFixed(0)}M`}
                    />
                    <Tooltip 
                      formatter={(value: number) => [`${(value / 1000000).toFixed(0)}M`, 'נפח']}
                      labelFormatter={(label) => `תאריך: ${label}`}
                    />
                    <Bar dataKey="volume" fill="#10b981" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Chart Statistics */}
            <Card>
              <CardHeader>
                <CardTitle>סטטיסטיקות</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="text-center">
                    <div className="text-2xl font-bold">
                      ${Math.max(...chartData.map(d => d.price)).toLocaleString()}
                    </div>
                    <div className="text-sm text-muted-foreground">מחיר גבוה</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold">
                      ${Math.min(...chartData.map(d => d.price)).toLocaleString()}
                    </div>
                    <div className="text-sm text-muted-foreground">מחיר נמוך</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold">
                      ${(chartData.reduce((sum, d) => sum + d.price, 0) / chartData.length).toLocaleString()}
                    </div>
                    <div className="text-sm text-muted-foreground">מחיר ממוצע</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold">
                      {(((chartData[chartData.length - 1]?.price || 0) - (chartData[0]?.price || 0)) / (chartData[0]?.price || 1) * 100).toFixed(2)}%
                    </div>
                    <div className="text-sm text-muted-foreground">שינוי כולל</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default CryptoChart;
