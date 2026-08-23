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
  ReferenceLine,
  ReferenceDot
} from 'recharts';
import { Target, ShieldAlert, Crosshair, DollarSign, Loader2, Activity, ShoppingBag } from 'lucide-react';
import { formatFullPrice } from '@/utils/formatPrice';
import { getAggregatedCandles } from '@/services/cryptoPriceAggregator';

export interface LivePositionChartProps {
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'BUY' | 'SELL' | 'LONG' | 'SHORT';
  entryPrice: number;
  currentPrice: number;
  quantity?: number;
  openedAt?: string;
  openTimestamp?: number;
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
  openedAt,
  openTimestamp,
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
      timestamp: c.timestamp,
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

  // Find nearest candle for entry marker if available
  const entryTimeKey = React.useMemo(() => {
    if (!chartData.length || !openTimestamp) return chartData[0]?.time;
    // Find closest candle in time
    let closest = chartData[0];
    let minDiff = Math.abs(closest.timestamp - openTimestamp);
    for (const pt of chartData) {
      const diff = Math.abs(pt.timestamp - openTimestamp);
      if (diff < minDiff) {
        minDiff = diff;
        closest = pt;
      }
    }
    return closest?.time || chartData[0]?.time;
  }, [chartData, openTimestamp]);

  // Distance to targets calculation for fallback / visual bar
  const slDistancePercent = stopLoss && entryPrice > 0
    ? Math.abs((entryPrice - stopLoss) / entryPrice) * 100
    : 0;
  const tpDistancePercent = effectiveTP && entryPrice > 0
    ? Math.abs((effectiveTP - entryPrice) / entryPrice) * 100
    : 0;

  // Custom SVG Buy Tag label on the Reference Line
  const renderBuyTagLabel = (props: any) => {
    const { viewBox } = props;
    const x = viewBox?.x || 10;
    const y = viewBox?.y || 20;
    const buyTagText = isLong
      ? `🟢 נקנה ב-$${formatFullPrice(entryPrice)}${openedAt ? ` (${openedAt})` : ''}`
      : `🔴 כניסה SHORT ב-$${formatFullPrice(entryPrice)}${openedAt ? ` (${openedAt})` : ''}`;
    const boxWidth = Math.min(220, buyTagText.length * 6.8 + 24);

    return (
      <g transform={`translate(${x + 10}, ${y - 12})`}>
        {/* Glow effect */}
        <rect
          x={-1}
          y={-1}
          width={boxWidth + 2}
          height={24}
          rx={6}
          fill={isLong ? '#10b981' : '#f43f5e'}
          opacity={0.3}
        />
        {/* Main tag background */}
        <rect
          x={0}
          y={0}
          width={boxWidth}
          height={22}
          rx={5}
          fill={isLong ? '#064e3b' : '#881337'}
          stroke={isLong ? '#34d399' : '#fb7185'}
          strokeWidth={1.5}
          filter="drop-shadow(0 2px 4px rgba(0,0,0,0.6))"
        />
        {/* Buy Tag text */}
        <text
          x={boxWidth / 2}
          y={15}
          textAnchor="middle"
          fill="#ffffff"
          fontSize={10.5}
          fontWeight="bold"
          fontFamily="monospace"
          letterSpacing="0.2px"
        >
          {buyTagText}
        </text>
      </g>
    );
  };

  return (
    <Card className="border border-border/40 bg-card/60 backdrop-blur-md overflow-hidden transition-all duration-200 hover:border-primary/40">
      <CardHeader className="p-3 pb-2 border-b border-border/30 bg-muted/20">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-bold text-base">{symbol}</span>
            <Badge variant="outline" className={type === 'FUTURES' ? 'border-purple-500/50 text-purple-400 bg-purple-500/10' : 'border-cyan-500/50 text-cyan-400 bg-cyan-500/10'}>
              {type} {effectiveLeverage > 1 ? `${effectiveLeverage}x` : ''}
            </Badge>
            <Badge className={isLong ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40' : 'bg-rose-500/20 text-rose-400 border-rose-500/40'}>
              {side}
            </Badge>
            {/* Purchase confirmation badge */}
            <Badge className="bg-primary/20 text-primary border border-primary/40 font-mono text-xs flex items-center gap-1">
              <ShoppingBag className="w-3 h-3" />
              <span>נקנה: ${formatFullPrice(entryPrice)}</span>
              {openedAt && <span className="opacity-80">({openedAt})</span>}
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
              <ComposedChart data={chartData} margin={{ top: 18, right: 10, left: -20, bottom: 0 }}>
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

                {/* Entry / Buy Price Reference with Custom Tag Badge */}
                <ReferenceLine
                  y={entryPrice}
                  stroke={isLong ? '#10b981' : '#f43f5e'}
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  label={renderBuyTagLabel}
                />

                {/* Entry Dot Marker on the chart */}
                {entryTimeKey && (
                  <ReferenceDot
                    x={entryTimeKey}
                    y={entryPrice}
                    r={5}
                    fill={isLong ? '#10b981' : '#f43f5e'}
                    stroke="#ffffff"
                    strokeWidth={2}
                  />
                )}

                {/* Stop Loss Reference */}
                {stopLoss && (
                  <ReferenceLine
                    y={stopLoss}
                    stroke="#ef4444"
                    strokeWidth={1.5}
                    label={{
                      value: `SL: $${formatFullPrice(stopLoss)}`,
                      fill: '#f87171',
                      fontSize: 10,
                      position: 'insideBottomLeft'
                    }}
                  />
                )}

                {/* Take Profit Reference */}
                {effectiveTP && (
                  <ReferenceLine
                    y={effectiveTP}
                    stroke="#10b981"
                    strokeWidth={1.5}
                    label={{
                      value: `TP: $${formatFullPrice(effectiveTP)}`,
                      fill: '#34d399',
                      fontSize: 10,
                      position: 'insideTopRight'
                    }}
                  />
                )}

                {/* Break-Even Reference */}
                {breakEvenPrice && (
                  <ReferenceLine
                    y={breakEvenPrice}
                    stroke="#a855f7"
                    strokeDasharray="2 2"
                    label={{
                      value: `BE: $${formatFullPrice(breakEvenPrice)}`,
                      fill: '#c084fc',
                      fontSize: 10,
                      position: 'insideBottomRight'
                    }}
                  />
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
                <Badge className="bg-primary/20 text-primary border-primary/30 text-[11px] px-1.5 py-0">
                  נקנה: ${formatFullPrice(entryPrice)}
                </Badge>
              </div>
              <span className={isProfitable ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                {isProfitable ? 'רווח נוכחי: +' : 'הפסד נוכחי: '}{pnlPercent.toFixed(2)}%
              </span>
            </div>

            {/* Target Progress visualization */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-[11px] font-mono text-muted-foreground">
                <span className="text-rose-400">SL: ${formatFullPrice(stopLoss || entryPrice * (isLong ? 0.95 : 1.05))}</span>
                <span className="text-emerald-400 font-bold">🟢 כניסה: ${formatFullPrice(entryPrice)}</span>
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
