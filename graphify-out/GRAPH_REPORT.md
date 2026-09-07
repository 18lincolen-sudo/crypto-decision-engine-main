# Graph Report - crypto-decision-engine-main  (2026-09-07)

## Corpus Check
- 202 files · ~197,193 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1973 nodes · 5199 edges · 98 communities (81 shown, 12 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 23 edges (avg confidence: 0.83)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `e1ca5169`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- backtestSweep.ts
- lucide-react
- backtestRunner.ts
- tradingApiClient.ts
- tradingWorker.ts
- intradayAdapter.ts
- Candle
- marketDataService.test.ts
- adaptiveRisk.ts
- Crypto Decision Engine SPA Entry (index.html)
- hooks/use-toast.ts
- 4. בוט Bybit (TrendBreakout · פריצת מגמה) — סימולציה בלבד
- decisionFunnel.ts
- useSimulationBot.ts
- SimulationBot.tsx
- react
- services/pathStudy.ts
- compilerOptions
- Gauge.tsx
- execution.ts
- manifest.json
- SimPosition
- market-data.ts
- compilerOptions
- compilerOptions
- DecisionContext
- toBaseAsset
- useProSimulationBot.ts
- pathSimExecution.ts
- threeBotIntegration.test.ts
- components.json
- backtestCompare.ts
- correlation.ts
- simDefaults.ts
- compilerOptions
- cryptoPriceAggregator.ts
- dependencies
- bybitApi.ts
- pathValidation.test.ts
- analyzeDecisions.ts
- scan
- אלגוריתם ההחלטה של הבוטים (סימולציה ומסחר אמיתי)
- devDependencies
- main.tsx
- compilerOptions
- scripts
- server/package.json
- pathEngine.ts
- scripts/pathStudy.ts
- intradayBridge.ts
- pathSimEngine.ts
- errorHandlerSanitizer.test.ts
- PortfolioPulseCard.tsx
- cn
- vitest
- proAlgEngine.ts
- src/index.ts
- symbolUniverse.ts
- json
- engine/package.json
- RealTradingBot.tsx
- useApiPollingCascade.test.ts
- shutdown
- proConfidenceProfile.ts
- coinGeckoApi.ts
- intradayIndicators.ts
- ErrorBoundary
- smoke-test.mjs
- analysis.ts
- package.json
- TradingApiClient
- sonner.tsx
- backtestLegacyPro.ts
- sanitizeSimConfig
- BotRequest
- מפרט מלא — בוט הסימולציה הרביעי: `TrendBreakout` ("Bybit")
- capacitor.config.ts
- allowScripts
- installValidatedTable
- CI Workflow (GitHub Actions)
- render.yaml Render Web Service Config
- tradeEngine.ts
- trendBreakoutExecution.ts
- PortfolioBuilder.tsx
- types.ts
- PathSimulationBotContext.tsx
- fundingOrthogonality.ts
- intradayMandatory.test.ts
- createKVStore
- eslint.config.js
- service-worker.js
- tailwindcss
- vite.config.ts

## God Nodes (most connected - your core abstractions)
1. `cn()` - 65 edges
2. `Candle` - 64 edges
3. `react` - 59 edges
4. `lucide-react` - 37 edges
5. `SimPosition` - 37 edges
6. `PendingOrder` - 36 edges
7. `SignalEvaluation` - 34 edges
8. `SimBotConfig` - 31 edges
9. `Card` - 27 edges
10. `CardContent` - 27 edges

## Surprising Connections (you probably didn't know these)
- `Placeholder Image Icon SVG` --conceptually_related_to--> `Crypto Decision Engine SPA Entry (index.html)`  [INFERRED]
  public/placeholder.svg → index.html
- `toInternalSymbol()` --calls--> `toBaseAsset()`  [EXTRACTED]
  src/services/bybitApi.ts → packages/engine/src/services/assetUniverse.ts
- `tick()` --indirect_call--> `computeAtr5()`  [INFERRED]
  server/simEngineFactory.ts → packages/engine/src/services/intradayBridge.ts
- `ScanResult` --references--> `IntradayDecision`  [EXTRACTED]
  server/tradingWorker.ts → packages/engine/src/services/intradayEngine.ts
- `Snapshot` --references--> `Candle`  [EXTRACTED]
  scripts/fundingOrthogonality.ts → packages/engine/src/services/tradeEngine.ts

## Import Cycles
- None detected.

## Communities (98 total, 12 thin omitted)

### Community 0 - "backtestSweep.ts"
Cohesion: 0.06
Nodes (35): buildGrid(), Combo, ComboResult, CONC, DAYS, ENTRY_MIN, fetchHistory(), fetchKlinesPaged() (+27 more)

### Community 1 - "lucide-react"
Cohesion: 0.14
Nodes (29): CryptoRecommendation, PortfolioAnalysis, lucide-react, AIChatbotProps, Message, CryptoCard(), CryptoCardProps, safeNumber() (+21 more)

### Community 2 - "backtestRunner.ts"
Cohesion: 0.07
Nodes (47): TradeSide, arg(), argNum(), Candle, cmdRun(), cmdSnapshot(), cmdSnapshotMtf(), FIXED_SL (+39 more)

### Community 3 - "tradingApiClient.ts"
Cohesion: 0.09
Nodes (44): SimBotConfig, BybitSimulationBotContext, BybitSimulationBotProvider(), DEFAULT_BYBIT_CONFIG, EMPTY_SNAPSHOT, DEFAULT_PRO_CONFIG, ProSimulationBotContext, ProSimulationBotProvider() (+36 more)

### Community 4 - "tradingWorker.ts"
Cohesion: 0.03
Nodes (57): BybitSimSnapshot, getPathTableStatus(), PathSimSnapshot, ProSimSnapshot, allowedOrigins, botSymbolsRaw, bybitSimEngine, bybitSimState (+49 more)

### Community 5 - "intradayAdapter.ts"
Cohesion: 0.17
Nodes (12): CircuitBreakerStage, ExposureStage, IntradayAdapter, intradayResultCache, mapDirection(), mapOutcome(), mapRiskPlan(), mapTradeType() (+4 more)

### Community 6 - "Candle"
Cohesion: 0.08
Nodes (39): toBybitSymbol(), binanceListsSymbol(), BybitKlineResponse, BybitTickerRow, cacheKey(), CandleSource, CandleValidationResult, clearFundingCache() (+31 more)

### Community 7 - "marketDataService.test.ts"
Cohesion: 0.13
Nodes (11): clearMarketDataCache(), dropFormingCandle(), fetchBacktestHistory(), fetchBinanceKlines(), fetchTimeframe(), isAlignedToTimeframe(), TIMEFRAME_SPECS, validateCandles() (+3 more)

### Community 8 - "adaptiveRisk.ts"
Cohesion: 0.09
Nodes (30): adaptiveRiskPercentFromHistory(), computeAdaptiveRiskPercent(), computeDrawdownFactor(), computeSizingMultiplier(), computeStreakFactor(), computeSymbolStreakCooldownUntil(), computeWinRateFactor(), EMPTY_PERFORMANCE_WINDOW (+22 more)

### Community 9 - "Crypto Decision Engine SPA Entry (index.html)"
Cohesion: 0.67
Nodes (3): Crypto Decision Engine SPA Entry (index.html), Placeholder Image Icon SVG, robots.txt Crawler Allow Policy

### Community 10 - "hooks/use-toast.ts"
Cohesion: 0.12
Nodes (25): @radix-ui/react-toast, Toast, ToastAction, ToastActionElement, ToastClose, ToastDescription, ToastProps, ToastTitle (+17 more)

### Community 11 - "4. בוט Bybit (TrendBreakout · פריצת מגמה) — סימולציה בלבד"
Cohesion: 0.04
Nodes (46): 1. בוט חדש (Intraday · Multi-Timeframe), 2. בוט פרו (Pro · alg.md מדויק), 3. מנוע נתיב 4H (Path · Empirical), 4. בוט Bybit (TrendBreakout · פריצת מגמה) — סימולציה בלבד, Funding (נוסף עם בוט 4, חל על כל ארבעתם), Scale-in (§11) — מודל lots, SHORT, אישור כניסה (M5, §5) (+38 more)

### Community 12 - "decisionFunnel.ts"
Cohesion: 0.10
Nodes (28): Agg, BINANCE_INTERVAL, bump(), BybitApiResponse, BybitKlineResult, BybitTicker, BybitTickerResult, CONC (+20 more)

### Community 13 - "useSimulationBot.ts"
Cohesion: 0.23
Nodes (13): buildFactorsFromDecisionResult(), computeAtr5(), generateNewOrders(), CryptoData, PortfolioBuilderProps, useBackgroundWorker(), UseBackgroundWorkerOptions, Params (+5 more)

### Community 14 - "SimulationBot.tsx"
Cohesion: 0.10
Nodes (30): react-router-dom, @tanstack/react-query, queryClient, FearGreedIndicator(), MarketOverview(), MatrixBackground(), MatrixBackgroundProps, Navigation() (+22 more)

### Community 15 - "react"
Cohesion: 0.09
Nodes (29): react, AIChatbot(), AlertsPanel(), AlertsPanelProps, CryptoChart(), FloatingActionMenu(), FloatingActionMenuProps, Particle (+21 more)

### Community 16 - "services/pathStudy.ts"
Cohesion: 0.11
Nodes (25): bucketKey(), buildPathTable(), BuildTableOptions, buildValidatedPathTable(), costInR(), DEFAULT_COST_R, EXIT_SLIPPAGE_PCT, MIN_BUCKET_SAMPLES (+17 more)

### Community 17 - "compilerOptions"
Cohesion: 0.10
Nodes (19): compilerOptions, allowImportingTsExtensions, isolatedModules, jsx, lib, module, moduleDetection, moduleResolution (+11 more)

### Community 18 - "Gauge.tsx"
Cohesion: 0.57
Nodes (6): angleFor(), arcPath(), clamp(), Gauge(), GaugeProps, polarToXY()

### Community 19 - "execution.ts"
Cohesion: 0.10
Nodes (32): AdaptiveRiskInput, PerformanceWindow, streakCooldownReason(), applyFundingAccrual(), DEFAULT_POSITION_PERCENT, ENTRY_COOLDOWN_MS, ENTRY_ORDER_SIDES, EntryBudgetInput (+24 more)

### Community 20 - "manifest.json"
Cohesion: 0.11
Nodes (17): background_color, categories, description, dir, display, features, icons, lang (+9 more)

### Community 21 - "SimPosition"
Cohesion: 0.19
Nodes (27): FundingSnapshot, DecisionFactor, SignalEvaluation, PathOrderGenContext, SIM_MIN_CONFIDENCE, PendingOrder, SimPoint, SimPosition (+19 more)

### Community 22 - "market-data.ts"
Cohesion: 0.23
Nodes (16): ANALYTICS_UNIVERSE, ASSET_REGISTRY, AssetRegistryEntry, EXCLUDED_BASES, EXTENDED_INTRADAY_UNIVERSE, getAssetTier(), INTRADAY_UNIVERSE, isExcludedAsset() (+8 more)

### Community 23 - "compilerOptions"
Cohesion: 0.12
Nodes (16): compilerOptions, allowImportingTsExtensions, esModuleInterop, isolatedModules, lib, module, moduleResolution, noEmit (+8 more)

### Community 24 - "compilerOptions"
Cohesion: 0.12
Nodes (16): compilerOptions, allowImportingTsExtensions, isolatedModules, lib, module, moduleDetection, moduleResolution, noEmit (+8 more)

### Community 25 - "DecisionContext"
Cohesion: 0.22
Nodes (6): PathAdapter, DecisionEngine, DecisionContext, DecisionResult, EngineAdapter, EngineId

### Community 26 - "toBaseAsset"
Cohesion: 0.18
Nodes (20): toBaseAsset(), getUniverseMarketData(), createBybitSimEngine(), createPathSimEngine(), createProSimEngine(), createSimEngine(), createGenericSimEngine(), buildH1CandlesForSymbol() (+12 more)

### Community 27 - "useProSimulationBot.ts"
Cohesion: 0.14
Nodes (21): evaluateProExit(), MIN_PRO_CANDLES, proAllocationPercent(), proMinConfidence(), ProRiskLevel, ProSignalResult, proTechnicalScore(), applyProEntryGates() (+13 more)

### Community 28 - "pathSimExecution.ts"
Cohesion: 0.20
Nodes (15): isInStreakCooldown(), toPositionDirection(), DAILY_DRAWDOWN_BLOCK_PERCENT, WEEKLY_DRAWDOWN_LOCK_PERCENT, PATH_MAX_HOLD_MS, PATH_TIME_STOP_MS, pathKellyFraction(), generatePathOrders() (+7 more)

### Community 29 - "threeBotIntegration.test.ts"
Cohesion: 0.15
Nodes (19): PathRegime, slotIndexAt(), BYBIT_SIM_BOT_LAST_KNOWN_RUNNING_KEY, PATH_SIM_BOT_LAST_KNOWN_RUNNING_KEY, PRO_SIM_BOT_STORAGE_KEY, SIM_BOT_STORAGE_KEY, AggregatableContext, AggregatedBot (+11 more)

### Community 30 - "components.json"
Cohesion: 0.12
Nodes (16): aliases, components, hooks, lib, ui, utils, rsc, $schema (+8 more)

### Community 31 - "backtestCompare.ts"
Cohesion: 0.16
Nodes (16): BINANCE_INTERVAL, BybitKlineResponse, CONC, fetchBinance(), fetchBybit(), fetchJson(), fetchKlines(), FM_LIMIT (+8 more)

### Community 32 - "correlation.ts"
Cohesion: 0.14
Nodes (19): alignCloses(), clampNum(), CorrelatedHolding, CORRELATION_LOOKBACK_FLOOR, correlationBetween(), CorrelationGateInput, CorrelationGateResult, CorrelationMatch (+11 more)

### Community 33 - "simDefaults.ts"
Cohesion: 0.20
Nodes (12): ConfidenceScale, SIM_BASE_DEFAULTS, SIM_BOT_IDS, SIM_BOT_SPECS, SIM_BOTS, SIM_MAX_FUTURES_POSITIONS, simBotDefaults(), SimBotId (+4 more)

### Community 34 - "compilerOptions"
Cohesion: 0.12
Nodes (16): compilerOptions, allowImportingTsExtensions, esModuleInterop, isolatedModules, lib, module, moduleResolution, noEmit (+8 more)

### Community 35 - "cryptoPriceAggregator.ts"
Cohesion: 0.22
Nodes (12): CRYPTO_IDS, BinanceKlineRaw, BinanceTicker, CandleCache, coinGeckoPriceCache, fetchBinanceAllTickers(), fetchBybitAllTickers(), fetchCoinGeckoPrices() (+4 more)

### Community 36 - "dependencies"
Cohesion: 0.03
Nodes (59): dependencies, @capacitor/android, @capacitor/cli, @capacitor/core, @capacitor/ios, class-variance-authority, clsx, cmdk (+51 more)

### Community 37 - "bybitApi.ts"
Cohesion: 0.29
Nodes (4): TARGET_SYMBOLS, BybitKlineData, BybitTicker, toInternalSymbol()

### Community 38 - "pathValidation.test.ts"
Cohesion: 0.20
Nodes (12): buildFearGreedSeries(), fearGreedAt(), FearGreedPoint, FearGreedSeries, fetchFearGreedHistory(), parseFearGreedPayload(), utcDayStart(), fearGreedBucket (+4 more)

### Community 39 - "analyzeDecisions.ts"
Cohesion: 0.21
Nodes (13): BUCKET_BOUNDS, BUCKET_LABELS, BucketStats, computeBuckets(), formatPercent(), getBucketIndex(), getTopReason(), main() (+5 more)

### Community 40 - "scan"
Cohesion: 0.22
Nodes (16): buildPortfolioRiskStats(), baseCoin(), bybitExec(), checkClosedFuturesPositions(), checkClosedSpotPositions(), confirmSpotEntries(), executeOrder(), fetchWithTimeout() (+8 more)

### Community 41 - "אלגוריתם ההחלטה של הבוטים (סימולציה ומסחר אמיתי)"
Cohesion: 0.14
Nodes (13): 10. תרשים זרימה מקוצר, 1. מקורות הנתונים, 2. מנוע ההמלצות — חישוב הביטחון, 3. סף הביצוע של הבוט, 4. שכבת ההערכה (Single Source of Truth), 5. יציאות ניהול סיכון (עצמאיות מההמלצות), 6. מנוע הביצוע — עמלות, החלקה והשהיה, 7. מחזור החיים והרציפות (+5 more)

### Community 42 - "devDependencies"
Cohesion: 0.10
Nodes (20): devDependencies, autoprefixer, eslint, @eslint/js, eslint-plugin-react-hooks, eslint-plugin-react-refresh, globals, lovable-tagger (+12 more)

### Community 43 - "main.tsx"
Cohesion: 0.38
Nodes (4): App(), rootElement, isProduction, initializeProductionOptimizations()

### Community 44 - "compilerOptions"
Cohesion: 0.17
Nodes (11): compilerOptions, allowJs, noImplicitAny, noUnusedLocals, noUnusedParameters, paths, skipLibCheck, strictNullChecks (+3 more)

### Community 45 - "scripts"
Cohesion: 0.15
Nodes (13): scripts, build, build:dev, build:worker, dev, lint, preview, start (+5 more)

### Community 46 - "server/package.json"
Cohesion: 0.10
Nodes (20): dependencies, dotenv, devDependencies, esbuild, tsx, typescript, engines, node (+12 more)

### Community 47 - "pathEngine.ts"
Cohesion: 0.13
Nodes (17): MIN_PATH_CANDLES, noSignal(), PATH_MIN_H4_BARS, PathDecision, PathDecisionInput, PathGate, pathRiskUnit(), BAR_MS (+9 more)

### Community 48 - "scripts/pathStudy.ts"
Cohesion: 0.18
Nodes (16): buildWalkForwardWindows(), CandleOrdering, DEFAULT_TP_R, DEFAULT_USE_FEAR_GREED, lookbackForBasis(), RiskBasis, arg(), cmdBuild() (+8 more)

### Community 49 - "intradayBridge.ts"
Cohesion: 0.10
Nodes (41): buildExitView(), evaluatePositionExit(), evaluateSymbolFromSnapshot(), evaluateUniverse(), ExitPositionInput, mapDecisionToSignalEvaluation(), mapRegimeToMarketRegimeResult(), METRIC_CONFIG (+33 more)

### Community 50 - "pathSimEngine.ts"
Cohesion: 0.31
Nodes (11): aggregateToH4(), evaluatePathDecision(), barOpenFor(), labelBarState(), measureBarPaths(), prior15mFor(), riskUnitFrom15M(), outcomesForSymbol() (+3 more)

### Community 51 - "errorHandlerSanitizer.test.ts"
Cohesion: 0.05
Nodes (45): WorkerAuthContext, WorkerAuthContextValue, WorkerAuthProvider(), createDefaultPortfolio(), isPortfolioShaped(), normalizeItem(), usePortfolio(), Binance24hTicker (+37 more)

### Community 52 - "PortfolioPulseCard.tsx"
Cohesion: 0.13
Nodes (16): getAggregatedCandles(), recharts, LivePositionChart(), LivePositionChartProps, HistoryPoint, Metric, PortfolioPulseCard(), Props (+8 more)

### Community 53 - "cn"
Cohesion: 0.10
Nodes (35): @radix-ui/react-dropdown-menu, CryptoDetailModal(), safeNumber(), safeNumber(), SimulationEngineColumn(), CardDescription, CardFooter, DialogContent (+27 more)

### Community 54 - "vitest"
Cohesion: 0.17
Nodes (6): KELLY_MIN_SAMPLE, KELLY_MULTIPLIER, kellyPayoffRatio(), vitest, baseCtx, SW_SOURCE

### Community 55 - "proAlgEngine.ts"
Cohesion: 0.06
Nodes (65): calculateOptimalEntryPrice(), computeProSignal(), PRO_ALLOCATION_DEFAULT_PERCENT, PRO_ALLOCATION_HIGH_CONFIDENCE_THRESHOLD, PRO_ALLOCATION_HIGH_PERCENT, PRO_CONFIDENCE_BY_RISK, PRO_COVERAGE_FULL_WEIGHT, PRO_DEFAULT_ENTRY_CONFIDENCE (+57 more)

### Community 56 - "src/index.ts"
Cohesion: 0.10
Nodes (32): EvaluateUniverseOptions, ExitPortfolioInput, fetchSymbolSnapshot(), PortfolioInput, ActivePosition, BollingerBands, CryptoChartData, EnhancedCryptoData (+24 more)

### Community 57 - "symbolUniverse.ts"
Cohesion: 0.27
Nodes (9): baseAndKind(), BybitTickerRow, computeLiquidUniverse(), EXCLUDE_BASES, fetchTickers(), LiquidUniverseResult, MIN_SPOT_VOLUME_FOR_INCLUSION, MULTIPLIER_PREFIXES (+1 more)

### Community 58 - "json"
Cohesion: 0.22
Nodes (7): BotResponse, currentFearGreed(), fetchFearGreed(), fetchFearGreedFull(), json(), setCors(), startSimTicker()

### Community 59 - "engine/package.json"
Cohesion: 0.22
Nodes (8): exports, ./analysis, ./execution, ./market-data, name, private, type, version

### Community 60 - "RealTradingBot.tsx"
Cohesion: 0.16
Nodes (15): class-variance-authority, ExecutiveDashboard(), Alert, AlertDescription, AlertTitle, alertVariants, TabsContent, TabsList (+7 more)

### Community 61 - "useApiPollingCascade.test.ts"
Cohesion: 0.25
Nodes (4): createHarness(), depsEqual(), Harness, PollFn

### Community 62 - "shutdown"
Cohesion: 0.33
Nodes (6): persistBybitSim(), persistPathSim(), persistProSim(), persistSim(), serializeState(), shutdown()

### Community 63 - "proConfidenceProfile.ts"
Cohesion: 0.52
Nodes (6): arg(), klines(), main(), q(), share(), topSymbols()

### Community 64 - "coinGeckoApi.ts"
Cohesion: 0.33
Nodes (4): cachedHistData, cachedPriceData, CoinGeckoMarketChart, lastHistFetchAt

### Community 65 - "intradayIndicators.ts"
Cohesion: 0.14
Nodes (41): confirmEntry5M(), emptyEntry(), Entry5M, AtrRegimeResult, bollinger(), BollingerResult, candleQuality, compression() (+33 more)

### Community 68 - "analysis.ts"
Cohesion: 0.17
Nodes (24): FUNDING_CROWDED_ANNUAL_PCT, FUNDING_EXTREME_ANNUAL_PCT, FUNDING_MAX_AGE_MS, FUNDING_MIN_SIZE_MULTIPLIER, FundingVerdict, BacktestHistory, BacktestMetrics, BacktestResult (+16 more)

### Community 69 - "package.json"
Cohesion: 0.03
Nodes (60): dotenv, esbuild, tsx, typescript, name, private, type, version (+52 more)

### Community 71 - "sonner.tsx"
Cohesion: 0.40
Nodes (4): next-themes, sonner, Toaster(), ToasterProps

### Community 73 - "backtestLegacyPro.ts"
Cohesion: 0.40
Nodes (3): CONC, DAYS, SYMS

### Community 74 - "sanitizeSimConfig"
Cohesion: 0.33
Nodes (6): applySimConfigPatch(), hydrateBybitSim(), hydratePathSim(), hydrateProSim(), hydrateSim(), sanitizeSimConfig()

### Community 76 - "מפרט מלא — בוט הסימולציה הרביעי: `TrendBreakout` ("Bybit")"
Cohesion: 0.07
Nodes (26): 10. Take Profit, 11. SCALE — Scale-in מדורג (לא פותחים הכול בבת אחת), 12. Stop Management, 13. Exit Conditions, 14. Risk Management, 15. Exposure Limits, 16. Drawdown Protection, 17. Simulation Execution (+18 more)

### Community 84 - "tradeEngine.ts"
Cohesion: 0.18
Nodes (20): atrRegime(), detectRegime1H(), calculateADX(), calculateATR(), calculateEMA(), calculateSupertrend(), detectMarketRegime(), clamp01() (+12 more)

### Community 85 - "trendBreakoutExecution.ts"
Cohesion: 0.15
Nodes (17): MIN_SIM_ENTRY_USD, DEFAULT_TREND_BREAKOUT_PARAMS, readTrendBreakoutPlan(), currentAtrM15(), currentH1Supertrend(), effectiveStop(), ENTRY_SIDES, generateTrendBreakoutOrders() (+9 more)

### Community 86 - "PortfolioBuilder.tsx"
Cohesion: 0.23
Nodes (10): PortfolioItem, AddCryptoForm(), AddCryptoFormProps, CurrentPortfolioItems(), CurrentPortfolioItemsProps, PortfolioSummary(), PortfolioSummaryProps, PortfolioBuilder() (+2 more)

### Community 87 - "types.ts"
Cohesion: 0.31
Nodes (11): ClosedTradeRecord, PathEngineParams, DecisionOutcome, EngineParams, MarketDataSnapshot, MultiTimeframeCandles, OpenPosition, PortfolioRiskStats (+3 more)

### Community 88 - "PathSimulationBotContext.tsx"
Cohesion: 0.26
Nodes (10): DEFAULT_PATH_CONFIG, EMPTY_SNAPSHOT, PathSimulationBotContext, PathSimulationBotProvider(), getPathSimState(), getPathTable(), resetPathSim(), setPathSimConfig() (+2 more)

### Community 89 - "fundingOrthogonality.ts"
Cohesion: 0.31
Nodes (9): annualisedFundingPct(), evaluateFundingGate(), FUNDING_PERIODS_PER_YEAR, fetchFundingHistory(), FundingPoint, main(), OUT_DIR, pearson() (+1 more)

### Community 90 - "intradayMandatory.test.ts"
Cohesion: 0.39
Nodes (6): bullScenario(), candlesFromCloses(), rangePath(), rangeScenario(), TF, trendPath()

### Community 141 - "eslint.config.js"
Cohesion: 0.33
Nodes (5): @eslint/js, eslint-plugin-react-hooks, eslint-plugin-react-refresh, globals, typescript-eslint

### Community 148 - "vite.config.ts"
Cohesion: 0.50
Nodes (3): lovable-tagger, vite, @vitejs/plugin-react-swc

## Ambiguous Edges - Review These
- `CI Workflow (GitHub Actions)` → `CI Workflow (GitHub Actions)`  [AMBIGUOUS]
  .github/workflows/ci.yml · relation: references

## Knowledge Gaps
- **597 isolated node(s):** `config`, `$schema`, `style`, `rsc`, `tsx` (+592 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 715 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **12 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `CI Workflow (GitHub Actions)` and `CI Workflow (GitHub Actions)`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **Why does `vitest` connect `vitest` to `correlation.ts`, `simDefaults.ts`, `backtestRunner.ts`, `tradingApiClient.ts`, `package.json`, `pathValidation.test.ts`, `marketDataService.test.ts`, `adaptiveRisk.ts`, `pathEngine.ts`, `intradayBridge.ts`, `errorHandlerSanitizer.test.ts`, `execution.ts`, `trendBreakoutExecution.ts`, `useApiPollingCascade.test.ts`, `proAlgEngine.ts`, `intradayMandatory.test.ts`, `useProSimulationBot.ts`, `threeBotIntegration.test.ts`?**
  _High betweenness centrality (0.091) - this node is a cross-community bridge._
- **Why does `react` connect `react` to `lucide-react`, `tradingApiClient.ts`, `package.json`, `hooks/use-toast.ts`, `useSimulationBot.ts`, `SimulationBot.tsx`, `Gauge.tsx`, `errorHandlerSanitizer.test.ts`, `PortfolioPulseCard.tsx`, `cn`, `PortfolioBuilder.tsx`, `PathSimulationBotContext.tsx`, `useProSimulationBot.ts`, `RealTradingBot.tsx`?**
  _High betweenness centrality (0.084) - this node is a cross-community bridge._
- **Why does `dependencies` connect `dependencies` to `package.json`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **What connects `config`, `$schema`, `style` to the rest of the system?**
  _597 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `backtestSweep.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06015037593984962 - nodes in this community are weakly interconnected._
- **Should `lucide-react` be split into smaller, more focused modules?**
  _Cohesion score 0.14396456256921372 - nodes in this community are weakly interconnected._