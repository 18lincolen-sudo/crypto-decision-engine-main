import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Shield, AlertTriangle, Zap, Activity, Flame, Lock } from 'lucide-react';
import { MarketRegimeResult } from '@cde/engine';
import Gauge, { GaugeZone } from '@/components/Gauge';

// Exposure meters: low is safe, high is danger — the opposite polarity from
// the Fear & Greed dial's zones, same race-car-dashboard visual language.
const EXPOSURE_ZONES: GaugeZone[] = [
  { upTo: 50, color: '#16a34a' },
  { upTo: 75, color: '#eab308' },
  { upTo: 90, color: '#f97316' },
  { upTo: 100, color: '#dc2626' }
];

interface PortfolioRiskMeterProps {
  portfolioValue: number;
  totalInvestedUsd: number;
  totalLeveragedExposureUsd: number;
  openPositionsCount: number;
  maxPositions?: number;
  openFuturesCount: number;
  maxFutures?: number;
  dailyDrawdownPercent?: number;
  weeklyDrawdownPercent?: number;
  marketRegime?: MarketRegimeResult | null;
  /**
   * Engines whose figures could not be read, by name.
   *
   * Their numbers are NOT in the totals above, and that is the point: a bot
   * with an unreachable worker reports placeholder equity and zero exposure,
   * and folding that in would quietly shrink every percentage on this card. A
   * risk meter is allowed to say "I do not know about this engine"; it is not
   * allowed to imply exposure is lower than it is.
   */
  unavailableEngines?: string[];
}

export const PortfolioRiskMeter: React.FC<PortfolioRiskMeterProps> = ({
  portfolioValue,
  totalInvestedUsd,
  totalLeveragedExposureUsd,
  openPositionsCount,
  maxPositions = 5,
  openFuturesCount,
  maxFutures = 2,
  dailyDrawdownPercent = 0,
  weeklyDrawdownPercent = 0,
  marketRegime,
  unavailableEngines = []
}) => {
  const safePortfolio = Math.max(1, portfolioValue);
  
  // Total exposure %
  const totalExposurePercent = Math.min(100, Math.max(0, (totalInvestedUsd / safePortfolio) * 100));
  
  // Leveraged exposure % (Max allowed: 20%)
  const leveragedExposurePercent = Math.min(100, Math.max(0, (totalLeveragedExposureUsd / safePortfolio) * 100));
  const isLeveragedOverLimit = leveragedExposurePercent > 20;

  // Circuit breaker statuses
  const isDailyWarning = dailyDrawdownPercent >= 5;
  const isDailyHalt = dailyDrawdownPercent >= 8;
  const isWeeklyHalt = weeklyDrawdownPercent >= 15;

  return (
    <Card className="border-primary/30 bg-card/60 backdrop-blur shadow-lg overflow-hidden">
      <CardHeader className="pb-3 border-b border-primary/10">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base sm:text-lg font-mono flex items-center gap-2 text-primary">
            <Shield className="w-5 h-5 text-primary" />
            <span>מד סיכון וחשיפת תיק (Portfolio Risk Meter)</span>
          </CardTitle>

          {marketRegime && (
            <div className="flex items-center gap-2 flex-wrap">
              <Badge
                variant="outline"
                className={`font-mono text-xs ${
                  marketRegime.regime === 'TRENDING'
                    ? 'border-green-500/40 text-green-400 bg-green-500/10'
                    : marketRegime.regime === 'RANGING'
                    ? 'border-blue-500/40 text-blue-400 bg-blue-500/10'
                    : 'border-yellow-500/40 text-yellow-400 bg-yellow-500/10'
                }`}
              >
                <Activity className="w-3 h-3 mr-1" />
                {marketRegime.regime} (ADX {marketRegime.adx})
              </Badge>

              <Badge
                variant="outline"
                className={`font-mono text-xs ${
                  marketRegime.volatility === 'LOW'
                    ? 'border-cyan-500/40 text-cyan-400 bg-cyan-500/10'
                    : marketRegime.volatility === 'NORMAL'
                    ? 'border-primary/40 text-primary bg-primary/10'
                    : 'border-red-500/40 text-red-400 bg-red-500/10'
                }`}
              >
                <Flame className="w-3 h-3 mr-1" />
                {marketRegime.volatility} VOL ({marketRegime.atrPercent}%)
              </Badge>

              <Badge
                variant="outline"
                className={`font-mono text-xs ${
                  marketRegime.direction === 'BULL'
                    ? 'border-green-400 text-green-400'
                    : marketRegime.direction === 'BEAR'
                    ? 'border-red-400 text-red-400'
                    : 'border-muted-foreground text-muted-foreground'
                }`}
              >
                Supertrend: {marketRegime.direction}
              </Badge>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-4 sm:p-5 space-y-4">
        {/* Incomplete coverage. Shown ABOVE the drawdown warnings because it
            qualifies every number below it: the totals are a lower bound while
            any engine is missing. */}
        {unavailableEngines.length > 0 && (
          <div className="p-3 bg-orange-500/15 border border-orange-500/40 rounded-lg flex items-center gap-3 text-orange-300 text-xs font-mono">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <div>
              <strong>נתונים חסרים:</strong> {unavailableEngines.join(', ')} — המספרים כאן אינם כוללים את החשיפה של {unavailableEngines.length === 1 ? 'מנוע זה' : 'מנועים אלה'}, ולכן הם רצפה ולא הסכום המלא.
            </div>
          </div>
        )}

        {/* Drawdown Circuit Breaker Warnings */}
        {(isDailyHalt || isWeeklyHalt) ? (
          <div className="p-3 bg-red-500/15 border border-red-500/40 rounded-lg flex items-center gap-3 text-red-400 text-sm font-mono animate-pulse">
            <Lock className="w-5 h-5 flex-shrink-0" />
            <div>
              <strong>הגנת תיק מופעלת:</strong> {isWeeklyHalt ? 'ירידה שבועית מעל 15% — בוט הושבת לחלוטין!' : 'ירידה יומית מעל 8% — פתיחת עמדות חדשות נחסמה!'}
            </div>
          </div>
        ) : isDailyWarning ? (
          <div className="p-3 bg-yellow-500/15 border border-yellow-500/40 rounded-lg flex items-center gap-3 text-yellow-400 text-xs font-mono">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <div>
              <strong>אזהרת ירידה יומית:</strong> הפסד יומי {dailyDrawdownPercent.toFixed(1)}% מתקרב לסף החסימה (8%).
            </div>
          </div>
        ) : null}

        {/* Meters Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* 1. Total Portfolio Exposure */}
          <div className="p-3 bg-background/50 rounded-lg border border-primary/10 space-y-1">
            <div className="text-xs font-mono text-muted-foreground text-center">חשיפה כוללת מהתיק</div>
            <div className="max-w-[140px] mx-auto">
              <Gauge value={totalExposurePercent} zones={EXPOSURE_ZONES} readout={`${totalExposurePercent.toFixed(0)}%`} size={140} />
            </div>
            <div className="flex justify-between text-[11px] font-mono text-muted-foreground">
              <span>${totalInvestedUsd.toFixed(2)}</span>
              <span>מתוך ${portfolioValue.toFixed(2)}</span>
            </div>
          </div>

          {/* 2. Leveraged Exposure (Strict 20% limit) */}
          <div className={`p-3 bg-background/50 rounded-lg border space-y-1 ${isLeveragedOverLimit ? 'border-red-500/50 bg-red-500/5' : 'border-primary/10'}`}>
            <div className="text-xs font-mono text-muted-foreground text-center flex items-center justify-center gap-1">
              <Zap className="w-3.5 h-3.5 text-yellow-400" />
              חשיפה ממונפת (Futures)
            </div>
            <div className="max-w-[140px] mx-auto">
              <Gauge
                value={(leveragedExposurePercent / 20) * 100}
                zones={EXPOSURE_ZONES}
                readout={`${leveragedExposurePercent.toFixed(0)}%`}
                caption="מקס' 20%"
                size={140}
              />
            </div>
            <div className="flex justify-between text-[11px] font-mono text-muted-foreground">
              <span>${totalLeveragedExposureUsd.toFixed(2)} נומינלי</span>
              <span className={isLeveragedOverLimit ? 'text-red-400 font-bold' : ''}>
                {isLeveragedOverLimit ? 'חריגת מגבלה!' : ''}
              </span>
            </div>
          </div>

          {/* 3. Position Slots */}
          <div className="p-3 bg-background/50 rounded-lg border border-primary/10 space-y-2">
            <div className="flex justify-between items-center text-xs font-mono">
              <span className="text-muted-foreground">קיבולת פוזיציות</span>
              <span className="font-bold text-primary">{openPositionsCount}/{maxPositions} פתוחות</span>
            </div>
            <div className="flex gap-1.5 pt-1">
              {Array.from({ length: maxPositions }).map((_, i) => (
                <div
                  key={i}
                  className={`h-2 flex-1 rounded-full transition-colors ${
                    i < openPositionsCount ? 'bg-primary' : 'bg-muted/40'
                  }`}
                />
              ))}
            </div>
            <div className="text-[11px] font-mono text-muted-foreground">
              Futures: <span className="text-primary font-bold">{openFuturesCount}/{maxFutures} מקס'</span>
            </div>
          </div>

          {/* 4. Drawdown Circuit Breaker Gauges */}
          <div className="p-3 bg-background/50 rounded-lg border border-primary/10 space-y-2">
            <div className="flex justify-between items-center text-xs font-mono">
              <span className="text-muted-foreground">הגנת Drawdown</span>
              <span className={`font-bold ${dailyDrawdownPercent >= 5 ? 'text-yellow-400' : 'text-green-400'}`}>
                יום {dailyDrawdownPercent.toFixed(1)}% | שבוע {weeklyDrawdownPercent.toFixed(1)}%
              </span>
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-[10px] font-mono text-muted-foreground">
                <span>יומי (מקס' 8%)</span>
                <span>{dailyDrawdownPercent.toFixed(1)}%</span>
              </div>
              <Progress value={(dailyDrawdownPercent / 8) * 100} className="h-1 bg-muted" />
            </div>
            <div className="text-[10px] font-mono text-muted-foreground flex justify-between">
              <span>שבועי (מקס' 15% כיבוי)</span>
              <span>{weeklyDrawdownPercent.toFixed(1)}%</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default PortfolioRiskMeter;
