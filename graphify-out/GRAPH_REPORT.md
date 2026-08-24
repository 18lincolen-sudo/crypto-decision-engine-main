# Graph Report - crypto-decision-engine-main  (2026-08-24)

## Corpus Check
- 186 files · ~156,683 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1498 nodes · 3163 edges · 149 communities (75 shown, 74 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 14 edges (avg confidence: 0.8)
- Token cost: 0 input · 69,327 output

## Community Hubs (Navigation)
- Shadcn Overlay Components
- Crypto Card & Alerts UI
- Intraday Indicators & Entry Scoring
- Simulation Bot Context & API Client
- Trading Worker Server Core
- Shadcn Sidebar & Form Inputs
- Local Security & Storage
- Market Data Service (Bybit/Binance)
- Intraday Bridge & Exit Logic
- Trading Algorithm Spec (alg.md)
- Toast Notification System
- Trade Engine & Crypto Types
- Decision Funnel Backtest Script
- Simulation Engine
- App Shell & Theme
- Portfolio & Floating Menu UI
- Shadcn Form Controls
- TypeScript App Config
- Analysis Page & Particle UI
- KV Store (Firestore/Local)
- Manifest
- Alert Dialog
- Local Database
- Tsconfig.Worker
- Tsconfig.Node
- Command
- Sim Engine
- Asset Universe
- Real Bybit Api
- Real Bybit Api
- Components
- Backtest Compare
- Advanced Trading Service
- Smart Recommendation Engine
- Trading Worker
- Intraday Backtest
- Package
- Bybit Api
- Form
- Aichatbot
- Mandatory Scenarios.Test
- Carousel
- Package
- Production
- Tsconfig
- Package
- Package
- Crypto Price Aggregator
- Sanitizer
- Chart
- Advanced Technical Analysis
- Error Handler
- Portfolio Pulse Card
- Dropdown Menu
- Technical Analysis
- Recommendation Engine
- Add Crypto Form
- Alert
- Sheet
- Table
- Trading Api Client
- Drawer
- Navigation Menu
- Market Data Service
- Coin Gecko Api
- Intraday Mandatory.Test
- Error Boundary
- Smoke Test
- Live Position Chart
- Package
- Trade Engine
- Trading Worker
- Loading Screen
- Loading Spinner
- Seohead
- Package
- Capacitor.Config
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package

## God Nodes (most connected - your core abstractions)
1. `cn()` - 226 edges
2. `Card` - 32 edges
3. `CardContent` - 32 edges
4. `Candle` - 29 edges
5. `Button` - 27 edges
6. `CardHeader` - 27 edges
7. `CardTitle` - 26 edges
8. `Badge()` - 24 edges
9. `useCryptoData()` - 22 edges
10. `LocalDatabase` - 22 edges

## Surprising Connections (you probably didn't know these)
- `Live Trading Enablement Sequence` --semantically_similar_to--> `Live Activation Gate (Testnet-first Rollout)`  [INFERRED] [semantically similar]
  RENDER_NETLIFY_DEPLOYMENT.md → RENDER_ENV_AND_DOCUMENTATION_CLEANUP.md
- `Placeholder Image Icon SVG` --conceptually_related_to--> `Crypto Decision Engine SPA Entry (index.html)`  [INFERRED]
  public/placeholder.svg → index.html
- `main()` --calls--> `runWalkForward()`  [EXTRACTED]
  scripts/backtestCompare.ts → src/services/intradayBacktest.ts
- `evaluateSymbol()` --calls--> `evaluateIntradayDecision()`  [EXTRACTED]
  scripts/decisionFunnel.ts → src/services/intradayEngine.ts
- `SimEvaluationResult` --references--> `IntradayDecision`  [EXTRACTED]
  server/simEngine.ts → src/services/intradayEngine.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Render + Netlify Deployment Pipeline** — render_render_yaml_service, render_netlify_deployment_guide, server_readme_render_worker, render_env_and_documentation_cleanup_checklist [INFERRED 0.85]
- **Live-Trading Safety Gating Mechanisms** — server_readme_safety_defaults, alg_circuit_breakers, render_env_and_documentation_cleanup_live_activation_gate, render_netlify_deployment_live_enablement_sequence [INFERRED 0.85]
- **7-Layer Decision Engine Pipeline** — alg_layer0_market_regime_detection, alg_layer1_signal_engine, alg_layer2_trade_router_hard_gates, alg_layer3_risk_management_engine, alg_layer4_exit_engine [EXTRACTED 1.00]

## Communities (149 total, 74 thin omitted)

### Community 0 - "Shadcn Overlay Components"
Cohesion: 0.07
Nodes (45): AccordionContent, AccordionItem, AccordionTrigger, Avatar, AvatarFallback, AvatarImage, Breadcrumb, BreadcrumbEllipsis() (+37 more)

### Community 1 - "Crypto Card & Alerts UI"
Cohesion: 0.12
Nodes (29): Alert, CryptoCardProps, CryptoDetailModal(), CryptoDetailModalProps, Props, State, PersonalizedDashboard(), UserStats (+21 more)

### Community 2 - "Intraday Indicators & Entry Scoring"
Cohesion: 0.14
Nodes (44): confirmEntry5M(), emptyEntry(), atrRegime(), AtrRegimeResult, bollinger(), BollingerResult, candleQuality, clamp() (+36 more)

### Community 3 - "Simulation Bot Context & API Client"
Cohesion: 0.07
Nodes (38): DEFAULT_CONFIG, SimStatus, SimulationBotContext, SimulationBotContextValue, SimulationBotProvider(), useBackgroundWorker(), UseBackgroundWorkerOptions, HydratableSnapshot (+30 more)

### Community 4 - "Trading Worker Server Core"
Cohesion: 0.05
Nodes (31): exportMarketDataCache(), importMarketDataCache(), allowedOrigins, botSymbolsRaw, DATA_DIR, DEFAULT_SIM_CONFIG, __dirname, health (+23 more)

### Community 5 - "Shadcn Sidebar & Form Inputs"
Cohesion: 0.07
Nodes (31): Input, Separator, Sidebar, SidebarContent, SidebarContext, SidebarFooter, SidebarGroup, SidebarGroupAction (+23 more)

### Community 6 - "Local Security & Storage"
Cohesion: 0.09
Nodes (8): SecureInputProps, LocalAlert, LocalPortfolioItem, LocalTrade, DatabaseSchema, localDB, EncryptedData, SecurityManager

### Community 7 - "Market Data Service (Bybit/Binance)"
Cohesion: 0.09
Nodes (26): BybitKlineResponse, BybitTickerRow, CandleSource, CandleValidationResult, clearMarketDataCache(), dropFormingCandle(), fetchBacktestHistory(), fetchBinanceKlines() (+18 more)

### Community 8 - "Intraday Bridge & Exit Logic"
Cohesion: 0.13
Nodes (26): buildExitView(), evaluatePositionExit(), evaluateSymbolFromSnapshot(), EvaluateUniverseOptions, ExitPortfolioInput, ExitPositionInput, mapDecisionToSignalEvaluation(), mapRegimeToMarketRegimeResult() (+18 more)

### Community 9 - "Trading Algorithm Spec (alg.md)"
Cohesion: 0.09
Nodes (30): 100% Parity (Simulation vs Live Trading), Circuit Breakers (Daily/Weekly Drawdown), Kelly Criterion Position-Size Modifier, Layer 0: Market Regime Detection, Layer 1: Signal Engine, Layer 2: Trade Router & Hard Gates, Layer 3.5: Entry Timing Validator, Layer 3: Risk Management Engine (+22 more)

### Community 10 - "Toast Notification System"
Cohesion: 0.11
Nodes (25): Toast, ToastAction, ToastActionElement, ToastClose, ToastDescription, ToastProps, ToastTitle, toastVariants (+17 more)

### Community 11 - "Trade Engine & Crypto Types"
Cohesion: 0.10
Nodes (23): calculateBreakEvenPrice(), calculateOptimalEntry(), ClosedTradeMetric, computeEntryIndicators(), EntryTimingResult, ExitDecision, TradeRouterOptions, ActivePosition (+15 more)

### Community 12 - "Decision Funnel Backtest Script"
Cohesion: 0.11
Nodes (25): Agg, BINANCE_INTERVAL, bump(), CONC, evaluateSymbol(), fetchBinanceKlines(), fetchBybitKlines(), fetchJson() (+17 more)

### Community 13 - "Simulation Engine"
Cohesion: 0.11
Nodes (26): PendingOrder, SimBotConfig, SimEvaluateResult, SimEvaluationResult, SimPoint, SimPosition, SimSnapshot, SimTrade (+18 more)

### Community 14 - "App Shell & Theme"
Cohesion: 0.10
Nodes (22): queryClient, AlertsSystem(), MarketOverview(), MatrixBackground(), MatrixBackgroundProps, SmartTipsPanel(), Toaster(), ToasterProps (+14 more)

### Community 15 - "Portfolio & Floating Menu UI"
Cohesion: 0.13
Nodes (16): CryptoCard(), FearGreedIndicator(), FloatingActionMenu(), FloatingActionMenuProps, CurrentPortfolioItems(), EmptyPortfolio(), EmptyPortfolioProps, PortfolioHeader() (+8 more)

### Community 16 - "Shadcn Form Controls"
Cohesion: 0.09
Nodes (16): Checkbox, HoverCardContent, InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot, PopoverContent, Slider (+8 more)

### Community 17 - "TypeScript App Config"
Cohesion: 0.08
Nodes (24): DOM, DOM.Iterable, ES2020, src, compilerOptions, allowImportingTsExtensions, isolatedModules, jsx (+16 more)

### Community 18 - "Analysis Page & Particle UI"
Cohesion: 0.16
Nodes (18): Navigation(), Particle, ParticleBackground(), PortfolioChart(), PortfolioRiskMeter(), SelectContent, SelectItem, SelectTrigger (+10 more)

### Community 19 - "KV Store (Firestore/Local)"
Cohesion: 0.11
Nodes (9): base64url(), createKVStore(), DATA_DIR, __dirname, FirestoreKV, getAccessToken(), KVStore, LocalKV (+1 more)

### Community 20 - "Manifest"
Cohesion: 0.08
Nodes (23): background_color, categories, description, dir, display, features, icons, lang (+15 more)

### Community 21 - "Alert Dialog"
Cohesion: 0.10
Nodes (20): AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter(), AlertDialogHeader(), AlertDialogOverlay, AlertDialogTitle (+12 more)

### Community 23 - "Tsconfig.Worker"
Cohesion: 0.10
Nodes (20): ES2022, server, compilerOptions, allowImportingTsExtensions, esModuleInterop, isolatedModules, lib, module (+12 more)

### Community 24 - "Tsconfig.Node"
Cohesion: 0.10
Nodes (20): ES2023, vite.config.ts, compilerOptions, allowImportingTsExtensions, isolatedModules, lib, module, moduleDetection (+12 more)

### Community 25 - "Command"
Cohesion: 0.13
Nodes (17): CryptoChart(), CryptoChartProps, Command, CommandDialogProps, CommandEmpty, CommandGroup, CommandInput, CommandItem (+9 more)

### Community 26 - "Sim Engine"
Cohesion: 0.22
Nodes (17): createSimEngine(), buildCandlesForSymbol(), drawdowns(), equity(), evaluate(), executeDueOrders(), generateOrders(), getSnapshot() (+9 more)

### Community 27 - "Asset Universe"
Cohesion: 0.15
Nodes (17): ANALYTICS_UNIVERSE, ASSET_REGISTRY, AssetRegistryEntry, EXCLUDED_BASES, EXTENDED_INTRADAY_UNIVERSE, getAssetTier(), INTRADAY_UNIVERSE, isExcludedAsset() (+9 more)

### Community 28 - "Real Bybit Api"
Cohesion: 0.15
Nodes (12): TradeHistory, Binance24hTicker, BinanceKline, binancePublicApi, fearGreedApi, CloudTradeRecord, firebaseSync, AccountBalance (+4 more)

### Community 30 - "Components"
Cohesion: 0.12
Nodes (16): aliases, components, hooks, lib, ui, utils, rsc, $schema (+8 more)

### Community 31 - "Backtest Compare"
Cohesion: 0.16
Nodes (16): BINANCE_INTERVAL, CONC, fetchBinance(), fetchBybit(), fetchJson(), fetchKlines(), FM_LIMIT, H1_LIMIT (+8 more)

### Community 33 - "Smart Recommendation Engine"
Cohesion: 0.22
Nodes (16): analyzeBollingerBands(), analyzeMacd(), analyzeMarketSentiment(), analyzePriceMomentum(), analyzeRSI(), analyzeStochastic(), analyzeSupportResistance(), analyzeVolume() (+8 more)

### Community 34 - "Trading Worker"
Cohesion: 0.17
Nodes (14): BotResponse, bybitExec(), executeOrder(), fetchFearGreed(), fetchPublicCandles(), fetchWithTimeout(), getAccountContext(), getAccountSummary() (+6 more)

### Community 35 - "Intraday Backtest"
Cohesion: 0.22
Nodes (15): BacktestMetrics, BacktestResult, BacktestTrade, computeMetrics(), OpenPosition, PendingOrder, runBacktest(), runRiskVariants() (+7 more)

### Community 36 - "Package"
Cohesion: 0.13
Nodes (15): @capacitor/android, next-themes, dependencies, @capacitor/android, next-themes, @radix-ui/react-dialog, @radix-ui/react-label, @radix-ui/react-select (+7 more)

### Community 37 - "Bybit Api"
Cohesion: 0.15
Nodes (10): candles, r, bybitApi, BybitKlineData, BybitTicker, calculateTradingFee(), evaluateExit(), evaluateSignals() (+2 more)

### Community 38 - "Form"
Cohesion: 0.19
Nodes (12): FormControl, FormDescription, FormFieldContext, FormFieldContextValue, FormItem, FormItemContext, FormItemContextValue, FormLabel (+4 more)

### Community 39 - "Aichatbot"
Cohesion: 0.20
Nodes (9): AIChatbot(), AIChatbotProps, Message, AlertsPanel(), AlertsPanelProps, TradingAlertsProps, ScrollArea, useAlerts() (+1 more)

### Community 40 - "Mandatory Scenarios.Test"
Cohesion: 0.16
Nodes (5): PortfolioRiskMeterProps, calculateRiskParameters(), routeTradeType(), MarketRegimeResult, SignalEngineResult

### Community 41 - "Carousel"
Cohesion: 0.19
Nodes (13): Carousel, CarouselApi, CarouselContent, CarouselContext, CarouselContextProps, CarouselItem, CarouselNext, CarouselOptions (+5 more)

### Community 42 - "Package"
Cohesion: 0.15
Nodes (13): autoprefixer, eslint-plugin-react-refresh, lovable-tagger, devDependencies, autoprefixer, eslint-plugin-react-refresh, lovable-tagger, tailwindcss (+5 more)

### Community 43 - "Production"
Cohesion: 0.18
Nodes (10): App(), rootElement, appMetadata, errorReporter, featureFlags, isDevelopment, isProduction, logger (+2 more)

### Community 44 - "Tsconfig"
Cohesion: 0.15
Nodes (12): compilerOptions, allowJs, noImplicitAny, noUnusedLocals, noUnusedParameters, paths, skipLibCheck, strictNullChecks (+4 more)

### Community 45 - "Package"
Cohesion: 0.17
Nodes (12): scripts, build, build:dev, build:worker, dev, lint, preview, start (+4 more)

### Community 46 - "Package"
Cohesion: 0.17
Nodes (11): dependencies, dotenv, engines, node, dotenv, name, private, scripts (+3 more)

### Community 47 - "Crypto Price Aggregator"
Cohesion: 0.26
Nodes (10): BinanceKlineRaw, BinanceTicker, CandleCache, coinGeckoPriceCache, CRYPTO_IDS, fetchBinanceAllTickers(), fetchBybitAllTickers(), fetchCoinGeckoPrices() (+2 more)

### Community 48 - "Sanitizer"
Cohesion: 0.24
Nodes (3): ContentSanitizer, createSafeHTML(), SanitizeOptions

### Community 49 - "Chart"
Cohesion: 0.25
Nodes (9): ChartConfig, ChartContainer, ChartContext, ChartContextProps, ChartLegendContent, ChartTooltipContent, getPayloadConfigFromPayload(), THEMES (+1 more)

### Community 50 - "Advanced Technical Analysis"
Cohesion: 0.27
Nodes (10): calculateAdvancedIndicators(), calculateEMA(), calculateFibonacci(), calculateMACD(), calculateStochastic(), calculateSupportResistance(), FibonacciLevels, MACDResult (+2 more)

### Community 51 - "Error Handler"
Cohesion: 0.25
Nodes (6): APIError, AppError, handleError(), NetworkError, ValidationError, withErrorHandling()

### Community 52 - "Portfolio Pulse Card"
Cohesion: 0.22
Nodes (9): HistoryPoint, Metric, PortfolioPulseCard(), Props, RANGE_LABEL, RANGE_MS, TimeRange, toneClass() (+1 more)

### Community 53 - "Dropdown Menu"
Cohesion: 0.20
Nodes (9): DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut(), DropdownMenuSubContent (+1 more)

### Community 54 - "Technical Analysis"
Cohesion: 0.38
Nodes (9): BollingerBands, VolumeProfile, analyzeVolumeTrend(), calculateBollingerBands(), calculateMovingAverage(), calculateRSI(), calculateStandardDeviation(), calculateTechnicalIndicators() (+1 more)

### Community 55 - "Recommendation Engine"
Cohesion: 0.33
Nodes (8): FearGreedIndicatorProps, FearGreedIndex, RecommendationType, TechnicalIndicators, calculateSuggestedAmounts(), generateRecommendation(), RecommendationParams, SmartRecommendationParams

### Community 56 - "Add Crypto Form"
Cohesion: 0.31
Nodes (8): AddCryptoForm(), AddCryptoFormProps, CurrentPortfolioItemsProps, PortfolioBuilderProps, PriceCache, CryptoData, EnhancedCryptoData, PortfolioItem

### Community 57 - "Alert"
Cohesion: 0.33
Nodes (6): RiskManagementPanelProps, Alert, AlertDescription, AlertTitle, alertVariants, RiskManagementConfig

### Community 58 - "Sheet"
Cohesion: 0.25
Nodes (8): SheetContent, SheetContentProps, SheetDescription, SheetFooter(), SheetHeader(), SheetOverlay, SheetTitle, sheetVariants

### Community 59 - "Table"
Cohesion: 0.22
Nodes (8): Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow

### Community 60 - "Trading Api Client"
Cohesion: 0.32
Nodes (6): ExecutiveDashboard(), useSimulationBotContextSafe(), RealTradingBot(), createTradingApiClient(), WorkerAccountSummary, WorkerBotState

### Community 61 - "Drawer"
Cohesion: 0.25
Nodes (6): DrawerContent, DrawerDescription, DrawerFooter(), DrawerHeader(), DrawerOverlay, DrawerTitle

### Community 62 - "Navigation Menu"
Cohesion: 0.29
Nodes (7): NavigationMenu, NavigationMenuContent, NavigationMenuIndicator, NavigationMenuList, NavigationMenuTrigger, navigationMenuTriggerStyle, NavigationMenuViewport

### Community 63 - "Market Data Service"
Cohesion: 0.43
Nodes (8): toBybitSymbol(), evaluateUniverse(), fetchSymbolSnapshot(), cacheKey(), getLiquiditySnapshots(), getMultiTimeframeData(), getUniverseMarketData(), mergeDelta()

### Community 64 - "Coin Gecko Api"
Cohesion: 0.25
Nodes (6): cachedHistData, cachedPriceData, CoinGeckoMarketChart, CRYPTO_IDS, lastHistFetchAt, HistoricalPrice

### Community 65 - "Intraday Mandatory.Test"
Cohesion: 0.39
Nodes (6): bullScenario(), candlesFromCloses(), rangePath(), rangeScenario(), TF, trendPath()

### Community 68 - "Live Position Chart"
Cohesion: 0.53
Nodes (4): LivePositionChart(), LivePositionChartProps, getAggregatedCandles(), formatFullPrice()

### Community 69 - "Package"
Cohesion: 0.40
Nodes (4): name, private, type, version

### Community 70 - "Trade Engine"
Cohesion: 0.80
Nodes (4): calculateADX(), calculateATR(), calculateSupertrend(), detectMarketRegime()

## Ambiguous Edges - Review These
- `CI Workflow (GitHub Actions)` → `CI Workflow (GitHub Actions)`  [AMBIGUOUS]
  .github/workflows/ci.yml · relation: references

## Knowledge Gaps
- **419 isolated node(s):** `config`, `$schema`, `style`, `rsc`, `tsx` (+414 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **74 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `CI Workflow (GitHub Actions)` and `CI Workflow (GitHub Actions)`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **Why does `cn()` connect `Shadcn Overlay Components` to `Crypto Card & Alerts UI`, `Shadcn Sidebar & Form Inputs`, `Form`, `Aichatbot`, `Carousel`, `Toast Notification System`, `Portfolio & Floating Menu UI`, `Shadcn Form Controls`, `Chart`, `Analysis Page & Particle UI`, `Alert Dialog`, `Dropdown Menu`, `Navigation Menu`, `Alert`, `Sheet`, `Table`, `Drawer`, `Command`?**
  _High betweenness centrality (0.171) - this node is a cross-community bridge._
- **Why does `Candle` connect `Simulation Engine` to `Advanced Trading Service`, `Intraday Mandatory.Test`, `Intraday Indicators & Entry Scoring`, `Simulation Bot Context & API Client`, `Intraday Backtest`, `Market Data Service (Bybit/Binance)`, `Intraday Bridge & Exit Logic`, `Mandatory Scenarios.Test`, `Trade Engine & Crypto Types`, `Decision Funnel Backtest Script`, `Crypto Price Aggregator`, `Real Bybit Api`, `Backtest Compare`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **What connects `config`, `$schema`, `style` to the rest of the system?**
  _419 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Shadcn Overlay Components` be split into smaller, more focused modules?**
  _Cohesion score 0.06676342525399129 - nodes in this community are weakly interconnected._
- **Should `Crypto Card & Alerts UI` be split into smaller, more focused modules?**
  _Cohesion score 0.12489795918367347 - nodes in this community are weakly interconnected._
- **Should `Intraday Indicators & Entry Scoring` be split into smaller, more focused modules?**
  _Cohesion score 0.13714285714285715 - nodes in this community are weakly interconnected._