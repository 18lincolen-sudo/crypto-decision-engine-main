# מפת ארכיטקטורה — Crypto Decision Engine

> מסמך זה נועד לתת תמונה מלאה ומהירה של הפרוייקט: ארכיטקטורה, קבצים, לוגיקה, מנוי ופרונט.

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
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘              │
│       │             │             │             │                   │
│       └─────────────┴─────────────┴─────────────┘                   │
│                     React Router                                    │
│  ┌──────────────────────────────────────────────────┐              │
│  │  SimulationBot (3 מנועי סימולציה)               │              │
│  │  RealTradingBot (בוט מסחר אמיתי)                │              │
│  └──────────────────────────────────────────────────┘              │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ HTTPS API
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Render (Backend Worker)                         │
│  https://crypto-decision-engine-main.onrender.com                   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │  tradingWorker.ts (Node.js HTTP Server)                   │      │
│  │                                                           │      │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │      │
│  │  │  Live Bot   │  │  Sim Engine │  │ Legacy Sim  │      │      │
│  │  │  (מסחר     │  │  (סימולציה │  │ Engine      │      │      │
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
│   ├── index.mjs                 # נקודת כניסה (ייבוא מ-tradingWorker.ts)
│   ├── package.json              # תלויות backend (dotenv)
│   ├── simEngine.ts              # מנוע סימולציה חדש (MTF)
│   ├── legacySimEngine.ts        # מנוע סימולציה מקורי
│   ├── proSimEngine.ts           # מנוע סימולציה פרו (alg.md)
│   └── .data/                    # קבצי מצב (מועלים אוטומטית ל-Firestore)
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
│   │   ├── SimulationBot.tsx     # בוט סימולציה (3 מנועים)
│   │   ├── RealTradingBot.tsx    # בוט מסחר אמיתי
│   │   ├── AdvancedAnalysis.tsx  # ניתוח מתקדם
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
│   │   │   ├── SimulationEngineColumn.tsx
│   │   │   └── PortfolioRiskMeter.tsx
│   │   └── ui/                   # shadcn/ui components
│   │
│   ├── contexts/                 # React Contexts
│   │   ├── ThemeContext.tsx
│   │   ├── WorkerAuthContext.tsx  # כתובת Worker + Admin Token
│   │   ├── SimulationBotContext.tsx
│   │   ├── LegacySimulationBotContext.tsx
│   │   └── ProSimulationBotContext.tsx
│   │
│   ├── hooks/                    # Custom Hooks
│   │   ├── useCryptoData.ts
│   │   ├── usePortfolio.ts
│   │   ├── useSimulationBot.ts
│   │   ├── useLegacySimulationBot.ts
│   │   ├── useProSimulationBot.ts
│   │   └── ...
│   │
│   ├── services/                 # לוגיקה עסקית + API
│   │   ├── tradingApiClient.ts   # לקוח HTTP ל-Worker
│   │   ├── workerConfig.ts       # פתרון כתובת Worker
│   │   ├── intradayEngine.ts     # מנוע החלטות MTF (מקור אמת)
│   │   ├── intradayBridge.ts     # גשר בין סימולציה ל-intradayEngine
│   │   ├── intradayRegime.ts     # זיהוי משטר שוק (Layer 0)
│   │   ├── intradaySetup.ts      # זיהוי Setup (Layer 1)
│   │   ├── intradayEntry.ts      # אישור כניסה (Layer 2)
│   │   ├── intradayRisk.ts       # ניהול סיכונים (Layer 3)
│   │   ├── marketDataService.ts  # Multi-Timeframe OHLCV pipeline
│   │   ├── simExecution.ts       # לוגיקת ביצוע סימולציה (משותף)
│   │   ├── legacySimExecution.ts # לוגיקת ביצוע legacy
│   │   ├── proSimExecution.ts    # לוגיקת ביצוע Pro (alg.md)
│   │   ├── proAlgEngine.ts       # מנוע Pro (alg.md)
│   │   ├── tradeEngine.ts        # מנוע מסחר בסיסי
│   │   ├── adaptiveRisk.ts       # סיכון adaptiv
│   │   ├── correlation.ts        # בדיקת קורלציה
│   │   ├── bybitApi.ts           # לקוח Bybit (ציבורי + מאומת)
│   │   ├── binancePublicApi.ts   # לקוח Binance (ציבורי)
│   │   ├── coinGeckoApi.ts       # לקוח CoinGecko (נטלול)
│   │   ├── fearGreedApi.ts       # מדד פחד וחמדנות
│   │   ├── firebaseSync.ts       # סנכרון Firebase
│   │   ├── symbolUniverse.ts     # ניהול יוניברס סמלים
│   │   ├── assetUniverse.ts      # מיפוי סמלים
│   │   └── ...
│   │
│   ├── workers/                  # Worker (server-side)
│   │   └── tradingWorker.ts      # שרת HTTP + לוגיקת Bot
│   │
│   ├── types/                    # TypeScript types
│   │   └── crypto.ts
│   │
│   ├── shared/                   # קוד משותף frontend + worker
│   │   └── targetSymbols.ts      # רשימת סמלים יעד
│   │
│   ├── utils/                    # עזרים
│   │   ├── technicalAnalysis.ts
│   │   ├── sanitizer.ts
│   │   └── ...
│   │
│   └── __tests__/                # בדיקות יחידה
│       ├── intradayMandatory.test.ts
│       ├── portfolioGates.integration.test.ts
│       └── ...
│
├── dist/                         # תוצר build (מועלה ל-Netlify)
├── node_modules/
└── docs/                         # תיעוד (אם קיים)
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
| **Firebase SDK** | סנכרון נתונים (Firestore) |
| **Capacitor** | אפליקציה מובייל (Android/iOS) |

**דפים עיקריים:**
- `/` — דף בית עם המלצות קריפטו
- `/portfolio` — תיק השקעות
- `/alerts` — התראות
- `/simulation-bot` — בוט סימולציה (3 מנועים)
- `/real-trading` — בוט מסחר אמיתי
- `/advanced-analysis` — ניתוח מתקדם

### 3.2 Backend (Render)

| רכיב | תפקיד |
|------|--------|
| **tradingWorker.ts** | שרת HTTP + לוגיקת Bot 24/7 |
| **simEngine.ts** | מנוע סימולציה חדש (MTF) |
| **legacySimEngine.ts** | מנוע סימולציה מקורי |
| **proSimEngine.ts** | מנוע סימו�לציה פרו (alg.md) |
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

| מנוע | קובץ | אלגוריתם | שימוש |
|------|------|-----------|--------|
| **חדש** | `simEngine.ts` + `intradayEngine.ts` | Multi-Timeframe (1H/15M/5M) | סימולציה + Backtest |
| **מקורי** | `legacySimEngine.ts` + `tradeEngine.ts` | ציון ביטחון משוקלל | סימולציה |
| **פרו** | `proSimEngine.ts` + `proAlgEngine.ts` | alg.md מדויק | סימולציה |

---

## 5. הגדרות פריסה (Deployment)

### 5.1 Render (Backend)

```yaml
# render.yaml
services:
  - type: web
    name: crypto-trading-worker
    runtime: node
    plan: free
    buildCommand: npm install --include=dev && npm run build:worker
    startCommand: node dist/worker.js
    healthCheckPath: /health
```

**משתני סביבה ב-Render:**
- `BYBIT_API_KEY` / `BYBIT_SECRET_KEY` — מפתחות Bybit
- `BYBIT_TESTNET` — `true` לטסטרנט, `false` למ�ייננט
- `BOT_ADMIN_TOKEN` — טוקן ניהול
- `BOT_DRY_RUN` — `true` למצב סימולציה
- `CORS_ORIGIN` — מקורות מותרים (למשל: `https://crypto-d.netlify.app`)
- `PORT` — `3001`

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
- `VITE_FIREBASE_PROJECT_ID` — פרויקט Firebase
- `VITE_FIREBASE_API_KEY` — מפתח Firebase

---

## 6. אבטחה

| רכיב | הסבר |
|------|------|
| **Admin Token** | נדרש לשליטה בבוט אמיתי (start/stop/state) |
| **CORS** | מוגבל ל-origins מורשים ב-`CORS_ORIGIN` |
| **Rate Limiting** | הגבלת בקשות לפי IP |
| **Secrets** | מפתחות Bybit נשארים בשרת, לעולם לא נשלחים לפרונט |
| **localStorage** | Admin Token נשמר מקומית (אפשרות משתמש) |

---

## 7. תלויות חיצוניות

| שירות | שימוש |
|--------|--------|
| **Bybit** | נתוני שוק + ביצוע פקודות |
| **Binance** | גיבוי לנתוני שרת (fallback) |
| **CoinGecko** | נתוני ניתוח (לא intraday) |
| **Alternative.me** | מדד פחד וחמדנות |
| **Firebase** | אחסון warm cache + Firestore |
| **Telegram** | התראות על סגירת פוזיציות |

---

## 8. תיקון CORS — מדריך מהיר

### הבעיה
```
Access to fetch at 'https://crypto-decision-engine-main.onrender.com/api/pro-sim/state'
from origin 'https://crypto-d.netlify.app' has been blocked by CORS policy:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

### סיבות אפשריות
1. **השירות ב-Render לא redeploy אחרי שינוי env vars** — שינויים ב-Render Dashboard דורשים redeploy.
2. **`CORS_ORIGIN` ב-Render לא תואם את ה-Netlify origin** — צריך להיות `https://crypto-d.netlify.app` בדיוק.
3. **הפרונט עדיין מכוון לכתובת ישנה** — `VITE_TRADING_API_URL` ב-Netlify נטען בזמן build, שינוי דורש deploy חדש.
4. **שירות Render שונה / נוצר מחדש** — אם נוצר שירות חדש, ה-env vars מ-`render.yaml` לא חלים עליו אוטומטית.

### פתרון
1. ב-Render Dashboard → Environment → וודא ש-`CORS_ORIGIN=https://crypto-d.netlify.app`.
2. ב-Render Dashboard → התקע redeploy ידני.
3. ב-Netlify → Site settings → Environment → וודא ש-`VITE_TRADING_API_URL` מכוון לכתובת ה-Render הנכונה.
4. ב-Netlify → Trigger deploy חדש (לא רק save).
5. בדוק `/health` ב-Render — האחור `cors` אמור להראות `https://crypto-d.netlify.app`.
