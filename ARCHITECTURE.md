# מפת ארכיטקטורה — Crypto Decision Engine

> מסמך זה נועד לתת תמונה מלאה ומהירה של הפרוייקט: ארכיטקטורה, קבצים, לוגיקה, פריסה ופרונט.

---

## 1. סקירה כללית

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Netlify (Frontend)                           │
│  https://crypto-d.netlify.app                                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐              │
│  │   Index   │ │Portfolio │ │ Alerts   │ │Advanced  │              │
│  │ (דף בית) │ │ (תיק     │ │ (התראות) │ │Analysis  │              │
│  │          │ │  השקעות)│ │          │ │(ניתוח    │              │
│  │ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘              │
│  │      │             │             │             │                   │
│  │      └─────────────┴─────────────┴─────────────┘                   │
│  │                    React Router                                    │
│  │  ┌──────────────────────────────────────────────────┐              │
│  │  │  SimulationBot (3 מנועי סימולציה בעמוד אחד)   │              │
│  │  │  RealTradingBot (בוט מסחר אמיתי)                │              │
│  │  │  AdvancedAnalysis (ניתוח מתקדם)                  │              │
│  │  │  BacktestResults (תוצאות Backtest)               │              │
│  │  └──────────────────────────────────────────────────┘              │
│  └───────────────────────────┬─────────────────────────────────────────┘
│                             │ HTTPS API
│                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Render (Backend Worker)                         │
│  https://crypto-decision-engine-main.onrender.com                   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │  tradingWorker.ts (Node.js HTTP Server)                   │      │
│  │                                                           │      │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │      │
│  │  │  Live Bot   │  │  Sim Engine │  │ Legacy Sim  │      │      │
│  │  │  (מסחר     │  │  (סימולציה  │  │ Engine      │      │      │
│  │  │   אמיתי)   │  │   חדש)     │  │ (מקורי)    │      │      │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘      │      │
│  │         │                │                │                 │      │
│  │  ┌──────┴────────────────┴────────────────┴──────┐      │      │
│  │  │          Intraday Engine (evaluateIntradayDecision)│      │      │
│  │  └─────────────────────────────────────────────────┘      │      │
│  │                                                           │      │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │      │
│  │  │  Pro Sim    │  │  MarketData │  │  Bybit API  │      │      │
│  │  │  Engine     │  │  Service    │  │  Client     │      │      │
│  │  │  (Bot Pro)  │  │  (MTF OHLCV)│  │  (כתרים/   │      │      │
│  │  │             │  │             │  │   פקודות)  │      │      │
│  │  └─────────────┘  └─────────────┘  └─────────────┘      │      │
│  └──────────────────────────────────────────────────────────┘      │
│                                                                     │
│  Persistence: Firestore (warm cache) + local .data/ files           │
└─────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Bybit Exchange                                │
│  Public: candles, ticker, instruments-info                          │
│  Auth:   wallet, positions, orders (testnet/mainnet)                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. מבנה הפרוייקט

```
crypto-decision-engine-main/
├── .env                          # משתנים סביבה (לוקלי, לא ב-git)
├── .env.example                  # תבנית למשתנים
├── .gitignore
├── .nvmrc                        # גרסת Node
├── index.html                    # נקודת כניסה ל-Vite
├── package.json                  # תלויות frontend + worker
├── vite.config.ts                # קונפיגורציית Vite
├── tailwind.config.ts            # Tailwind
├── tsconfig.json                 # TypeScript (frontend)
├── tsconfig.worker.json          # TypeScript (worker)
├── netlify.toml                  # קונפיגורציית Netlify
├── render.yaml                   # קונפיגורציית Render
├── capacitor.config.ts           # Capacitor (אפליקציה מובייל)
│
├── server/                       # קבצי backend (מועלים ל-Render)
│   ├── package.json              # תלויות backend (dotenv + esbuild/tsx/typescript)
│   ├── tradingWorker.ts          # שרת HTTP + לוגיקת Bot 24/7
│   ├── simEngineFactory.ts       # מנוע סימולציה משותף (3 מנועים)
│   ├── simEngine.ts              # מנוע סימולציה חדש (MTF) — adapter ל-factory
│   ├── legacySimEngine.ts        # מנוע סימולציה מקורי — adapter ל-factory
│   ├── proSimEngine.ts           # מנוע סימולציה פרו (alg.md) — adapter ל-factory
│   ├── kvStore.ts                # אחסון מקומי (Firestore בייצור)
│   ├── _smoke.ts                 # בדיקת ייבוא מהירה (development)
│   ├── historicalCandleCache.ts  # מטמון כתרים היסטוריים ל-backtest
│   └── .data/                    # קבצי מצב (מועלים אוטומטית ל-Firestore)
│
├── ALG_intraday.md               # תיעוד אלגוריתם בוט חדש (MTF)
├── ALG_legacy.md                 # תיעוד אלגוריתם בוט מקורי
├── ALG_pro.md                    # תיעוד אלגוריתם בוט פרו (alg.md)
├── ARCHITECTURE.md               # מפת ארכיטקטורה (קובץ זה)
│
├── public/                       # קבצים סטטיים
│   ├── _redirects                # Netlify redirects (SPA)
│   ├── manifest.json             # PWA manifest
│   └── ...
│
├── src/                          # קוד Frontend + Worker
│   ├── main.tsx                  # נקודת כניסה ל-React
│   ├── App.tsx                   # Router + Providers
│   ├── index.css                 # עיצוב גלובלי
│   │
│   ├── pages/                    # דפים (Routes)
│   │   ├── Index.tsx             # דף בית
│   │   ├── Portfolio.tsx         # תיק השקעות
│   │   ├── Alerts.tsx            # התראות
│   │   ├── SimulationBot.tsx     # בוט סימולציה (3 מנועים בעמוד אחד)
│   │   ├── RealTradingBot.tsx    # בוט מסחר אמיתי
│   │   ├── AdvancedAnalysis.tsx  # ניתוח מתקדם
│   │   ├── BacktestResults.tsx   # תוצאות Backtest Sweep
│   │   └── NotFound.tsx           # 404
│   │
│   ├── components/               # קומפוננטות React
│   │   ├── Navigation.tsx
│   │   ├── CryptoCard.tsx
│   │   ├── FearGreedIndicator.tsx
│   │   ├── SmartTipsPanel.tsx
│   │   ├── dashboard/
│   │   │   └── ExecutiveDashboard.tsx
│   │   ├── trading/
│   │   │   ├── SimulationEngineColumn.tsx  # עמודה אחת למנוע סימולציה
│   │   │   ├── PortfolioPulseCard.tsx       # כרטיס פולס תיק
│   │   │   ├── LivePositionChart.tsx        # גרף פוזיציה פתוחה
│   │   │   └── PortfolioRiskMeter.tsx       # מדד סיכון פורטפוליו
│   │   └── ui/                   # shadcn/ui components
│   │
│   ├── contexts/                 # React Contexts
│   │   ├── ThemeContext.tsx
│   │   ├── WorkerAuthContext.tsx  # כתובת Worker + Admin Token
│   │   ├── SimulationBotContext.tsx      # מנוע חדש (MTF)
│   │   ├── LegacySimulationBotContext.tsx # מנוע מקורי
│   │   └── ProSimulationBotContext.tsx    # בוט פרו
│   │
│   ├── hooks/                    # Custom Hooks
│   │   ├── useCryptoData.ts
│   │   ├── usePortfolio.ts
│   │   ├── useSimulationBot.ts
│   │   ├── useLegacySimulationBot.ts
│   │   ├── useProSimulationBot.ts
│   │   ├── useApiPolling.ts       # polling עם backoff (משותף)
│   │   ├── useBackgroundWorker.ts # Web Worker ל-heartbeat
│   │   └── ...
│   │
│   ├── services/                 # לוגיקה עסקית + API
│   │   ├── tradingApiClient.ts   # לקוח HTTP ל-Worker
│   │   ├── workerConfig.ts       # פתרון כתובת Worker
│   │   ├── intradayEngine.ts     # מנוע החלטות MTF (מקור אמת)
│   │   ├── intradayBridge.ts     # גשר בין סימולציה ל-intradayEngine
│   │   ├── intradayExit.ts       # לוגיקת יציאה למנוע חדש
│   │   ├── intradayRegime.ts     # זיהוי משטר שוק (Layer 0)
│   │   ├── intradaySetup.ts      # זיהוי Setup (Layer 1)
│   │   ├── intradayEntry.ts      # אישור כניסה (Layer 2)
│   │   ├── intradayRisk.ts       # ניהול סיכונים (Layer 3) + Cost/Edge
│   │   ├── intradayParams.ts     # פרמטרים מרכזיים לכל המנוע
│   │   ├── marketDataService.ts  # Multi-Timeframe OHLCV pipeline
│   │   ├── simExecution.ts       # לוגיקת ביצוע סימולציה (משותף)
│   │   ├── legacySimExecution.ts # לוגיקת ביצוע + החלטות legacy
│   │   ├── proSimExecution.ts    # לוגיקת ביצוע + החלטות Pro
│   │   ├── decisionEngine/       # DecisionEngine מאוחד + 3 adapters
│   │   │   ├── index.ts          # Public API
│   │   │   ├── orchestrator.ts   # DecisionEngine — adapter selection, adaptive risk, correlation
│   │   │   ├── types.ts          # DecisionContext, DecisionResult, EngineAdapter
│   │   │   └── adapters/         # מתאמים לכל מנוע
│   │   │       ├── intradayAdapter.ts
│   │   │       ├── legacyAdapter.ts
│   │   │       └── proAdapter.ts
│   │   ├── proAlgEngine.ts       # מנוע Pro — ניתוב/סיכון/יציאה (alg.md)
│   │   ├── proAdvancedAnalysis.ts # מקור אותות Pro (מנוע האתר)
│   │   ├── tradeEngine.ts        # מנוע מסחר בסיסי + אינדיקטורים
│   │   ├── adaptiveRisk.ts       # סיכון אדפטיבי + streak cooldown
│   │   ├── correlation.ts        # מניעת קורלציה (Pearson log-returns)
│   │   ├── bybitApi.ts           # לקוח Bybit (ציבורי + מאומת)
│   │   ├── binancePublicApi.ts   # לקוח Binance (ציבורי)
│   │   ├── coinGeckoApi.ts       # לקוח CoinGecko (נטלול)
│   │   ├── fearGreedApi.ts       # מדד פחד וחמדנות
│   │   ├── symbolUniverse.ts     # ניהול יוניברס סמלים
│   │   ├── assetUniverse.ts      # מיפוי סמלים
│   │   └── ...
│   │
│   ├── types/                    # TypeScript types
│   │   └── crypto.ts
│   │
│   ├── shared/                   # קוד משותף frontend + worker
│   │   └── targetSymbols.ts      # רשימת סמלים יעד
│   │
│   ├── utils/                    # עזרים
│   │   ├── technicalAnalysis.ts
│   │   ├── advancedTechnicalAnalysis.ts
│   │   ├── smartRecommendationEngine.ts
│   │   ├── errorHandler.ts       # שגיאות מטופסות + fetchJson<T> (נקודת ה-fetch היחידה)
│   │   ├── sanitizer.ts          # קלט לא-אמין: safeParseJSON / readStoredJSON / sanitizeURL
│   │   ├── recommendationEngine.ts  # ⚠️ מיושן — הוחלף ע"י smartRecommendationEngine
│   │   └── ...
│   │
│   └── __tests__/                # בדיקות יחידה
│       ├── intradayMandatory.test.ts
│       ├── portfolioGates.integration.test.ts
│       └── ...
│
├── dist/                         # תוצר build (מועלה ל-Netlify)
├── node_modules/
└── ASSETS/                       # נכסים סטטיים (תמונות, וכו')
```

---

## 3. ארכיטקטורה טכנית

### 3.1 Frontend (Netlify)

| רכיב | תפקיד |
|------|--------|
| **React + Vite** | Framework + bundler |
| **React Router** | ניתוב בין דפים |
| **shadcn/ui + Tailwind** | עיצוב UI |
| **React Query** | ניהול state וטעינת נתונים |
| **Capacitor** | אפליקציה מובייל (Android/iOS) |

**דפים עיקריים:**
- `/` — דף בית עם המלצות קריפטו
- `/portfolio` — תיק השקעות
- `/alerts` — התראות
- `/simulation-bot` — בוט סימולציה (3 מנועים בעמוד אחד)
- `/real-trading` — בוט מסחר אמיתי
- `/advanced-analysis` — ניתוח מתקדם
- `/backtest-results` — תוצאות Backtest Sweep

### 3.2 Backend (Render)

| רכיב | תפקיד |
|------|--------|
| **tradingWorker.ts** | שרת HTTP + לוגיקת Bot 24/7 |
| **simEngineFactory.ts** | מנוע סימולציה משותף — tick, hydrate, reset, getSnapshot |
| **simEngine.ts** | adapter למנוע חדש (MTF) — strategy + telegram tag |
| **legacySimEngine.ts** | adapter למנוע מקורי — strategy + telegram tag |
| **proSimEngine.ts** | adapter למנוע פרו (alg.md) — strategy + telegram tag |
| **intradayEngine.ts** | מנוע החלטות MTF (מקור אמת) |
| **marketDataService.ts** | Multi-Timeframe OHLCV pipeline |
| **bybitApi.ts** | לקוח Bybit (ציבורי + מאומת) |
| **kvStore.ts** | אחסון מקומי (Firestore בייצור) |

**נקודות קצה (API):**
- `GET /health` — בריאות השירות
- `GET /api/bot/state` — מצב Bot אמיתי (דורש Admin Token)
- `POST /api/bot/start` — הפעלת Bot
- `POST /api/bot/stop` — עצירת Bot
- `GET /api/account/summary` — סיכום חשבון
- `GET /api/decisions` — החלטות אחרונות
- `GET /api/sim/state` — מצב סימולציה חדש (ציבורי)
- `POST /api/sim/start` — הפעלת סימולציה
- `GET /api/legacy-sim/state` — מצב סימולציה מקורית
- `GET /api/pro-sim/state` — מצב בוט פרו
- `GET /api/public/universe` — יוניברס סמלים

### 3.3 זרימת נתונים

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Bybit     │────▶│  Worker     │────▶│  Frontend   │
│  ( candles,  │     │  (scan +    │     │  (React)    │
│   ticker )   │     │  evaluate)  │     │             │
└─────────────┘     └──────┬──────┘     └─────────────┘
                            │
                     ┌──────┴──────┐
                     │ Firestore   │
                     │ (warm cache)│
                     └─────────────┘
```

---

## 4. שלושת מנועי הסימולציה

| מנוע | קבצים | מקור אותות | אלגוריתם | שימוש | minConfidence |
|------|-------|-----------|-----------|--------|---------------|
| **חדש** | `simEngine.ts` + `intradayEngine.ts` + `intradayBridge.ts` + `simExecution.ts` + `decisionEngine/` | Multi-Timeframe (1H/15M/5M) | MTF Layer 0-3 + Cost/Edge + Risk | סימולציה + Backtest | 52 |
| **מקורי** | `legacySimEngine.ts` + `legacySimExecution.ts` + `tradeEngine.ts` + `decisionEngine/` | ציון ביטחון משוקלל (7 אינדיקטורים) | alg.md (drifted) | סימולציה | 58 |
| **פרו** | `proSimEngine.ts` + `proSimExecution.ts` + `proAlgEngine.ts` + `proAdvancedAnalysis.ts` + `decisionEngine/` | Advanced Analysis engine (האתר) | alg.md (medoash) | סימולציה | 58 |

**מבנה משותף:**
- כל שלושת המנועים משתמשים ב-`simEngineFactory.ts` כ-base — אותו tick loop, אותו hydrate/persist logic, אותו market-data refresh
- כל adapter (`simEngine.ts`, `legacySimEngine.ts`, `proSimEngine.ts`) מספק את ה-`strategy` object שמפעיל את ה-`DecisionEngine` עם המתאם המתאים (`IntradayAdapter` / `LegacyAdapter` / `ProAdapter`)
- ביצוע פקודות (`fillDueOrders`) משותף לכל המנועים ב-`simExecution.ts`
- שלושת ה-hooks (`useSimulationBot`, `useLegacySimulationBot`, `useProSimulationBot`) מריצים גם הם את ה-`DecisionEngine` בעמוד הסימולציה

**מקורות מידע לכל המנועים:**
- **Bybit** — נתוני שוק (candles, ticker, instruments-info)
- **Binance** — גיבוי לנתוני שרת (fallback)
- **CoinGecko** — נתוני ניתוח (לא intraday)
- **Alternative.me** — מדד פחד וחמדנות

---

## 5. הגדרות פריסה (Deployment)

### 5.1 Render (Backend)

**Root Directory:** `server`

```yaml
# render.yaml
services:
  - type: web
    name: crypto-trading-worker
    runtime: node
    plan: free
    buildCommand: npm install && npm run build
    startCommand: node dist/worker.js
    healthCheckPath: /health
```

**משתני סביבה ב-Render:**
| משתנה | ערך ברירת מחדל | תיאור |
|-------|-----------------|--------|
| `BYBIT_API_KEY` | — | מפתח Bybit |
| `BYBIT_SECRET_KEY` | — | סוד Bybit |
| `BYBIT_TESTNET` | `false` | `true` לטסטרנט |
| `BOT_ADMIN_TOKEN` | — | טוקן ניהול |
| `BOT_DRY_RUN` | `true` | מצב סימולציה |
| `BOT_AUTOSTART` | `true` | הפעלה אוטומטית |
| `BOT_RISK_LEVEL` | `medium` | רמת סיכון |
| `BOT_SYMBOLS` | `100` | מספר סמלים |
| `BOT_MIN_CONFIDENCE` | `60` | סף confidence מינימלי |
| `BOT_POSITION_PERCENT` | `10` | אחוז מהתיק לפוזיציה |
| `BOT_MAX_OPEN_POSITIONS` | `9` | מקסימום פוזיציות פתוחות |
| `CORS_ORIGIN` | `https://crypto-d.netlify.app` | מקורות מותרים |
| `PORT` | `3001` | פורט |

### 5.2 Netlify (Frontend)

```toml
# netlify.toml
[build]
  publish = "dist"
  command = "npm run build"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

**משתני סביבה ב-Netlify:**
- `VITE_TRADING_API_URL` — כתובת ה-Worker ב-Render

---

## 6. Build & Deploy

### Build מקומי

```bash
# Frontend
npm run build

# Worker
npm run build:worker
# או:
cd server && npm install && npm run build
```

### מבנה Build

```
server/
├── dist/
│   └── worker.js          # 361.5kb (מכל את כל התלויות)
├── package.json
└── .data/                 # קבצי מצב (נוצרים בזמן ריצה)
```

---

## 7. אבטחה

| רכיב | הסבר |
|------|------|
| **Admin Token** | נדרש לשליטה בבוט אמיתי (start/stop/state) |
| **CORS** | מוגבל ל-origins מורשים ב-`CORS_ORIGIN` |
| **Rate Limiting** | הגבלת בקשות לפי IP (ברירת מחדל: 120 בקשות/דקה) |
| **Secrets** | מפתחות Bybit נשארים בשרת, לעולם לא נשלחים לפרונט |
| **localStorage** | Admin Token נשמר מקומית (אפשרות משתמש) |

---

## 8. תלויות חיצוניות

| שירות | שימוש |
|--------|--------|
| **Bybit** | נתוני שוק + ביצוע פקודות |
| **Binance** | גיבוי לנתוני שרת (fallback) |
| **CoinGecko** | נתוני ניתוח (לא intraday) |
| **Alternative.me** | מדד פחד וחמדנות |
| **Firebase** | אחסון warm cache + Firestore |
| **Telegram** | התראות על סגירת פוזיציות |

---

## 9. שינויים אחרונים

### שינוי מקור אותות בבוט פרו

בוט פרו עבר שינוי משמעותי: **מקור האותות שונה** מ-internal signal engine ל-**Advanced Analysis engine** של האתר.

**לפני:**
- `proAlgEngine.ts` → `evaluateProSignals()` חישב את כל האותות והביטחון
- 7 אינדיקטורים (MACD, EMA, RSI, Bollinger, Volume, Supertrend, Stochastic)

**אחרי:**
- `proAdvancedAnalysis.ts` → `computeProAdvancedAnalysis()` מחשב את כל האינדיקטורים וההמלצה מהאתר
- אותו אלגוריתם של ניתוח מתקדם שמוצג בדף Advanced Analysis
- `proAlgEngine.ts` משמש רק לניתוב, סיכון ויציאה (Layer 0, 1.5, 2, 3, 4)

### מקסימום פוזיציות

המקסימום פוזיציות קבוע על **7 פוזיציות פתוחות** (עד 2 ממתינות בתור):

```
maxPositions = 7
```

### סינון Confidence

כל שלושת המנועים מיישמים כעת סינון confidence מינימלי:

| בוט | סף מינימלי | מקור בקוד |
|-----|-----------|-----------|
| חדש | 52 | `decisionEngine/adapters/intradayAdapter.ts` |
| Legacy | 58 | `decisionEngine/adapters/legacyAdapter.ts` |
| Pro | 58 | `decisionEngine/adapters/proAdapter.ts` |

### סף ביטחון דינמי (Dynamic Confidence Threshold)

הסף משתנה לפי ATR% — בטווח שבין 2% ל-8% ATR, הסף עולה לינארית עד +15 נקודות:

```typescript
function dynamicConfidenceThreshold(baseThreshold, atrPercent) {
  if (atrPercent <= 2) return baseThreshold;
  if (atrPercent >= 8) return baseThreshold + 15;
  return baseThreshold + ((atrPercent - 2) / 6) * 15;
}
```

| סוג עסקה | סף מינימלי (ATR% <= 2) | סף מקסימלי (ATR% >= 8) |
|----------|------------------------|------------------------|
| Futures | 70 | 85 |
| Spot | 60 | 75 |
| Spot (SOFT_TREND) | 65 | 80 |

### פוגה אחרי רצף הפסדים (Streak Cooldown)

הפוגה פועלת כעת **לפי מטבע** (לא על כל התיק):

```typescript
// אחרי 2 הפסדים רצופים על אותו מטבע — השהיה של 30 דקות
// הפוגה מבוטלת אם ההפסד היה > 5% מסך השווי התיק
const symbolStreakCooldownUntil = streakCooldownFromHistory(closedTrades, equity, symbol);
if (isInStreakCooldown(symbolStreakCooldownUntil)) → BLOCK
```

**תנאים:**
| תנאי | ערך |
|------|-----|
| מספר הפסדים רצופים להפעלה | 2 |
| משך הפוגה | 30 דקות |
| ביטול הפוגה | הפסד > 5% מסך השווי התיק |
| טווח | לפי מטבע (לא פורטפוליו) |

### הצגת סף בהודעות HOLD

הודעות HOLD מציגות כעת את הסף הסטטי המחושב:

```typescript
// tradeEngine.ts — routeTradeType
reason: `SignalScore ${signalScore} מתחת לסף המינימלי לפעולה (${requiredSpotScore})`

// proAlgEngine.ts — routeProTradeType
reason: `confidence ${signal.confidence} מתחת לסף המינימלי (${requiredSpotScore})`
```

### מעגלי הגנה (Circuit Breakers)

| בוט | הפסד יומי (Daily) | הפסד שבועי (Weekly) |
|-----|-------------------|---------------------|
| חדש | 8% | 15% |
| Legacy | 8% | 15% |
| Pro | 8% | 15% |

### חישוב גודל פוזיציה (Kelly Criterion)

| פרמטר | ערך |
|-------|-----|
| ברירת מחדל (Legacy + Pro) | 6% |
| מקסימום | 10% |
| התאמה אדפטיבית | streak/drawdown/winRate |

### מניעת קורלציה (Correlation Gate)

| פרמטר | ערך |
|-------|-----|
| מקסימום פוזיציות מקורלציות | 12 |
| סף קורלציה | 0.7 (Pearson log-returns) |
| חלון זיהוי | 72 נרות H1 |

### יציאה לפי זמן (Time Exit)

| בוט | תנאי |
|-----|------|
| חדש | TREND_PULLBACK: 120 דקות, BREAKOUT_RETEST: 60 דקות, MEAN_REVERSION: 45 דקות |
| Legacy | סגירה מלאה לאחר 48 שעות |
| Pro | 50% סגירה לאחר 24 שעות ללא TP1, הרחבה ל-36 שעות אם התקדמות |

### הפרדת Frontend/Backend

- `server/package.json` נפרד עם תלויות מינימליות (dotenv, esbuild, tsx, typescript)
- `render.yaml` מוגדר עם Root Directory = `server`
- ה-build רץ ישירות מתוך `server/`

### שינויי לוגיקה בבוט פרו (Pro Bot)

בוט פרו עבר שינוי משמעותי: **מקור האותות שונה** מ-internal signal engine ל-**Advanced Analysis engine** של האתר (`proAdvancedAnalysis.ts`).

| רכיב | קודם | עכשיו |
|------|------|-------|
| מקור אותות | `proAlgEngine.ts` → `evaluateProSignals()` | `proAdvancedAnalysis.ts` → `computeProAdvancedAnalysis()` |
| ניתוב/סיכון/יציאה | `proAlgEngine.ts` | `proAlgEngine.ts` (ללא שינוי) |
| ביצוע | `proSimExecution.ts` | `proSimExecution.ts` (ללא שינוי) |

**זרימת החלטה החדשה:**
1. `computeProAdvancedAnalysis()` — מחשב את כל האינדיקטורים וההמלצה מהאתר
2. `detectProRegime()` — זיהוי משטר שוק (Layer 0)
3. `routeProTradeType()` — ניתוב סוג עסקה (Layer 2)
4. `calculateProOptimalEntry()` — תזמון כניסה (Layer 1.5)
5. `calculateProRisk()` — ניהול סיכונים (Layer 3)
6. `evaluateProExit()` — לוגיקת יציאה (Layer 4)

---

## 10. תיקוני באגים אחרונים

### תיקון 1: `MIN_ENTRY_RELATIVE_VOLUME` לא מוגדר ב-Legacy Sim

**קובץ:** `src/services/legacySimExecution.ts`

**בעיה:** המשתנה `MIN_ENTRY_RELATIVE_VOLUME` שייוצא מ-`src/services/tradeEngine.ts` נעשה שימוש ב-`legacySimExecution.ts` ללא ייבוא, גרם ל-`ReferenceError` בזמן ריצה.

**תיקון:** נוסף הייבוא החסר:
```typescript
import { ..., MIN_ENTRY_RELATIVE_VOLUME } from './tradeEngine';
```

### תיקון 2: BacktestResults לא מציג תוצאות / דף ריק

**קובץ:** `src/pages/BacktestResults.tsx`

**בעיה:** הדף קרא `resolveWorkerBaseUrl()` ברמת המודול במקום להשתמש ב-`WorkerAuthContext`. כשכתובת ה-Worker לא הוגדרה:
- `API_BASE` היה מחרוזת ריקה
- קריאות ה-`fetch` הלכו לנתיבים יחסיים שהחזירו `index.html` במקום JSON
- השגיאה נלכדה ב-`console.error` בלבד, ולכן המשתמש ראה דף ריק ללא הודעת שגיאה

**תיקונים:**
- החלפת `resolveWorkerBaseUrl()` ב-`useWorkerAuth()` — כתובת ה-Worker עכשיו ריאקטיבית ומתעדכנת אוטומטית
- הוספת בדיקת `workerBaseUrl` ריק עם הודעת שגיאה ברורה למשתמש
- הוספת `setState(s => ({ ...s, error: msg, status: 'error' }))` ב-catch block כדי שהשגיאה תוצג ב-UI
- הוספת טיפול ב-`res.status === 404` עם הודעת שגיאה

### תיקון 3: שגיאות חיבור ל-Worker

**תיקון:** אותו תיקון של #2 — עכשיו `BacktestResults.tsx` משתמש בכתובת ה-Worker מאותו מקור כמו שאר הדפים (`WorkerAuthContext`), כך שהחיבור עובד באופן עקבי.

### תיקון 4: Periodic reset במנוע חדש

**קובץ:** `src/hooks/useApiPolling.ts`, `server/simEngineFactory.ts`, `src/services/tradingApiClient.ts`

**בעיה:** תצוגת "מנוע חדש · Multi-Timeframe" איתחלה ואז איפסה מחזורית. שני גרמים:
1. `getSnapshot()` ב-`simEngineFactory.ts` לא החזיר `hourlyHistory` — אחרי restart של ה-worker ההיסטוריה בשעתיות נעלמה
2. ב-`useApiPolling.ts` תגובה ישטה מ-poll קודם יכלה לדרוך תגובה עדכנית יותר אם הבקשה הקודמת איחרה

**תיקונים:**
- `simEngineFactory.ts`: נוסף `hourlyHistory` ל-`getSnapshot()` — ההיסטוריה נשמרת גם אחרי restart
- `useApiPolling.ts`: נוסף `pollGenerationRef` + guard `inFlightRef.current !== promise` — תגובות ישטות מתעלמות
- `tradingApiClient.ts`: נוסף `hourlyHistory?: unknown[]` ל-`SimBotSnapshot` interface

### תיקון 5: מigration ל-DecisionEngine מאוחד

**תאריך:** 2026-08-30

**קבצים ששונו:**
- `src/services/decisionEngine/` — אורקסטרטור + 3 adapters (intraday, legacy, pro)
- `server/simEngine.ts`, `server/legacySimEngine.ts`, `server/proSimEngine.ts` — עברו ל-`DecisionEngine`
- `src/hooks/useSimulationBot.ts`, `src/hooks/useLegacySimulationBot.ts`, `src/hooks/useProSimulationBot.ts` — עברו ל-`DecisionEngine`

**מה שונה:**
- כל שלושת המנועים (שרת + דפדפן) מריצים עכשיו את אותה לוגיקת החלטה דרך `DecisionEngine` + המתאם המתאים
- `buildEvaluations` / `buildLegacyEvaluations` / `buildProEvaluations` הוסרו מה-hooks — order generation נשאר ב-`simExecution.ts` / `legacySimExecution.ts` / `proSimExecution.ts`
- תיקון קריסה ב-`intradayAdapter.normalize` על מסלול חסום — מחזיר `NO_SIGNAL` עם `gate` נכון במקום `ERROR`
- שער קורלציה באורקסטרטור תוקן — `candlesBySymbol` אמיתי מ-`OpenPosition.candles`
- `selectAdapter` עם `engineId` מפורש מחזיר את האדפטר המדויק, לא נפילה למנוע אחר
- `MultiTimeframeCandles.h1` שונה ל-`Candle[]` — הוסרו 6 `as Candle[]` מיותרים

**אימות:**
- `tsc --noEmit`: 0 שגיאות
- `vitest run`: 205 טסטים עוברים
- `npm run build`: עובר
- `npm run build:worker`: עובר

---

## 11. קבצי תיעוד נוספים

| קובץ | תיאור |
|------|-------|
| `ALG_intraday.md` | תיעוד מלא של אלגוריתם הבוט החדש (MTF) |
| `ALG_legacy.md` | תיעוד מלא של אלגוריתם הבוט המקורי |
| `ALG_pro.md` | תיעוד מלא של אלגוריתם בוט פרו (alg.md) |

---

## 12. שינויים — החזרת errorHandler / sanitizer / MarketOverview

**תאריך:** 2026-08-30

### מה נוסף לזרימה

| קובץ | מצב קודם | מצב נוכחי |
|---|---|---|
| `src/utils/errorHandler.ts` | יתום — 0 קוראים | נקודת ה-fetch המטופסת היחידה; מחובר ל-`fearGreedApi`, `binancePublicApi` |
| `src/utils/sanitizer.ts` | יתום — 0 קוראים | מחובר ל-`usePortfolio` (קריאת localStorage) |
| `src/components/MarketOverview.tsx` | יתום — 0 קוראים | מרונדר ב-`src/pages/Index.tsx` |

### errorHandler.ts

- `fetchJson<T>` / `readJson<T>` / `safeFetchJson<T>` — timeout, בדיקת סטטוס וטיפוס גוף התשובה במקום אחד. `Response.json()` מחזיר `unknown`, ולכן כל שירות שקרא לו ישירות נשאר עם שגיאת טיפוס או cast.
- מחלקות: `AppError`, `NetworkError`, `TimeoutError`, `APIError`, `ValidationError` + `isRetryable`.
- `handleError` מסווג **לפי טיפוס** ורק לבסוף לפי טקסט. הגרסה הקודמת בדקה `message.includes('401')` — מחרוזת מחיר שמכילה 401 זוהתה כשגיאת הרשאה.
- `withErrorHandling` — החתימה הקודמת (`(...args: unknown[])`) לא התאימה לאף פונקציה אמיתית, כלומר לא ניתן היה להשתמש בו בכלל.

### sanitizer.ts

- **הוסר** `sanitizeHTML` מבוסס regex (whitelist של תגיות). סניטציית HTML ב-regex ניתנת לעקיפה כמחלקה — היא נותנת תחושת ביטחון ולא ביטחון. באפליקציה אין `dangerouslySetInnerHTML` בעץ החי, ו-React מבריח טקסט כברירת מחדל.
- **נוסף** `safeParseJSON` / `readStoredJSON` / `writeStoredJSON` — localStorage הוא קלט לא-אמין, ו-`JSON.parse` עליו זרק.
- `sanitizeObject` מסיר מפתחות `__proto__`/`constructor`/`prototype` ומאפס מספרים לא-סופיים.
- `sanitizeURL`, `sanitizeSymbol`, `sanitizeNumber`, `escapeHTML` (קידוד, לא סינון).

### באג שתוקן דרך זה

`src/hooks/usePortfolio.ts` ביצע `JSON.parse(localStorage.getItem(...))` בלי `try/catch`. ערך פגום → זריקה בתוך `useEffect` → ErrorBoundary. **קבוע**, כי הערך הפגום נשאר בדיסק וכל טעינה חוזרת נכשלה שוב. עכשיו: `readStoredJSON` + guard מבני + נורמליזציה של כל שדה.

### MarketOverview

- קיבל props (`recommendations`, `fearGreedData`, `isLoading`, `showSentiment`) עם נפילה חזרה ל-hook.
- ב-`Index.tsx` החליף 4 כרטיסי סטטיסטיקה inline. מקבל את `filteredRecommendations` — אותה אוכלוסייה שמוצגת ברשימה מתחתיו; `showSentiment={false}` כי `FearGreedIndicator` נמצא מעליו.

### אימות

- 205 טסטים עוברים (9 חדשים ב-`src/__tests__/decisionEngine.golden.test.ts`)
- שגיאות טיפוס: 0
- `npm run build`: עובר
- `npm run build:worker`: עובר

---

## 13. תיקוני P0/P1 — רובד DecisionEngine

**תאריך:** 2026-08-30

### 1. בניית ה-worker נשברה (P0)

`orchestrator.ts` ייבא ערכים (`evaluateCorrelationGate`, `toPositionDirection`, `DEFAULT_CORRELATION_*`) מ-`decisionEngine/types.ts`. הרשימה ב-types.ts נערכה, וה-esbuild של השרת נפל: `No matching export`. בקונפיג של האפליקציה זה עבר — ולכן לא נראה.

**תיקון:** `types.ts` הוא **טיפוסים בלבד**. ערכים מיובאים מהמודול שמחזיק אותם (`../correlation`, `../adaptiveRisk`). כלל: אין ייצוא ערכים דרך מודול טיפוסים.

### 2. המנוע ה-intraday רץ על פרמטרים ריקים (P0)

`evaluateIntradayDecision` עשה `input.params ?? DEFAULT_INTRADAY_PARAMS`. האדפטר העביר `context.params`, שה-orchestrator תמיד כותב אליו מפתח — אובייקט אמיתי, ולכן `??` לא נפל. כל סף היה `undefined`, כל השוואה false.

**מדוד:** אותם נתונים — `DEFAULT` → `NO_ENTRY`, `{}` → `NO_SETUP`. ב-drawdown 50%: `DEFAULT` → `CIRCUIT_BREAKER`, `{}` → `NO_SETUP`.

**תיקון:** `withParams()` ממזג עמוק על ברירות המחדל, ו-`IntradayDecisionInput.params` הוא `Partial<IntradayParams>` — כך ש-`{}` לא יכול יותר לרוקן ספים.

### 3. שער הקורלציה זרק בזמן ריצה (P0)

`toPositionDirection is not a function` — תוצאה של #1. כל הערכה שהגיעה ל-SIGNAL עם פוזיציה פתוחה החזירה `gate:'ERROR'`.

בנוסף: `checkCorrelationGate` בנה `candlesBySymbol` רק מהפוזיציות המוחזקות, בלי הסדרה של **המועמד עצמו** — ולכן גם בלי הקריסה הוא היה נמנע תמיד.

### 4-6. P1

| בעיה | תיקון |
|---|---|
| `EngineAdapter` בלי `execute` | נוסף לממשק |
| `existingExposureByAsset: {}` קשיח ב-6 מקומות | מחושב מהפוזיציות (hooks: `useMemo`; שרתים: `exposureByAsset()`) |
| `openPositions` בלי `candles` ב-6 מקומות | מוזן מ-`correlationCandles` / `candlesBySymbol` |
| `PipelineStage.execute` הוחזר כ-`\| Promise<...>` בעוד כל האדפטרים סינכרוניים | הוגדר סינכרוני — 15 שגיאות טיפוס |
| `metrics: Record<string, number>` קיבל מחרוזת volatility | נוסף שדה `volatilityBand?: string` |
| `DecisionResult.engineId` לא יכול היה להיות `'unknown'` | `ResultEngineId = EngineId \| 'unknown'` |

### פתוח — דורש החלטה

`DEFAULT_MAX_CORRELATED = 12` (`correlation.ts:37`) בעוד `maxOpenPositions = 7`. **השער לא יכול לחסום לעולם.** מבנית הוא עובד (נבדק עם `maxCorrelatedPositions: 2`) — הקבוע הוא מדיניות סיכון, לא באג.

### אימות

- `npm --prefix server run build` — עובר (נכשל לפני)
- 214 טסטים עוברים; `decisionEngineRegression.test.ts` חדש — נופל על כל אחד מ-4 הבאגים ועל שום דבר אחר
- שגיאות טיפוס: 91 → 42. `src/services/decisionEngine/` נקי לגמרי

