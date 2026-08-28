# ALG_intraday.md — אלגוריתם בוט סימולציה חדש (Multi-Timeframe Intraday)

> מסמך זה מתאר בפירוט את אלגוריתם ההחלטה של בוט הסימולציה החדש, כולל כל השלבים, השערולים, והחישובים.

---

## 1. סקירה כללית

הבוט החדש משתמש באלגוריתם **Multi-Timeframe Intraday** שמנתח שלושה פריימי זמן בו-זמנית:
- **1H (שעה)** — זיהוי משטר שוק (Layer 0)
- **15M (15 דקות)** — זיהוי Setup (Layer 1)
- **5M (5 דקות)** — אישור כניסה (Layer 2)

**מקורות מידע:**
- **Bybit** — נתוני שוק (candles, ticker, instruments-info) עם גיבוי מ-Binance
- **CoinGecko** — נתוני ניתוח (לא intraday)
- **Alternative.me** — מדד פחד וחמדנות (Fear & Greed Index)

**קבצים מרכזיים:**
| קובץ | תפקיד |
|------|-------|
| `src/services/intradayEngine.ts` | מרכז ההחלטות — evaluateIntradayDecision |
| `src/services/intradayRegime.ts` | זיהוי משטר שוק (Layer 0) |
| `src/services/intradaySetup.ts` | זיהוי Setup (Layer 1) |
| `src/services/intradayEntry.ts` | אישור כניסה (Layer 2) |
| `src/services/intradayRisk.ts` | ניהול סיכונים (Layer 3) |
| `src/services/simExecution.ts` | לוגיקת ביצוע סימולציה (משותף) |
| `src/services/intradayBridge.ts` | גשר בין סימולציה ל-intradayEngine |
| `server/simEngine.ts` | מנוע סימולציה 24/7 בשרת |

---

## 2. שלבי ההחלטה (Gate Order)

האלגוריתם עובר דרך שלבים סדרתיים — **השערול הראשון שנכשל עוצר את התהליך**:

```
NO_DATA → CIRCUIT_BREAKER → EXPOSURE → NO_REGIME → VOLATILITY → 
LIQUIDITY → SPREAD → NO_SETUP → NO_ENTRY → COST → RISK
```

---

## 3. פירוט השלבים

### GATE 1: NO_DATA — בדיקת נתונים מינימלית

```typescript
const min1h = 200;   // מינימום 200 נרות שעה
const min15m = 300;  // מינימום 300 נרות 15 דקות
const min5m = 500;   // מינימום 500 נרות 5 דקות
```

**תנאי:** אם חסרים נרות באף פריים — ההחלטה נעצרת מיד.

---

### GATE 2: CIRCUIT_BREAKER — הגנת תיק

```typescript
// נעילת מערכת אם התיק נעול
if (p.systemLocked) → BLOCK

// Drawdown יומי >= 8% — חסימה
if (p.dailyDrawdownPercent >= 8) → BLOCK

// Drawdown שבועי >= 15% — נעילה
if (p.weeklyDrawdownPercent >= 15) → BLOCK
```

---

### GATE 3: EXPOSURE — מגבלת חשיפה

```typescript
// מקסימום פוזיציות פתוחות
if (p.openPositionsCount >= params.maxOpenPositions) → BLOCK

// נכס כבר פתוח (אין כפילות Spot/Futures)
if (sameAsset) → BLOCK
```

**מקסימום פוזיציות:**
```typescript
maxPositions = 7  // קבוע: עד 7 פוזיציות פתוחות, 2 ממתינות בתור
```

---

### LAYER 0: 1H REGIME — זיהוי משטר שוק

**מקור:** `src/services/intradayRegime.ts`

**תוצאות אפשריות:**
| Regime | תיאור | Futures |
|--------|-------|---------|
| `TRENDING` | מגמה ברורה | ✅ מותר |
| `RANGING` | טווח (דשדוש) | ❌ חסום |
| `TRANSITIONAL` | מעבר בין משטרים | ❌ חסום (Spot רק איכותי מאוד) |
| `SOFT_TREND` | מגמה חלשה | ❌ חסום (Spot רק עם סף מוגבר) |

**מדדים מרכזיים:**
- **ADX** — עוצמת מגמה (מעל 25 = מגמה)
- **ATR%** — תנודתיות יחסית
- **Supertrend** — כיוון מגמה

**משטרים מיוחדים:**
- **TRANSITIONAL:** Futures חסום, Spot רק אם Setup+Entry חזקים + ATR percentile < 80
- **SOFT_TREND:** Futures חסום, Spot רק אם Setup+Entry חזקים + ATR percentile < 70

---

### GATE 5: VOLATILITY — בדיקת תנודתיות

```typescript
// EXTREME volatility — Futures חסום, Spot רק במסלול מחמיר
if (regime.volatility === 'EXTREME' && !regime.futuresAllowed) → מסלול מחמיר

// במסלול מחמיר — דורש Setup ו-Entry חזקים
if (strictMode && (!setup.strong || !entry.strong)) → BLOCK
```

**רמות תנודתיות:**
| רמה | תיאור |
|-----|-------|
| `LOW` | תנודה נמוכה — כל האסטרטגיות מותרות |
| `NORMAL` | תנודה רגילה — כל האסטרטגיות מותרות |
| `HIGH` | תנודה גבוהה — Futures עם מגבלות |
| `EXTREME` | תנודה קיצונית — רק Spot, מסלול מחמיר |

---

### LAYER 1: 15M SETUP — זיהוי Setup

**מקור:** `src/services/intradaySetup.ts`

**סוגי Setup אפשריים:**
| Setup | תיאור |
|-------|-------|
| `TREND_PULLBACK` | משיכה לאחור במגמה |
| `MEAN_REVERSION` | חזרה לממוצע |
| `BREAKOUT` | פריצה מטווח |
| `NONE` | אין Setup |

**ציונים:**
- `setupScore` — ציון Setup (0-100)
- `strong` — האם Setup חזק (מעל סף מינימלי)

---

### LAYER 2: 5M ENTRY — אישור כניסה

**מקור:** `src/services/intradayEntry.ts`

**תנאי כניסה:**
- `confirmed` — האם הכניסה מאושרת
- `entryScore` — ציון כניסה (0-100)
- `strong` — האם כניסה חזקה
- `entryPrice` — מחיר כניסה מומלץ
- `stopReference` — רפרנס ל-Stop Loss
- `targetReference` — רפרנס ל-Take Profit

---

### TRADE TYPE ROUTING — ניתוב סוג עסקה

```typescript
if (setup.spotOnly) → SPOT
else if (regime.futuresAllowed) → FUTURES
else if (allowShortDuringHighVolatility && trending && HIGH && SHORT) → FUTURES
else → SPOT

// EXTREME volatility — תמיד SPOT
if (regime.volatility === 'EXTREME') → SPOT
```

---

### GATE 6/7: LIQUIDITY + SPREAD — נזילות פרשנות

```typescript
// נזילות מינימלית (תלוי בסוג עסקה)
const quoteVolume = tradeType === 'SPOT' ? quoteVolume24hSpot : quoteVolume24h;
if (quoteVolume < minQuoteVolume24h) → BLOCK

// Spread מקסימלי
if (spreadPercent > maxSpreadPercent) → BLOCK
```

**ערכי ברירת מחדל:**
- `minQuoteVolume24h` — 100,000$ (SPOT), 500,000$ (FUTURES)
- `maxSpreadPercent` — 0.5%

---

### COST / EDGE — ניתוח עלות לעומת רווח

**מקור:** `src/services/intradayRisk.ts` → `evaluateCostEdge()`

**חישוב:**
```typescript
edgeRatio = (TP1 - entry) / (entry - SL)
netRewardRisk = edgeRatio - costPercent
```

**תנאי אישור:**
- `edgeRatio >= 2.0` (רווח כפול לפחות מהסיכון)
- `netRewardRisk >= 1.5` (אחרי הפחתת עלויות)

---

### LAYER 3: RISK PLAN — תכנון סיכון

**מקור:** `src/services/intradayRisk.ts` → `buildRiskPlan()`

**פרמטרים:**
| פרמטר | תיאור |
|-------|-------|
| `stopLoss` | מחיר Stop Loss |
| `takeProfit1` | מחיר Take Profit ראשון |
| `leverage` | מינוף (1x-5x) |
| `quantity` | כמות |
| `riskPercentUsed` | אחוז סיכון מהתיק |

**מגבלות:**
- `riskPerTradePercent` — 2% מהתיק לסיכון מקסימלי
- `maxLeverage` — 5x מקסימלי
- `minOrderValue` — 5$ מינימום לפקודה

---

## 4. חישוב Confidence

**מקור:** `src/services/intradayBridge.ts` → `mapDecisionToSignalEvaluation()`

```typescript
const confidence = d.entry
  ? Math.round(((d.setup?.setupScore ?? 0) + d.entry.entryScore) / 2)
  : d.setup
  ? Math.round(d.setup.setupScore)
  : 0;
```

**הסבר:**
- אם יש **entry מאושר:** ממוצע של `setupScore` ו-`entryScore`
- אם יש רק **setup:** `setupScore` בלבד
- אם אין גם setup: **0**

**סינון בסימולציה:**
```typescript
// simExecution.ts — Confidence floor
const minConf = config.minConfidenceOverride ?? 52;
if (ev.confidence < minConf) → BLOCK
```

**סף מינימלי:** 52 (ניתן לשינוי דרך ה-UI)

---

## 5. שערול נוספים בסימולציה

### Streak Cooldown — השהיה אחרי הפסדים (לפי מטבע)

```typescript
// אחרי 2 הפסדים רצופים על אותו מטבע — השהיה של 30 דקות
// הפוגה מבוטלת אם ההפסד היה > 5% מסך השווי התיק
const symbolStreakCooldownUntil = streakCooldownFromHistory(closedTrades, equity, symbol);
if (isInStreakCooldown(symbolStreakCooldownUntil)) → BLOCK
```

**תנאים:**
- הפוגה פועלת רק על המטבע שהפסיד (לא על כל המטבעות)
- הפוגה מבוטלת אם ההפסד היה גדול מ-5% מסך השווי התיק

### Adaptive Sizing Multiplier — הקטנת גודל לפי ביצועים

מקור: src/services/adaptiveRisk.ts

streakFactor:   רצף 2 הפסדים → ×0.75, רצף 3 → ×0.5, רצף 5+ → ×0.25
drawdownFactor: ליניארי מ-1.0 (drawdown=0%) עד 0.25 (drawdown=11.25%), רצפה שם
winRateFactor:  ±10% לפי win-rate (רק מעל 10 עסקאות בחלון)

**שונה משני הבוטים האחרים:** אצל Intraday ה-streakFactor לא נחסם ב-1 — רצף ניצחונות (3+/5+) מגדיל את risk-per-trade עד פי 1.25/1.5, בעוד רצף הפסדים מקטין אותו (כמו בשני הבוטים האחרים).

multiplier = streakFactor × drawdownFactor × winRateFactor

התוצאה הסופית (baseRiskPercent × multiplier) מוגבלת ל-0.05%-2% — לא ה-multiplier עצמו ל-0.2–1.0.

מוכפל ב-riskPerTradePercent הבסיסי, מוגבל לטווח 0.05%-2%, דרך adaptiveRiskPercentFromHistory.

### Correlation Gate — מניעת קורלציה

```typescript
// מקסימום 12 פוזיציות מקורלציות
if (correlatedPositions >= maxCorrelated) → BLOCK
```

### Same-Asset Dedup — מניעת כפילות

```typescript
// אין כניסה חוזרת לאותו נכס (Spot או Futures)
if (isHeld) → BLOCK
```

---

## 6. זרימת ביצוע סימולציה

### מחזור ראשי (Tick)

```
1. Refresh Market Data (כל 60 שניות)
   ├── getAggregatedPrices() — מחירי שוק
   └── getUniverseMarketData() — נרות MTF

2. Build Evaluations
   └── buildEvaluations() — החלטה לכל סימבול

3. Generate Orders
   └── generateNewOrders() — יצירת פקודות

4. Fill Due Orders
   └── fillDueOrders() — ביצוע פקודות שהגיעו זמנן

5. Update State
   └── עדכון מצב, היסטוריה, וכו'
```

### ביצוע פקודות (Fill)

```typescript
// עיכוב ביצוע (executionDelaySec)
const delayMs = executionDelaySec * 1000;

// סליפג' (slippagePercent)
const fillPrice = order.signalPrice * (1 + slippagePercent / 100);

// עמלה (feePercent)
const fee = notional * feePercent / 100;
```

**ערכי ברירת מחדל:**
| פרמטר | ערך |
|-------|-----|
| `executionDelaySec` | 3 |
| `slippagePercent` | 0.05% |
| `feePercent` | 0.1% |

---

## 7. יציאה מפוזיציה (Exit)

**מקור:** `src/services/intradayBridge.ts` → `evaluatePositionExit()`

**סוגי יציאה:**
| סוג | תנאי |
|-----|------|
| `FULL` | Stop Loss או Take Profit |
| `PARTIAL_50` | 50% סגירה ב-TP1 |
| `TRAILING` | עקיבת סטופ |
| `REVERSAL` | היפוך אותות |
| `TIME_STOP` | סגירה לפי זמן |

---

## 8. קונפיגורציה

**מקור:** `src/services/intradayParams.ts` — `DEFAULT_INTRADAY_PARAMS`

**התאמות סימולציה מיוחדות** (`SIM_INTRADAY_PARAMS_OVERRIDE`):
```typescript
{
  allowShortDuringHighVolatility: true,  // מותר למכור ב-HIGH volatility
  meanReversionMinStopAtrMult: 1.6,      // מינימום SL ל-Mean Reversion
  meanReversionMinStopPercent: 0.25,     // מינימום SL באחוזים
  meanReversionCloseConfirmStop: true    // אישור סגירה
}
```

---

## 9. סיכום שדות SignalEvaluation

| שדה | תיאור |
|-----|-------|
| `symbol` | סימבול |
| `action` | `buy` / `sell` / `hold` |
| `tradeType` | `SPOT` / `FUTURES` / `HOLD` |
| `tradeSide` | `LONG` / `SHORT` / `BUY` / `SELL` / `NONE` |
| `confidence` | ציון ביטחון (0-100) |
| `price` | מחיר כניסה |
| `priceChange24h` | שינוי 24 שעות |
| `reasoning` | הסבר ההחלטה |
| `status` | סטטוס (מוכן/חסום) |
| `willExecute` | האם יבוצע |
| `factors` | גורמי החלטה |
| `regime` | משטר שוק |
| `leverage` | מינוף |
| `stopLoss` | Stop Loss |
| `takeProfit1` | Take Profit ראשון |
