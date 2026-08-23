import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine
} from 'recharts';
import { Target, ShieldAlert, Crosshair, DollarSign, Loader2, Activity } from 'lucide-react';
import { formatFullPrice } from '@/utils/formatPrice';
import { getAggregatedCandles } from '@/services/cryptoPriceAggregator';

export interface LivePositionChartProps {
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'BUY' | 'SELL' | 'LONG' | 'SHORT';
  entryPrice: number;
  currentPrice: number;
  quantity?: number;
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
  quantity = 0,
  stopLoss,
  takeProfit,
  takeProfit1,
  breakEvenPrice,
  leverage = 1,
  unrealizedPnl,
  candles: externalCandles
}) => {
  const [internalCandles, setInternalCandles] = useState<{ timestamp: number; open: number; high: number; low: number; close: number }[]>([]);
  const [loadingCandles, setLoadingCandles] = useState(false);

  const isLong = side === 'BUY' || side === 'LONG';
  const effectiveTP = takeProfit || takeProfit1;
  const effectiveLeverage = leverage > 0 ? leverage : 1;

  // PnL calculations
  const priceDiff = isLong ? currentPrice - entryPrice : entryPrice - currentPrice;
  const pnlPercent = entryPrice > 0
    ? (priceDiff / entryPrice) * 100 * effectiveLeverage
    : 0;

  const effectivePnl = unrealizedPnl !== undefined
    ? unrealizedPnl
    : (quantity > 0 ? priceDiff * quantity * effectiveLeverage : 0);

  const isProfitable = effectivePnl >= 0;

  // Fetch candles if not provided externally
  useEffect(() => {
    if (externalCandles && externalCandles.length > 0) {
      setInternalCandles(externalCandles);
      return;
    }

    let active = true;
    setLoadingCandles(true);

    getAggregatedCandles(symbol, 30)
      .then((c) => {
        if (!active) return;
        if (c && c.length > 0) {
          setInternalCandles(c);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoadingCandles(false);
      });

    return () => {
      active = false;
    };
  }, [symbol, externalCandles]);

  const activeCandles = externalCandles && externalCandles.length > 0 ? externalCandles : internalCandles;

  // Build chart data
  const chartData = React.useMemo(() => {
    if (!activeCandles || activeCandles.length === 0) return [];
    
    const slice = activeCandles.slice(-24).map((c, i) => ({
      index: i,
      time: new Date(c.timestamp).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
      price: c.close,
      high: c.high,
      low: c.low
    }));

    // Append the very latest live market price point
    if (currentPrice > 0 && slice.length > 0) {
      slice[slice.length - 1] = {
        ...slice[slice.length - 1],
        price: currentPrice
      };
    }

    return slice;
  }, [activeCandles, currentPrice]);

  // Distance to targets calculation for fallback / visual bar
  const slDistancePercent = stopLoss && entryPrice > 0
    ? Math.abs((entryPrice - stopLoss) / entryPrice) * 100
    : 0;
  const tpDistancePercent = effectiveTP && entryPrice > 0
    ? Math.abs((effectiveTP - entryPrice) / entryPrice) * 100
    : 0;

  return (
    <Card className="border border-border/40 bg-card/60 backdrop-blur-md overflow-hidden transition-all duration-200 hover:border-primary/40">
      <CardHeader className="p-3 pb-2 border-b border-border/30 bg-muted/20">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="font-mono font-bold text-base">{symbol}</span>
            <Badge variant="outline" className={type === 'FUTURES' ? 'border-purple-500/50 text-purple-400 bg-purple-500/10' : 'border-cyan-500/50 text-cyan-400 bg-cyan-500/10'}>
              {type} {effectiveLeverage > 1 ? `${effectiveLeverage}x` : ''}
            </Badge>
            <Badge className={isLong ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40' : 'bg-rose-500/20 text-rose-400 border-rose-500/40'}>
              {side}
            </Badge>
          </div>

          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-muted-foreground">מחיר נוכחי:</span>
            <span className="font-mono font-bold text-sm sm:text-base">${formatFullPrice(currentPrice)}</span>
            <Badge className={`${isProfitable ? 'bg-emerald-600' : 'bg-rose-600'} text-white font-mono text-xs shadow-sm`}>
              {isProfitable ? '+' : ''}{pnlPercent.toFixed(2)}% ({isProfitable ? '+' : ''}${effectivePnl.toFixed(2)})
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-3 pt-2">
        {loadingCandles && chartData.length === 0 ? (
          <div className="h-44 w-full flex flex-col items-center justify-center gap-2 bg-black/20 rounded-md border border-border/20">
            <Loader2 className="w-5 h-5 text-primary animate-spin" />
            <span className="text-xs font-mono text-muted-foreground">טוען גרף מחיר חי...</span>
          </div>
        ) : chartData.length > 2 ? (
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
                  contentStyle={{ backgroundColor: 'rgba(15, 23, 42, 0.95)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '8px', fontSize: '11px' }}
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
        ) : (
          /* Fallback visual position tracker if candles could not be loaded */
          <div className="h-44 w-full flex flex-col justify-center px-4 py-3 bg-card/40 rounded-lg border border-border/30 space-y-4">
            <div className="flex items-center justify-between text-xs font-mono">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" />
                <span className="text-muted-foreground">מעקב מחיר שוק לפוזיציה</span>
              </div>
              <span className={isProfitable ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                {isProfitable ? 'רווח נוכחי: +' : 'הפסד נוכחי: '}{pnlPercent.toFixed(2)}%
              </span>
            </div>

            {/* Target Progress visualization */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-[11px] font-mono text-muted-foreground">
                <span className="text-rose-400">SL: ${formatFullPrice(stopLoss || entryPrice * (isLong ? 0.95 : 1.05))}</span>
                <span className="text-blue-400">כניסה: ${formatFullPrice(entryPrice)}</span>
                <span className="text-emerald-400">TP: ${formatFullPrice(effectiveTP || entryPrice * (isLong ? 1.05 : 0.95))}</span>
              </div>
              <div className="relative h-2 w-full bg-muted/40 rounded-full overflow-hidden">
                <div
                  className={`h-full ${isProfitable ? 'bg-emerald-500' : 'bg-rose-500'} transition-all duration-300`}
                  style={{
                    width: `${Math.min(100, Math.max(5, 50 + pnlPercent * 2))}%`
                  }}
                />
              </div>
              <div className="flex justify-between text-[10px] font-mono text-muted-foreground">
                <span>מרחק מ-SL: -{slDistancePercent.toFixed(1)}%</span>
                <span>מרחק מ-TP: +{tpDistancePercent.toFixed(1)}%</span>
              </div>
            </div>
          </div>
        )}

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
