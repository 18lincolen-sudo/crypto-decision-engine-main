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
│  https://crypto-decision-engine-main-hev8.onrender.com                  │
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

npm workspace עם שני חברי workspace — `packages/engine` (מנוע ההחלטות, משותף לדפדפן ולשרת) ו-`server` — לצד `src/` (frontend בלבד) בשורש. ראו §5.1 לגבי למה `packages/engine` יושב מחוץ ל-`server/` בכוונה.

```
crypto-decision-engine-main/
├── .env / .env.example           # משתני סביבה
├── package.json                  # workspaces: ["packages/*", "server"]
├── vite.config.ts / tailwind.config.ts
├── tsconfig.json                 # references בלבד — tsc --noEmit על קובץ זה הוא no-op, ראו §6
├── tsconfig.app.json             # התצורה שבפועל בודקת את src/ (include: ["src", "!server"])
├── tsconfig.worker.json          # בודקת ["server", "packages/engine"]
├── netlify.toml                  # קונפיגורציית Netlify
├── render.yaml                   # קונפיגורציית Render — קרא את האזהרה שבתוכו לפני עריכה
│
├── packages/engine/               # מנוע ההחלטות — npm workspace, פרטי, לעולם לא מפורסם
│   ├── package.json               # "@cde/engine", exports: ./  ./market-data  ./execution  ./analysis
│   └── src/
│       ├── index.ts               # DecisionEngine + 3 adapters + טיפוסי דומיין + intradayBridge + correlation
│       ├── market-data.ts         # marketDataService, cryptoPriceAggregator, assetUniverse, symbolUniverse
│       ├── execution.ts           # tradeEngine, legacySimExecution, proSimExecution, simExecution, adaptiveRisk
│       ├── analysis.ts            # proAlgEngine, proAdvancedAnalysis, intradayEngine + כל שכבותיו, ניתוח טכני
│       ├── services/              # 27 מודולים — tradeEngine, decisionEngine/, intraday*, pro*, marketDataService...
│       ├── utils/                 # technicalAnalysis, advancedTechnicalAnalysis, smartRecommendationEngine
│       ├── shared/targetSymbols.ts
│       └── types/crypto.ts        # טיפוסי הדומיין המשותפים (CryptoData, PortfolioItem, MarketRegimeResult...)
│
├── server/                       # קבצי backend (מועלים ל-Render; ה-Root Directory חייב להישאר ריק — §5.1)
│   ├── tradingWorker.ts          # שרת HTTP + לוגיקת Bot 24/7
│   ├── simEngineFactory.ts       # מנוע סימולציה משותף (3 מנועים) — tick, hydrate, persist, getSnapshot
│   ├── simEngine.ts / legacySimEngine.ts / proSimEngine.ts  # adapter דק לכל מנוע — strategy object בלבד
│   ├── backtestRunner.ts         # ריצת Backtest Sweep — צרכן של packages/engine, לא חלק ממנו (ראו §4)
│   ├── kvStore.ts                # Firestore (אם FIREBASE_PROJECT_ID/KEY מוגדרים ותקינים) + קובץ מקומי כגיבוי
│   ├── historicalCandleCache.ts  # מטמון כתרים היסטוריים ל-backtest
│   └── .data/                    # קבצי מצב מקומיים — אפמריים על Render Free, נמחקים בכל restart
│
├── ALG_intraday.md / ALG_legacy.md / ALG_pro.md / ARCHITECTURE.md   # תיעוד
│
├── src/                          # Frontend בלבד — לא נכנס לבנייה של ה-Worker
│   ├── main.tsx / App.tsx / index.css
│   │
│   ├── pages/                    # Index, Portfolio, Alerts, SimulationBot, RealTradingBot,
│   │                             # AdvancedAnalysis, BacktestResults, NotFound
│   ├── components/
│   │   ├── Gauge.tsx              # דיאל SVG רב-פעמי (סגנון מד-מהירות) — Fear&Greed, מדי חשיפה
│   │   ├── FearGreedIndicator.tsx
│   │   ├── dashboard/ExecutiveDashboard.tsx   # מרכז פיקוד Bybit Live + סיכום 3 מנועי הסימולציה
│   │   ├── trading/{SimulationEngineColumn,PortfolioPulseCard,LivePositionChart,PortfolioRiskMeter}.tsx
│   │   └── ui/                   # shadcn/ui components
│   │
│   ├── contexts/                 # ThemeContext, WorkerAuthContext,
│   │                             # SimulationBotContext / LegacySimulationBotContext / ProSimulationBotContext
│   │                             # שלושת האחרונים מורכבים ב-App.tsx סביב כל ה-router — כל דף,
│   │                             # לא רק /simulation-bot, רואה מצב בוט חי מסונכרן עם השרת
│   │
│   ├── hooks/                    # useCryptoData, usePortfolio, useSimulationBot/useLegacySimulationBot/
│   │                             # useProSimulationBot, useApiPolling (polling+backoff משותף), useBackgroundWorker
│   │
│   ├── services/                 # 7 קבצים בלבד — לקוחות API + תצורה, לא לוגיקת מנוע:
│   │   ├── tradingApiClient.ts   # לקוח HTTP ל-Worker
│   │   ├── workerConfig.ts       # פתרון כתובת Worker (env / localStorage / ידני)
│   │   ├── bybitApi.ts / binancePublicApi.ts / coinGeckoApi.ts / fearGreedApi.ts
│   │   └── liveUniverse.ts
│   │
│   ├── utils/                    # errorHandler.ts (fetchJson<T> — נקודת ה-fetch המטופסת היחידה),
│   │                             # sanitizer.ts (safeParseJSON/readStoredJSON/sanitizeURL), formatPrice.ts
│   │
│   └── __tests__/                # 24 קבצי בדיקה — vitest, כולל מודולי packages/engine (import מ-'@cde/engine')
│
├── .github/workflows/            # ci.yml (typecheck+test+build), keepalive.yml (פינג חיצוני כל 10 דק')
├── dist/                         # תוצר build (Vite → Netlify) — לא כולל את ה-Worker
└── ASSETS/                       # נכסים סטטיים
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

| מנוע | קבצים (כולם ב-`packages/engine/src/services/` אלא אם צוין) | מקור אותות | אלגוריתם | minConfidence |
|------|-------|-----------|-----------|---------------|
| **חדש (MTF)** | `server/simEngine.ts` + `intradayEngine.ts` + `intradayBridge.ts` + `simExecution.ts` + `decisionEngine/` | Multi-Timeframe (1H/15M/5M) | MTF Layer 0-3 + Cost/Edge + Risk | 52 |
| **מקורי (Legacy)** | `server/legacySimEngine.ts` + `legacySimExecution.ts` + `tradeEngine.ts` + `decisionEngine/` | ציון ביטחון משוקלל (7 אינדיקטורים) | alg.md (drifted — ראו ALG_legacy.md §11) | 58 |
| **פרו (Pro)** | `server/proSimEngine.ts` + `proSimExecution.ts` + `proAlgEngine.ts` + `proAdvancedAnalysis.ts` + `decisionEngine/` | Advanced Analysis engine (האתר) | alg.md לניתוב/סיכון/יציאה; מקור האותות עצמו הוחלף | 58 |

**מבנה משותף:**
- כל שלושת המנועים משתמשים ב-`server/simEngineFactory.ts` כ-base — אותו tick loop, אותו hydrate/persist logic, אותו market-data refresh
- כל adapter (`server/simEngine.ts`, `legacySimEngine.ts`, `proSimEngine.ts`) מספק את ה-`strategy` object שמפעיל את ה-`DecisionEngine` עם המתאם המתאים (`IntradayAdapter` / `LegacyAdapter` / `ProAdapter`)
- ביצוע פקודות (`fillDueOrders`) משותף לכל המנועים ב-`simExecution.ts`
- שלושת ה-hooks (`useSimulationBot`, `useLegacySimulationBot`, `useProSimulationBot`) מריצים גם הם `DecisionEngine` בדפדפן — fallback מקומי כשה-Worker לא נגיש. שלושת ה-Context‑ים העוטפים אותם מורכבים ב-`App.tsx` סביב כל ה-router (לא רק `/simulation-bot`), כך שכל דף — כולל דף הבית — רואה מצב בוט חי ומסונכרן עם השרת

**מקורות מידע לכל המנועים:**
- **Bybit** — נתוני שוק (candles, ticker, instruments-info)
- **Binance** — גיבוי לנתוני שרת (fallback)
- **CoinGecko** — נתוני ניתוח (לא intraday)
- **Alternative.me** — מדד פחד וחמדנות

---

## 5. הגדרות פריסה (Deployment)

### 5.1 Render (Backend)

**Live worker:** `https://crypto-decision-engine-main-hev8.onrender.com`
(the value of `VITE_TRADING_API_URL`, baked into the frontend at build time).

`render.yaml` as it stands in the repo — **note the root directory is the repo
root, not `server`**:

```yaml
# render.yaml
services:
  - type: web
    name: crypto-trading-worker
    runtime: node
    plan: free
    buildCommand: npm install && npm --prefix server install && npm --prefix server run build
    startCommand: node server/dist/worker.js
    healthCheckPath: /health
    autoDeploy: true
```

> ### ⚠️ Root Directory must be EMPTY — this is not a style preference
>
> Render's Root Directory field says: *"code changes outside of this directory
> do not trigger an auto-deploy."*
>
> The worker looks like it lives in `server/`, but its bundle pulls **28
> modules from `src/`** — `decisionEngine`, `proAlgEngine`, `intradayEngine`,
> `marketDataService` and the rest. Every trading decision is computed by
> shared code. Render checks out the whole repo regardless, so `../src/...`
> resolves and the build **succeeds** with Root Directory set to `server`; it
> just stops redeploying whenever the engine changes.
>
> That failure is silent: green builds, a healthy `/health`, and a worker
> serving a stale decision engine. It is what produced 56 × `NO_SIGNAL
> [UNKNOWN]` on the Legacy and Pro bots after the fix had already been pushed
> to `main`.
>
> | Setting | Correct | Symptom if set to `server` |
> | --- | --- | --- |
> | Root Directory | *(empty)* | engine fixes never deploy |
> | Build Command | `npm install && npm --prefix server install && npm --prefix server run build` | `npm install && npm run build` |
> | Start Command | `node server/dist/worker.js` | `node dist/worker.js` |
>
> The service was created by hand, not from this blueprint — the live hostname
> derives from the *repo* name, not from `name:` above. So the **dashboard is
> the source of truth**; `render.yaml` documents the intended shape. Do not
> rename either to match the other before reading the caveat at the top of
> `render.yaml`.

**Two separate build outputs — do not confuse them:**

| Output | Built by | Deployed to | Contains |
| --- | --- | --- | --- |
| `dist/` | `npm run build` (Vite) | Netlify | frontend only |
| `server/dist/worker.js` | `npm --prefix server run build` (esbuild) | Render | the worker |

There is no `dist/worker.js`. Uploading `dist/` to Netlify updates the UI only;
all bot decisions are computed by the Render worker, so an engine fix is not
live until Render rebuilds.

**משתני סביבה ב-Render** (ערכים כפי שמוגדרים בפועל ב-`render.yaml`; `sync: false` = לא מנוהל דרך ה-blueprint, מוזן ידנית בדשבורד):
| משתנה | ערך | תיאור |
|-------|-----|--------|
| `BYBIT_API_KEY` / `BYBIT_SECRET_KEY` | — (`sync: false`) | מפתחות Bybit |
| `BYBIT_TESTNET` | `false` | `true` לטסטנט |
| `BOT_ADMIN_TOKEN` | — (`sync: false`) | טוקן ניהול |
| `BOT_DRY_RUN` | `true` | מצב סימולציה (לא שולח פקודות אמיתיות) |
| `BOT_AUTOSTART` | `false` | אין הפעלה אוטומטית ב-boot |
| `BOT_RISK_LEVEL` | `medium` | רמת סיכון |
| `BOT_SYMBOLS` | `100` | מספר סמלים ביקום |
| `BOT_MIN_CONFIDENCE` | `60` | סף confidence מינימלי (בוט מסחר אמיתי) |
| `BOT_POSITION_PERCENT` | `10` | אחוז מהתיק לפוזיציה |
| `BOT_MAX_OPEN_POSITIONS` | `7` | מקסימום פוזיציות פתוחות |
| `BOT_MAX_FUTURES_POSITIONS` | `2` | מקסימום פוזיציות Futures |
| `BOT_SCAN_CONCURRENCY` | `5` | סריקות מקבילות |
| `BOT_SCAN_INTERVAL_SECONDS` | `300` | מרווח סריקה (בוט מסחר אמיתי) |
| `BOT_RATE_LIMIT_MAX` / `_WINDOW_MS` | `300` / `120000` | הגבלת קצב API פנימית |
| `FIREBASE_PROJECT_ID` / `FIREBASE_SERVICE_ACCOUNT_KEY` | — (`sync: false`) | Firestore — נדרש כדי ש-`kvStore.ts` ישרוד restart (§6, "עמידות מול Render Free") |
| `CORS_ORIGIN` | `https://crypto-d.netlify.app,http://localhost:8080,http://localhost:5173` | מקורות מותרים — רשימה מפורשת, ללא wildcard |
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
│   └── worker.js          # מכיל את כל התלויות, כולל @cde/engine (esbuild bundle)
├── package.json
└── .data/                 # קבצי מצב מקומיים — נוצרים בזמן ריצה, נמחקים בכל restart
```

### typecheck — להשתמש ב-npm scripts, לא ב-`tsc` הגולמי

`tsconfig.json` בשורש הוא `"files": []` + `references` בלבד — הרצת `tsc --noEmit` ישירות עליו **לא בודקת שום קובץ** ויוצאת 0 תמיד (project references דורש `--build`). `npm run typecheck` (→ `tsc --noEmit -p tsconfig.app.json`) ו-`npm run typecheck:worker` (→ `tsc --noEmit -p tsconfig.worker.json`) הן הבדיקות האמיתיות — גם CI (`.github/workflows/ci.yml`) מריץ אותן ישירות, לא את הקובץ בשורש.

### עמידות מול Render Free (Persistence & Uptime)

Render מרדים שירות חינמי אחרי 15 דקות בלי תעבורה נכנסת, ומעניק לו קונטיינר **חדש עם דיסק ריק** בכל הפעלה מחדש — מדיניות רשמית, לא תקלה ([render.com/docs/free](https://render.com/docs/free)). שני מנגנונים מתמודדים עם זה, וצריך את שניהם:

1. **`kvStore.ts`** — כותב ל-Firestore (עמיד) כשמוגדר, לגיבוי מקומי (`.data/`, אפמרי) תמיד. הבחירה נעשית לפי האם Firestore **מוגדר בפועל** (`FirestoreKV.isConfigured()`) — לא לפי `NODE_ENV`, ש-Render לא מגדיר אוטומטית. אם Firestore לא מוגדר, השרת כותב אזהרה חד-פעמית ב-boot: `[kv] ... bot state is NOT durable`.
2. **`.github/workflows/keepalive.yml`** — פינג חיצוני אמיתי ל-`/health` כל 10 דקות. הפינג העצמי הפנימי שב-`tradingWorker.ts` (כל 8 דקות) יכול למנוע הירדמות ראשונה, אבל לא להעיר קונטיינר שכבר נרדם — מה שרץ בתוכו כבר לא רץ.

**מאומת:** מצב שלושת הבוטים (trades/positions/cash) נבדק זהה לפני ואחרי restart אמיתי ב-Render, אחרי ש-Firestore הוגדר ו-Cloud Firestore API הופעל בפרויקט Google Cloud (403 עד אז).

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

## 9. מדיניות סיכון — השוואה חוצה-מנועים

טבלה מרוכזת; לפירוט המלא (נוסחאות, קוד) ראו את קובץ ה-ALG של כל מנוע.

| מדיניות | חדש (MTF) | Legacy | Pro |
|---|---|---|---|
| Confidence floor (סימולציה) | 52 | 58 | 58 |
| סף ביטחון | סטטי | סטטי | דינמי לפי ATR% (§ ALG_pro.md §3, Layer 2) |
| מעגל הגנה יומי / שבועי | 8% / 15% | 8% / 15% | 8% / 15% |
| Kelly sizing | risk-first (0.5% equity / stop distance) | 6% ברירת מחדל, מקס' 10% | 6% ברירת מחדל, מקס' 10% |
| Streak cooldown | 2 הפסדים רצופים באותו מטבע → 30 דק' (מבוטל אם הפסד > 5% מהתיק) | זהה | זהה |
| Correlation gate | מקס' 12 פוזיציות מקורלציות, סף 0.7 Pearson, חלון 72 נרות H1 | זהה | זהה |
| מקסימום פוזיציות | 7 פתוחות / 2 Futures | זהה | זהה |
| Time exit | לפי Setup: 45–120 דק' | סגירה מלאה אחרי 48 שעות | 50% אחרי 24 שעות ללא TP1, הרחבה ל-36 |

**פתוח — דורש החלטה:** `DEFAULT_MAX_CORRELATED = 12` (`correlation.ts`) בעוד `maxOpenPositions = 7` — השער לא יכול לחסום כל עוד אין החזקה בפועל של 12+ פוזיציות מקורלציות. מבנית תקין (נבדק עם `maxCorrelatedPositions: 2`); הקבוע הוא החלטת מדיניות סיכון, לא באג.

---

## 11. קבצי תיעוד נוספים

| קובץ | תיאור |
|------|-------|
| `ALG_intraday.md` | תיעוד מלא של אלגוריתם הבוט החדש (MTF) |
| `ALG_legacy.md` | תיעוד מלא של אלגוריתם הבוט המקורי |
| `ALG_pro.md` | תיעוד מלא של אלגוריתם בוט פרו (alg.md) |

---


