import { Card, CardContent } from '@/components/ui/card';
import { Bot, RefreshCw } from 'lucide-react';
import Navigation from '../components/Navigation';
import PortfolioRiskMeter from '../components/trading/PortfolioRiskMeter';
import SimulationEngineColumn from '../components/trading/SimulationEngineColumn';
import { useSimulationBotContext } from '../contexts/SimulationBotContext';
import { useLegacySimulationBotContext } from '../contexts/LegacySimulationBotContext';
import { useCryptoData } from '../hooks/useCryptoData';

const SimulationBot = () => {
  const intraday = useSimulationBotContext();
  const legacy = useLegacySimulationBotContext();
  const { cryptoData, isLoading } = useCryptoData();

  const combinedPositionsCount = intraday.positions.length + legacy.positions.length;
  const combinedFuturesCount =
    intraday.positions.filter((p: any) => p.type === 'FUTURES').length +
    legacy.positions.filter((p: any) => p.type === 'FUTURES').length;

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <div className="max-w-[1600px] mx-auto p-3 sm:p-4 space-y-6">
        {/* Header */}
        <div className="text-center pt-2">
          <h1 className="text-3xl sm:text-4xl font-bold mb-2 text-primary flex items-center justify-center gap-3 font-mono">
            <Bot className="w-9 h-9" />
            בוט סימולציה — השוואת שני אלגוריתמים
          </h1>
          <p className="text-sm sm:text-base text-muted-foreground font-mono">
            מנוע חדש (רב-שכבתי Multi-Timeframe) מול מנוע מקורי (ציון ביטחון משוקלל, alg.md) — כל אחד עם הון וסטטיסטיקה נפרדים
          </p>
        </div>

        {/* Live data status */}
        <Card className="border-primary/30 bg-card/50 backdrop-blur">
          <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-mono">
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-primary' : 'text-muted-foreground'}`} />
              <span className="text-muted-foreground">
                {isLoading ? 'טוען נתוני שוק...' : `${cryptoData?.length || 0} נכסים חיים · נתונים משותפים לשני המנועים`}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Combined risk overview */}
        <PortfolioRiskMeter
          portfolioValue={intraday.equity + legacy.equity}
          totalInvestedUsd={intraday.positionsValue + legacy.positionsValue}
          totalLeveragedExposureUsd={intraday.totalLeveragedExposureUsd + legacy.totalLeveragedExposureUsd}
          openPositionsCount={combinedPositionsCount}
          maxPositions={(intraday.config.maxPositions ?? 7) + (legacy.config.maxPositions ?? 7)}
          openFuturesCount={combinedFuturesCount}
          maxFutures={(intraday.config.maxFuturesPositions ?? 2) + (legacy.config.maxFuturesPositions ?? 2)}
          dailyDrawdownPercent={Math.max(intraday.dailyDrawdownPercent, legacy.dailyDrawdownPercent)}
          weeklyDrawdownPercent={Math.max(intraday.weeklyDrawdownPercent, legacy.weeklyDrawdownPercent)}
        />

        {/* Two engines side by side */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <SimulationEngineColumn
            title="מנוע חדש · Multi-Timeframe"
            subtitle="Setup + Entry מבניים על 1H/15M/5M"
            accentClass="text-primary"
            cryptoData={cryptoData}
            cash={intraday.cash}
            positions={intraday.positions}
            positionsValue={intraday.positionsValue}
            equity={intraday.equity}
            trades={intraday.trades}
            history={intraday.history}
            pending={intraday.pending}
            totalFees={intraday.totalFees}
            totalSlippageCost={intraday.totalSlippageCost}
            winRate={intraday.winRate}
            totalTrades={intraday.totalTrades}
            closedTrades={intraday.closedTrades}
            evaluations={intraday.evaluations}
            hasSavedSession={intraday.hasSavedSession}
            nextTickAt={intraday.nextTickAt}
            config={intraday.config}
            setConfig={intraday.setConfig}
            status={intraday.status}
            isRunning={intraday.isRunning}
            start={intraday.start}
            pause={intraday.pause}
            resetAll={intraday.resetAll}
          />

          <SimulationEngineColumn
            title="מנוע מקורי · Confidence Score"
            subtitle="ציון משוקלל 7 אינדיקטורים (alg.md), סף 60/72%"
            accentClass="text-cyan-400"
            cryptoData={cryptoData}
            cash={legacy.cash}
            positions={legacy.positions}
            positionsValue={legacy.positionsValue}
            equity={legacy.equity}
            trades={legacy.trades}
            history={legacy.history}
            pending={legacy.pending}
            totalFees={legacy.totalFees}
            totalSlippageCost={legacy.totalSlippageCost}
            winRate={legacy.winRate}
            totalTrades={legacy.totalTrades}
            closedTrades={legacy.closedTrades}
            evaluations={legacy.evaluations}
            hasSavedSession={legacy.hasSavedSession}
            nextTickAt={legacy.nextTickAt}
            config={legacy.config}
            setConfig={legacy.setConfig}
            status={legacy.status}
            isRunning={legacy.isRunning}
            start={legacy.start}
            pause={legacy.pause}
            resetAll={legacy.resetAll}
          />
        </div>
      </div>
    </div>
  );
};

export default SimulationBot;
