import { useMemo } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface Props {
  equity: number;
  invested: number;
  /** Optional: max loss observed on the equity curve (widens the scale past the
   *  reference if it exceeds ±targetPercent). */
  maxLoss?: number;
  /** Optional: max profit observed on the equity curve. */
  maxProfit?: number;
  /** Fixed reference scale, as a fraction of invested capital. Default 0.10 →
   *  the bar reads against a ±10% window, so a 0.8% gain is a thin sliver, not a
   *  full bar. The scale only grows past this if observed extremes / current
   *  P&L exceed it. */
  targetPercent?: number;
  accentClass?: string;
}

/**
 * Profit scale — a horizontal bar that visualizes P&L against a FIXED reference
 * window of ±targetPercent of the invested capital (default ±10%). It only
 * widens past that window if the bot's observed max profit / max loss (or its
 * current P&L) exceeds it. Green for profit, red for loss.
 *
 * Before: the window was the equity curve's own historical peak/trough, so a
 * bot sitting at its all-time-high equity always pinned the marker to 100%, and
 * a short/flat history collapsed the scale to 1% of invested — the bar "topped
 * out" at ~1% regardless of the real gain.
 */
export default function ProfitScale({
  equity,
  invested,
  maxLoss,
  maxProfit,
  targetPercent = 0.1,
  accentClass = 'text-primary',
}: Props) {
  const pnl = equity - invested;
  const pnlPercent = invested > 0 ? (pnl / invested) * 100 : 0;
  const isProfit = pnl >= 0;

  // Fixed reference: ±targetPercent of invested. The window expands only if the
  // observed extremes (or the live P&L) run past it — never contracts below it.
  const ref = Math.max(invested * targetPercent, 1e-9);
  const rangeMax = Math.max(ref, maxProfit ?? 0, pnl);
  const rangeMin = Math.min(-ref, -(maxLoss ?? 0), pnl);
  const rangeAbs = rangeMax - rangeMin; // always >= 2·ref > 0

  // Position of the current P&L within the window
  const positionPercent = ((pnl - rangeMin) / rangeAbs) * 100;
  const clampedPos = Math.max(0, Math.min(100, positionPercent));

  // Bar fill: from the zero line to the current P&L position
  const zeroLinePercent = ((-rangeMin) / rangeAbs) * 100;

  const leftLabel = invested > 0
    ? `${((rangeMin / invested) * 100).toFixed(0)}%`
    : `-$${Math.abs(rangeMin).toFixed(0)}`;
  const rightLabel = invested > 0
    ? `+${((rangeMax / invested) * 100).toFixed(0)}%`
    : `+$${rangeMax.toFixed(0)}`;

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

      {/* Fixed-window scale bar (±targetPercent of invested) */}
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
          {leftLabel}
        </div>
        <div className="absolute -bottom-3 right-0 text-[9px] text-muted-foreground font-mono">
          {rightLabel}
        </div>
      </div>
    </div>
  );
}
