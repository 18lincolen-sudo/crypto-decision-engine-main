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
│   ├── simEngine.ts              # מנוע סימולציה חדש (MTF)
│   ├── legacySimEngine.ts        # מנוע סימולציה מקורי
│   ├── proSimEngine.ts           # מנוע סימולציה פרו (alg.md)
│   ├── kvStore.ts                # אחסון מקומי
│   └── .data/                    # קבצי מצב (מועלים אוטומטית ל-Firestore)
│
├── ALG_intraday.md               # תיעוד אלגוריתם בוט חדש
├── ALG_legacy.md                 # תיעוד אלגוריתם בוט מקורי
├── ALG_pro.md                    # תיעוד אלגוריתם בוט פרו
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
│   │   ├── adaptiveRisk.ts       # סיכון אדפטיבי
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
| **proSimEngine.ts** | מנוע סימולציה פרו (alg.md) |
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

| מנוע | קובץ | אלגוריתם | שימוש | minConfidence |
|------|------|-----------|--------|---------------|
| **חדש** | `simEngine.ts` + `intradayEngine.ts` | Multi-Timeframe (1H/15M/5M) | סימולציה + Backtest | 52 |
| **מקורי** | `legacySimEngine.ts` + `tradeEngine.ts` | ציון ביטחון משוקלל | סימולציה | 58 |
| **פרו** | `proSimEngine.ts` + `proAlgEngine.ts` | alg.md מדויק | סימולציה | 60 |

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
- `VITE_FIREBASE_PROJECT_ID` — פרויקט Firebase
- `VITE_FIREBASE_API_KEY` — מפתח Firebase

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

### מקסימום פוזיציות

המקסימום פוזיציות קבוע על **7 פוזיציות פתוחות** (עד 2 ממתינות בתור):

```
maxPositions = 7
```

### סינון Confidence

כל שלושת המנועים מיישמים כעת סינון confidence מינימלי:

| בוט | סף מינימלי | מקור בקוד |
|-----|-----------|-----------|
| חדש | 52 | `simExecution.ts` |
| Legacy | 58 | `legacySimExecution.ts` |
| Pro | 60 | `proSimExecution.ts` |

### סף Futures דינמי

הסף ל-Futures הופחת מ-72 ל-70:
```typescript
const futuresThreshold = dynamicConfidenceThreshold(70, atrPercent);
```

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

### הצגת סף דינמי בהודעות HOLD

הודעות HOLD מציגות כעת את הסף הדינמי המחושב (לא ליטרל קשיח):

```typescript
// tradeEngine.ts — routeTradeType
reason: `SignalScore ${signalScore} מתחת לסף המינימלי לפעולה (${requiredSpotScore.toFixed(1)})`

// proAlgEngine.ts — routeProTradeType
reason: `confidence ${signal.confidence} מתחת לסף המינימלי (${requiredSpotScore.toFixed(1)})`
```

הסף מחושב דינמית לפי ATR% (בסיס 60, רמפה עד 75 ב-EXTREME vol).

### מעגלי הגנה (Circuit Breakers)

| בוט | הפסד יומי (Daily) | הפסד שבועי (Weekly) |
|-----|-------------------|---------------------|
| Legacy | 6% | 13% |
| Pro | 8% | 15% |

### הפרדת Frontend/Backend

- `server/package.json` נפרד עם תלויות מינימליות (dotenv, esbuild, tsx, typescript)
- `render.yaml` מוגדר עם Root Directory = `server`
- ה-build רץ ישירות מתוך `server/`

---

## 10. קבצי תיעוד נוספים

| קובץ | תיאור |
|------|-------|
| `ALG_intraday.md` | תיעוד מלא של אלגוריתם הבוט החדש (MTF) |
| `ALG_legacy.md` | תיעוד מלא של אלגוריתם הבוט המקורי |
| `ALG_pro.md` | תיעוד מלא של אלגוריתם בוט פרו (alg.md) |
