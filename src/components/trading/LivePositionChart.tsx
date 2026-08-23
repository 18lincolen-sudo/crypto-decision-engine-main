import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine
} from 'recharts';
import { TrendingUp, TrendingDown, Target, ShieldAlert, Crosshair, DollarSign } from 'lucide-react';
import { formatFullPrice } from '@/utils/formatPrice';

export interface LivePositionChartProps {
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'BUY' | 'SELL' | 'LONG' | 'SHORT';
  entryPrice: number;
  currentPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  takeProfit1?: number;
  breakEvenPrice?: number;
  leverage?: number;
  unrealizedPnl?: number;
  candles?: { timestamp: number; open: number; high: number; low: number; close: number }[];
}

export const LivePositionChart: React.FC<LivePositionChartProps> = ({
  symbol,
  type,
  side,
  entryPrice,
  currentPrice,
  stopLoss,
  takeProfit,
  takeProfit1,
  breakEvenPrice,
  leverage = 1,
  unrealizedPnl = 0,
  candles = []
}) => {
  const isLong = side === 'BUY' || side === 'LONG';
  const effectiveTP = takeProfit || takeProfit1;
  const isProfitable = unrealizedPnl >= 0;

  // Build chart points from live candles only (no mock/fake fallback)
  const chartData = React.useMemo(() => {
    if (candles && candles.length > 5) {
      return candles.slice(-20).map((c, i) => ({
        index: i,
        time: new Date(c.timestamp).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
        price: c.close,
        high: c.high,
        low: c.low
      }));
    }
    return [];
  }, [candles]);

  const pnlPercent = entryPrice > 0
    ? (isLong ? (currentPrice - entryPrice) / entryPrice : (entryPrice - currentPrice) / entryPrice) * 100 * leverage
    : 0;

  return (
    <Card className="border border-border/40 bg-card/60 backdrop-blur-md overflow-hidden">
      <CardHeader className="p-3 pb-2 border-b border-border/30 bg-muted/20">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="font-mono font-bold text-base">{symbol}</span>
            <Badge variant="outline" className={type === 'FUTURES' ? 'border-primary/50 text-primary' : 'border-blue-500/50 text-blue-400'}>
              {type} {leverage > 1 ? `${leverage}x` : ''}
            </Badge>
            <Badge className={isLong ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40' : 'bg-rose-500/20 text-rose-400 border-rose-500/40'}>
              {side}
            </Badge>
          </div>

          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-muted-foreground">מחיר נוכחי:</span>
            <span className="font-mono font-bold text-sm sm:text-base">${formatFullPrice(currentPrice)}</span>
            <Badge className={isProfitable ? 'bg-emerald-600 text-white font-mono text-xs' : 'bg-rose-600 text-white font-mono text-xs'}>
              {isProfitable ? '+' : ''}{pnlPercent.toFixed(2)}% ({isProfitable ? '+' : ''}${unrealizedPnl.toFixed(2)})
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-3 pt-2">
        <div className="h-44 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id={`grad-${symbol}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={isProfitable ? '#10b981' : '#f43f5e'} stopOpacity={0.4} />
                  <stop offset="95%" stopColor={isProfitable ? '#10b981' : '#f43f5e'} stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="time" stroke="#71717a" fontSize={10} tickLine={false} />
              <YAxis stroke="#71717a" fontSize={10} domain={['auto', 'auto']} tickLine={false} />
              <Tooltip
                contentStyle={{ backgroundColor: 'rgba(15, 23, 42, 0.9)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', fontSize: '11px' }}
                formatter={(val: any) => [`$${formatFullPrice(Number(val))}`, 'מחיר']}
              />
              <Area type="monotone" dataKey="price" stroke={isProfitable ? '#10b981' : '#f43f5e'} strokeWidth={2} fill={`url(#grad-${symbol})`} />

              {/* Entry Price Reference */}
              <ReferenceLine y={entryPrice} stroke="#3b82f6" strokeDasharray="3 3" label={{ value: `כניסה: $${formatFullPrice(entryPrice)}`, fill: '#60a5fa', fontSize: 10, position: 'insideTopLeft' }} />

              {/* Stop Loss Reference */}
              {stopLoss && (
                <ReferenceLine y={stopLoss} stroke="#ef4444" strokeWidth={1.5} label={{ value: `SL: $${formatFullPrice(stopLoss)}`, fill: '#f87171', fontSize: 10, position: 'insideBottomLeft' }} />
              )}

              {/* Take Profit Reference */}
              {effectiveTP && (
                <ReferenceLine y={effectiveTP} stroke="#10b981" strokeWidth={1.5} label={{ value: `TP: $${formatFullPrice(effectiveTP)}`, fill: '#34d399', fontSize: 10, position: 'insideTopRight' }} />
              )}

              {/* Break-Even Reference */}
              {breakEvenPrice && (
                <ReferenceLine y={breakEvenPrice} stroke="#a855f7" strokeDasharray="2 2" label={{ value: `Break-Even: $${formatFullPrice(breakEvenPrice)}`, fill: '#c084fc', fontSize: 10, position: 'insideBottomRight' }} />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2 pt-2 border-t border-border/30 text-xs font-mono">
          <div className="flex items-center gap-1 text-muted-foreground">
            <Crosshair className="w-3.5 h-3.5 text-blue-400" />
            <span>כניסה: </span>
            <span className="text-foreground font-semibold">${formatFullPrice(entryPrice)}</span>
          </div>
          {stopLoss && (
            <div className="flex items-center gap-1 text-muted-foreground">
              <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
              <span>SL: </span>
              <span className="text-rose-400 font-semibold">${formatFullPrice(stopLoss)}</span>
            </div>
          )}
          {effectiveTP && (
            <div className="flex items-center gap-1 text-muted-foreground">
              <Target className="w-3.5 h-3.5 text-emerald-400" />
              <span>TP: </span>
              <span className="text-emerald-400 font-semibold">${formatFullPrice(effectiveTP)}</span>
            </div>
          )}
          {breakEvenPrice && (
            <div className="flex items-center gap-1 text-muted-foreground">
              <DollarSign className="w-3.5 h-3.5 text-purple-400" />
              <span>BE: </span>
              <span className="text-purple-400 font-semibold">${formatFullPrice(breakEvenPrice)}</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default LivePositionChart;
