import { useMemo } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface Props {
  equity: number;
  invested: number;
  /** Optional: max loss observed (for scale range). Defaults to invested. */
  maxLoss?: number;
  /** Optional: max profit observed (for scale range). Defaults to invested. */
  maxProfit?: number;
  accentClass?: string;
}

/**
 * Dynamic profit scale — a horizontal bar that visualizes P&L as a percentage
 * of the initial investment. The bar grows/shrinks and changes color based on
 * whether the result is profit (green) or loss (red). The scale range adapts
 * to the actual max loss / max profit observed, so small moves are still visible.
 */
export default function ProfitScale({
  equity,
  invested,
  maxLoss,
  maxProfit,
  accentClass = 'text-primary',
}: Props) {
  const pnl = equity - invested;
  const pnlPercent = invested > 0 ? (pnl / invested) * 100 : 0;
  const isProfit = pnl >= 0;

  // Dynamic range: use observed extremes if provided, otherwise default to ±invested
  const rangeMin = maxLoss !== undefined ? Math.min(0, -maxLoss) : -invested;
  const rangeMax = maxProfit !== undefined ? Math.max(0, maxProfit) : invested;
  const rangeTotal = rangeMax - rangeMin;
  const rangeAbs = Math.max(rangeTotal, invested * 0.01); // avoid div-by-zero

  // Position of the current P&L within the dynamic range
  const positionPercent = ((pnl - rangeMin) / rangeAbs) * 100;
  const clampedPos = Math.max(0, Math.min(100, positionPercent));

  // Bar fill: from the zero line to the current P&L position
  const zeroLinePercent = rangeMin !== 0 ? ((-rangeMin) / rangeAbs) * 100 : 0;

  const barColor = isProfit ? '#22c55e' : '#ef4444';

  const scaleLabel = useMemo(() => {
    if (Math.abs(pnlPercent) < 0.01) return 'שווה משקיע';
    return isProfit ? 'רווח' : 'הפסד';
  }, [pnlPercent, isProfit]);

  return (
    <div className="w-full space-y-1.5">
      {/* P&L value + label */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {isProfit ? (
            <TrendingUp className="w-4 h-4 text-green-400" />
          ) : (
            <TrendingDown className="w-4 h-4 text-red-400" />
          )}
          <span className={`text-sm font-bold font-mono ${isProfit ? 'text-green-400' : 'text-red-400'}`}>
            {isProfit ? '+' : ''}
            {pnl.toFixed(2)}$ ({pnlPercent.toFixed(2)}%)
          </span>
        </div>
        <span className="text-[10px] text-muted-foreground font-mono">{scaleLabel}</span>
      </div>

      {/* Dynamic scale bar */}
      <div className="relative h-5 w-full bg-muted/30 rounded-full overflow-hidden border border-border/30">
        {/* Zero line marker */}
        {zeroLinePercent > 0 && zeroLinePercent < 100 && (
          <div
            className="absolute top-0 bottom-0 w-px bg-border/50"
            style={{ left: `${zeroLinePercent}%` }}
          />
        )}

        {/* Profit fill (green, from zero line to current position) */}
        {isProfit && (
          <div
            className="absolute top-0 bottom-0 bg-green-500/30 rounded-full"
            style={{
              left: `${zeroLinePercent}%`,
              width: `${clampedPos - zeroLinePercent}%`,
              minWidth: '2px',
            }}
          />
        )}

        {/* Loss fill (red, from current position to zero line) */}
        {!isProfit && (
          <div
            className="absolute top-0 bottom-0 bg-red-500/30 rounded-full"
            style={{
              left: `${clampedPos}%`,
              width: `${zeroLinePercent - clampedPos}%`,
              minWidth: '2px',
            }}
          />
        )}

        {/* Current position marker */}
        <div
          className="absolute top-0 bottom-0 w-1.5 bg-white rounded-full shadow"
          style={{ left: `${clampedPos}%` }}
        />

        {/* Range labels */}
        <div className="absolute -bottom-3 left-0 text-[9px] text-muted-foreground font-mono">
          {rangeMin !== 0 ? `-${Math.abs(rangeMin).toFixed(0)}$` : '0$'}
        </div>
        <div className="absolute -bottom-3 right-0 text-[9px] text-muted-foreground font-mono">
          {rangeMax !== 0 ? `+${rangeMax.toFixed(0)}$` : '0$'}
        </div>
      </div>
    </div>
  );
}
