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
| `src/services/intradaySetup.ts` | זיהוי Setup (Layer 1) — TREND_PULLBACK, BREAKOUT_RETEST, MEAN_REVERSION |
| `src/services/intradayEntry.ts` | אישור כניסה (Layer 2) |
| `src/services/intradayRisk.ts` | Cost/Edge + תכנון סיכון (Layer 3) |
| `src/services/intradayExit.ts` | לוגיקת יציאה מפוזיציה |
| `src/services/intradayBridge.ts` | גשר בין סימולציה ל-intradayEngine + מיפוי ל-SignalEvaluation |
| `src/services/intradayParams.ts` | פרמטרים מרכזיים (DEFAULT_INTRADAY_PARAMS) |
| `src/services/simExecution.ts` | לוגיקת ביצוע סימולציה (משותף) |
| `src/services/adaptiveRisk.ts` | סיכון אדפטיבי + streak cooldown |
| `src/services/correlation.ts` | מניעת קורלציה (Pearson log-returns) |
| `server/simEngine.ts` | adapter למנוע סימולציה 24/7 בשרת |
| `server/simEngineFactory.ts` | tick loop, hydrate, persist, getSnapshot משותף |

---

## 2. שלבי ההחלטה (Gate Order)

האלגוריתם עובר דרך שלבים סדרתיים — **השערול הראשון שנכשל עוצר את התהליך**:

```
NO_DATA → CIRCUIT_BREAKER → EXPOSURE → (1H REGIME) → (15M SETUP) → (5M ENTRY) →
TRADE TYPE ROUTING → LIQUIDITY → SPREAD → (EXTREME strict bar) → COST → RISK
```

**הערה:** אין שערול NO_REGIME נפרד. TRANSITIONAL/SOFT_TREND לא חוסמים את התהליך לחלוטין — הם מגדירים אילו סוגי עסקאות מותרים ואילו ספים נדרשים, ומופעלים כחלק מ-trade type routing.

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
if (p.dailyDrawdownPercent >= params.dailyDrawdownBlockPercent) → BLOCK

// Drawdown שבועי >= 15% — נעילה
if (p.weeklyDrawdownPercent >= params.weeklyDrawdownLockPercent) → BLOCK
```

---

### GATE 3: EXPOSURE — מגבלת חשיפה

```typescript
// מקסימום פוזיציות פתוחות
if (p.openPositionsCount >= params.maxOpenPositions) → BLOCK

// נכס כבר פתוח (אין כפילות Spot/Futures)
const sameAsset = input.openPositions.find((o) => o.symbol === symbol);
if (sameAsset) → BLOCK
```

**מקסימום פוזיציות:**
```typescript
maxPositions = 7
maxFutures = 2
```

---

### LAYER A: 1H REGIME — זיהוי משטר שוק

**מקור:** `src/services/intradayRegime.ts` → `detectRegime1H()`

**תוצאות אפשריות:**
| Regime | תיאור | Futures |
|--------|-------|---------|
| `BULL_TREND` | מגמה עולה | ✅ מותר |
| `BEAR_TREND` | מגמה יורדת | ✅ מותר |
| `RANGING` | טווח (דשדוש) | ❌ חסום |
| `TRANSITIONAL` | מעבר בין משטרים | ❌ Futures חסום, Spot איכותי מותר |
| `SOFT_TREND` | מגמה חלשה | ❌ Futures חסום, Spot איכותי מותר |

**מדדים מרכזיים:**
- **ADX** — עוצמת מגמה (מעל 25 = מגמה)
- **ATR%** — תנודתיות יחסית
- **Supertrend** — כיוון מגמה
- **ATR Percentile** — מיקום התנודתיות בהיסטוריה (LOW/NORMAL/HIGH/EXTREME)

**רמות תנודתיות:**
| רמה | תנאי ATR percentile | השפעה |
|-----|---------------------|-------|
| `LOW` | < 30 | כל האסטרטגיות מותרות |
| `NORMAL` | 30-80 | כל האסטרטגיות מותרות |
| `HIGH` | 80-95 | Futures חסום, Spot מותר |
| `EXTREME` | >= 95 | Futures חסום, Spot במסלול מחמיר |

**משטרים מיוחדים:**
- **TRANSITIONAL:** Futures חסום, Spot רק אם Setup+Entry חזקים + ATR percentile < 80
- **SOFT_TREND:** Futures חסום, Spot רק אם Setup+Entry חזקים + ATR percentile < 70

---

### LAYER B: 15M SETUP — זיהוי Setup

**מקור:** `src/services/intradaySetup.ts` → `detectSetup15M()`

**סוגי Setup אפשריים:**
| Setup | תיאור |
|-------|-------|
| `TREND_PULLBACK` | משיכה לאחור במגמה |
| `BREAKOUT_RETEST` | פריצה מטווח + אישור retest |
| `MEAN_REVERSION` | חזרה לממוצע |
| `NONE` | אין Setup |

**ציונים:**
- `setupScore` — ציון Setup (0-100)
- `strong` — האם Setup חזק (מעל סף מינימלי)
- `candidateCount` — כמה חלופות זוהו
- `blockers` — רשימת סיבות לחסימה

---

### LAYER C: 5M ENTRY — אישור כניסה

**מקור:** `src/services/intradayEntry.ts` → `confirmEntry5M()`

**תנאי כניסה:**
- `confirmed` — האם הכניסה מאושרת
- `entryScore` — ציון כניסה (0-100)
- `strong` — האם כניסה חזקה
- `entryPrice` — מחיר כניסה מומלץ
- `stopReference` — רפרנס ל-Stop Loss
- `targetReference` — רפרנס ל-Take Profit
- `trigger` — סוג טריגר (PULLBACK_HOLD, BREAKOUT_RETEST, REVERSAL_RECOVERY)

**High-Confidence Bypass:**
```typescript
// אם confidence >= 72, NO_ENTRY ו-COST נדרסים
if (!entry.confirmed && confidence >= 72) → BYPASS (entry = confirmed)
if (!cost.approved && confidence >= 72) → BYPASS (cost = approved)
```

---

### TRADE TYPE ROUTING — ניתוב סוג עסקה

```typescript
if (setup.spotOnly) → SPOT
else if (regime.futuresAllowed) → FUTURES
else → SPOT

// EXTREME volatility — תמיד SPOT
if (regime.volatility === 'EXTREME') → SPOT
```

**TRANSITIONAL / SOFT_TREND quality gate:**
```typescript
if (transitional || softTrend) {
  tradeType = 'SPOT';
  const atrOk = !regime.strictMode && (regime.atrPercentile ?? 50) < (isSoftTrend ? 70 : 80);
  const highQuality = setup.strong && entry.strong && atrOk;
  if (!highQuality) → BLOCK
}
```

---

### GATE 6/7: LIQUIDITY + SPREAD — נזילות פרשנות

```typescript
// נזילות מינימלית (תלוי בסוג עסקה)
const quoteVolume = tradeType === 'SPOT' ? quoteVolume24hSpot : quoteVolume24h;
if (quoteVolume > 0 && quoteVolume < params.minQuoteVolume24h) → BLOCK

// Spread מקסימלי
if (spreadPercent > params.maxSpreadPercent) → BLOCK
```

**ערכי ברירת מחדל:**
- `minQuoteVolume24h` — 1,000,000$ (SPOT ו-FUTURES)
- `maxSpreadPercent` — 0.12%

---

### GATE 5b: EXTREME Volatility Strict Bar

```typescript
// במסלול מחמיר (EXTREME volatility) — דורש Setup ו-Entry חזקים
if (strictMode && (!setup.strong || !entry.strong)) → BLOCK
```

---

### COST / EDGE — ניתוח עלות לעומת רווח

**מקור:** `src/services/intradayRisk.ts` → `evaluateCostEdge()`

**חישוב:**
```typescript
edgeRatio = (TP1 - entry) / (entry - SL)
netRewardRisk = edgeRatio - costPercent
```

**תנאי אישור:**
- `edgeRatio >= 1.2` (רווח כפול לפחות מהסיכון)
- `netRewardRisk >= costSafetyMultiplier` (אחרי הפחתת עלויות)

**High-Confidence Bypass:**
```typescript
if (!cost.approved && confidence >= 72) → BYPASS
```

---

### LAYER D: RISK PLAN — תכנון סיכון

**מקור:** `src/services/intradayRisk.ts` → `buildRiskPlan()`

**פרמטרים:**
| פרמטר | תיאור |
|-------|-------|
| `stopLoss` | מחיר Stop Loss |
| `takeProfit1` | Take Profit ראשון |
| `takeProfit2` | Take Profit שני |
| `leverage` | מינוף (1x-5x) |
| `quantity` | כמות |
| `riskPercentUsed` | אחוז סיכון מהתיק |

**מגבלות:**
- `riskPerTradePercent` — 0.5% מהתיק לסיכון מקסימלי
- `maxRiskPerTradePercent` — 0.75% מהתיק
- `maxLeverage` — 5x מקסימלי
- `minOrderUsd` — 5$ מינימום לפקודה

**High-Confidence Fallback:**
```typescript
// אם buildRiskPlan דחה אבל confidence >= 72 — fallback עם SL 1.8% / TP 3%
if (!risk.approved && confidence >= 72) → buildFallbackIntradayRisk()
```

---

## 4. יציאה מפוזיציה (Exit)

**מקור:** `src/services/intradayExit.ts` → `evaluateIntradayExit()`

**גשר:** `src/services/intradayBridge.ts` → `evaluatePositionExit()` + `buildExitView()`

**סוגי יציאה:**
| סוג | תנאי |
|-----|------|
| `FULL` | Stop Loss או Take Profit |
| `PARTIAL_50` | 50% סגירה ב-TP1 |
| `TRAILING` | עקיבת סטופ |
| `REVERSAL` | היפוך אותות |
| `TIME_STOP` | סגירה לפי זמן |

**זמני החזקה מקסימליים (לפי Setup):**
| Setup | מקסימום זמן | הרחבה |
|-------|-------------|--------|
| `TREND_PULLBACK` | 120 דקות | ×1.5 אם התקדמות >= 0.5R |
| `BREAKOUT_RETEST` | 60 דקות | ×1.5 אם התקדמות >= 0.5R |
| `MEAN_REVERSION` | 45 דקות | ללא הרחבה |

**Trailing Stop:**
| Setup | הפעלה ב-R | ATR multiplier |
|-------|-----------|----------------|
| `TREND_PULLBACK` | 0.8R | 1.2x |
| `BREAKOUT_RETEST` | 1.0R | 1.2x |
| `MEAN_REVERSION` | 1.5R | 1.2x |

---

## 5. חישוב Confidence

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

## 6. שערול נוספים בסימולציה

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

מקור: `src/services/adaptiveRisk.ts`

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
// סף קורלציה: 0.7 (Pearson על log-returns)
// חלון זיהוי: 72 נרות H1
if (correlatedPositions >= maxCorrelated) → BLOCK
```

**כיוון חשוב:** LONG מול SHORT עם קורלציה גבוהה נחשב כ-spread (לא כקונצנטרציה) — ה-effective correlation נחלת לפי כיוון.

### Same-Asset Dedup — מניעת כפילות

```typescript
// אין כניסה חוזרת לאותו נכס (Spot או Futures)
if (isHeld) → BLOCK
```

### Per-Asset Exposure Cap

```typescript
// הגבלת חשיפה מקסימלית לנכס בודד
if (existingExposureByAsset[symbol] > maxExposurePerAsset) → BLOCK
```

---

## 7. זרימת ביצוע סימולציה

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

**realism פרמטרים:**
| פרמטר | ערך | תיאור |
|-------|-----|-------|
| `limitOrderTtlMinutes` | 10 | תוקף פקודת Limit |
| `touchFillProbability` | 0.5 | הסתברות מילוי במגע |
| `partialFillRatio` | 0.5 | יחס מילוי חלקי |

---

## 8. קונפיגורציה

**מקור:** `src/services/intradayParams.ts` — `DEFAULT_INTRADAY_PARAMS`

**התאמות סימולציה מיוחדות** (`SIM_INTRADAY_PARAMS_OVERRIDE` ב-`simExecution.ts`):
```typescript
{
  allowShortDuringHighVolatility: true,  // מותר למכור ב-HIGH volatility
  meanReversionMinStopAtrMult: 1.6,      // מינימום SL ל-Mean Reversion
  meanReversionMinStopPercent: 0.25,     // מינימום SL באחוזים
  meanReversionCloseConfirmStop: true    // אישור סגירה על נר סגור
}
```

**ערכי ברירת מחדל עיקריים:**
| פרמטר | ערך |
|-------|-----|
| `initialAmount` | 10,000$ |
| `stopLoss` | 4.2% |
| `takeProfit` | 3% |
| `maxPositions` | 7 |
| `maxFuturesPositions` | 2 |
| `feePercent` | 0.1% |
| `slippagePercent` | 0.05% |
| `executionDelaySec` | 3 |
| `minConfidenceOverride` | 52 |
| `positionPercent` | 10% |
| `dailyDrawdownBlockPercent` | 8% |
| `weeklyDrawdownLockPercent` | 15% |
| `weeklyDrawdownFlattenPercent` | 15% |

---

## 9. Telemetry

### Funnel Telemetry

כל `IntradayDecision` מכיל אובייקט `funnel` שמתעד את התקדמות האותות דרך השערולים:

```typescript
funnel: {
  evaluated: true,
  regimePassed: boolean,
  setupCandidates: number,
  entryCandidates: number,
  costBlocked: boolean,
  riskBlocked: boolean,
  approved: boolean,
  executed: boolean
}
```

### Decision Logs

כל החלטה מכילה `logs: string[]` עם שורות עברית שמתעדות כל שערול:

```
[SYMBOL] 1H=BULL_TREND bias=BULL ADX=32.5 ATR%=1.23 vol=NORMAL futuresAllowed=true
[SYMBOL] 15M=TREND_PULLBACK dir=LONG SetupScore=78 (strong=true)
[SYMBOL] 5M=PULLBACK_HOLD EntryScore=82 price=1234.56
[SYMBOL] COST OK — R:R נטו 2.34 | edge 3.12
[SYMBOL] SIGNAL FUTURES LONG TREND_PULLBACK | SL=1210.00 TP1=1250.00 lev=3x risk=0.75% qty=0.1234
```

---

## 10. סיכום שדות SignalEvaluation

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
| `takeProfit2` | Take Profit שני |
| `decision` | IntradayDecision גולמי (לשימוש פנימי) |

---

## 11. הבדלים מהבוטים האחרים

| תכונה | חדש (MTF) | Legacy | Pro |
|-------|-----------|--------|-----|
| מקור אותות | intradayEngine.ts (MTF) | tradeEngine.ts (drifted) | proAdvancedAnalysis.ts (האתר) |
| פריימים זמן | 1H + 15M + 5M | H1 בלבד | H1 בלבד |
| SPOT threshold | 52 (סטטי) | 58 (סטטי) | 60 (דינמי לפי ATR%) |
| FUTURES threshold | 52 (סטטי) | 70 (סטטי) | 72 (דינמי לפי ATR%) |
| Daily circuit breaker | 8% | 8% | 8% |
| Weekly circuit breaker | 15% | 15% | 15% |
| Time exit | TREND_PULLBACK: 120ד', BREAKOUT_RETEST: 60ד', MEAN_REVERSION: 45ד' | 48 שעות (Spot) | 24 שעות + הרחבה ל-36 שעות |
| Position sizing | risk-first (0.5% equity / stop distance) | Kelly (6%) | Kelly ישיר (6%) |
| Entry timing | 5M confirmation (confirmEntry5M) | calculateOptimalEntry | calculateProOptimalEntry |
| Cost/Edge gate | כן (evaluateCostEdge) | לא (MIN_RISK_REWARD_RATIO בלבד) | לא (MIN_RISK_REWARD_RATIO בלבד) |
| Correlation gate | כן (Pearson log-returns) | כן | כן |
| Streak cooldown | לפי מטבע | לפי מטבע | לפי מטבע |
| High-confidence bypass | 72 (NO_ENTRY + COST) | 72 (Layer 3) | 72 (Layer 3) |
