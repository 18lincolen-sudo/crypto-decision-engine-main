# ALG_legacy.md — אלגוריתם בוט סימולציה מקורי (Legacy)

> מסמך זה מתאר בפירוט את אלגוריתם ההחלטה של בוט הסימולציה המקורי, כולל כל השלבים, השערולים, והחישובים.

---

## 1. סקירה כללית

הבוט המקורי משתמש באלגוריתם **ציון ביטחון משוקלל** המבוסס על ניתוח טכני קלאסי בפריים אחד (H1). האלגוריתם מחשב ציון ביטחון (SignalScore) עבור כל סימבול ומחליט אם להיכנס לפוזיציה בהתאם לתנאים.

**מקורות מידע:**
- **Bybit** — נתוני שוק (candles, ticker, instruments-info) עם גיבוי מ-Binance
- **CoinGecko** — נתוני ניתוח
- **Alternative.me** — מדד פחד וחמדנות (Fear & Greed Index)

**קבצים מרכזיים:**
| קובץ | תפקיד |
|------|-------|
| `src/services/tradeEngine.ts` | מנוע מסחר בסיסי — אינדיקטורים, detectMarketRegime, evaluateSignals, routeTradeType, calculateRiskParameters, evaluateExit |
| `src/services/legacySimExecution.ts` | לוגיקת ביצוע סימולציה Legacy — buildLegacyEvaluations, generateLegacyOrders |
| `src/services/adaptiveRisk.ts` | סיכון אדפטיבי + streak cooldown (משותף) |
| `src/services/correlation.ts` | מניעת קורלציה (משותף) |
| `src/services/simExecution.ts` | ביצוע פקודות משותף (fillDueOrders) |
| `server/legacySimEngine.ts` | adapter למנוע סימולציה 24/7 בשרת |
| `server/simEngineFactory.ts` | tick loop, hydrate, persist, getSnapshot משותף |

---

## 2. שלבי ההחלטה (Layer Order)

האלגוריתם מחולק ל-4 שלבים עיקריים:

```
Layer 0: Market Regime Detection (זיהוי משטר שוק)
    ↓
Layer 1: Signal Scoring (חישוב ציון ביטחון)
    ↓
Layer 2: Trade Routing (ניתוב סוג עסקה)
    ↓
Layer 3: Risk Management (ניהול סיכונים)
```

**שערולים נוספים (בסדר ביצוע):**
```
CIRCUIT_BREAKER → EXPOSURE → (Layer 0-3) → Entry Timing → Correlation Gate → Cost/Edge → Confidence Floor → Streak Cooldown → Budget Floor
```

---

## 3. פירוט השלבים

### LAYER 0: Market Regime Detection — זיהוי משטר שוק

**מקור:** `src/services/tradeEngine.ts` → `detectMarketRegime()`

**מדדים מרכזיים:**
| מדד | תיאור |
|-----|-------|
| **ADX** | עוצמת מגמה (מעל 25 = מגמה חזקה) |
| **ATR%** | תנודתיות יחסית |
| **Supertrend** | כיוון מגמה (BULL/BEAR) |
| **RSI** | מדד כוח יחסי |

**תוצאות אפשריות:**
| Regime | תיאור | תנאי |
|--------|-------|------|
| `TRENDING` | מגמה ברורה | ADX > 25 |
| `RANGING` | טווח (דשדוש) | ADX < 20 |
| `TRANSITIONAL` | מעבר בין משטרים | 20 <= ADX <= 25 |

**רמות תנודתיות:**
| רמה | תנאי ATR% |
|-----|-----------|
| `LOW` | < 2% |
| `NORMAL` | 2% - 5% |
| `HIGH` | > 5% |

---

### LAYER 1: Signal Scoring — חישוב ציון ביטחון

**מקור:** `src/services/tradeEngine.ts` → `evaluateSignals()`

**אינדיקטורים ומשקלות:**
| אינדיקטור | משקל | תנאי BUY | תנאי SELL |
|-----------|------|----------|-----------|
| **RSI(14)** | 10 | < 30 (מכירת יתר) | > 70 (קניית יתר) |
| **MACD** | 12 | MACD > Signal | MACD < Signal |
| **EMA Cross** | 10 | EMA9 > EMA21 | EMA9 < EMA21 |
| **Bollinger Bands** | 8 | מחיר מתחת לתחתית | מחיר מעל לעליון |
| **Volume Surge** | 8 | נפח גבוה מממוצע | - |
| **Supertrend** | 10 | כיוון BULL | כיוון BEAR |
| **Stochastic(14/3)** | 8 | K < 20 && D < 25 | K > 80 && D > 75 |

**חישוב SignalScore:**
```
SignalScore = Σ(weight × strength)
```

**דוגמה:**
- RSI BUY (weight=10, strength=0.8) → 8 נקודות
- MACD BUY (weight=12, strength=0.7) → 8.4 נקודות
- EMA Cross BUY (weight=10, strength=0.9) → 9 נקודות
- **סה"כ BUY:** 25.4

**קנסות (Penalties):**
| קנס | תנאי | השפעה |
|-----|------|-------|
| חוסר נפח | Volume Surge NEUTRAL | Confidence × 0.6 |
| שוק דשדוש | ADX < 20 (RANGING) | Confidence × 0.7 |

**חישוב Confidence:**
```typescript
let confidence = signalScore;
if (volumeSignal === 'NEUTRAL') confidence *= 0.6;
if (regime === 'RANGING') confidence *= 0.7;
```

---

### LAYER 2: Trade Routing — ניתוב סוג עסקה

**מקור:** `src/services/tradeEngine.ts` → `routeTradeType()`

**שערול קשיחים (Hard Gates):**
| # | שערול | תנאי |
|---|-------|------|
| 1 | Weekly Drawdown Lock | הפסד שבועי >= 15% |
| 2 | Daily Drawdown Block | הפסד יומי >= 8% |
| 3 | Transitional Regime | 20 <= ADX <= 25 (ללא SOFT_TREND) |
| 4 | Same-Asset Exposure | כבר פתוח Spot או Futures על נכס זה |
| 5 | High Volatility Futures | ATR% > 5% |

**ניתוב Futures (כל התנאים חובה):**
| תנאי | ערך |
|------|-----|
| Regime | TRENDING (ADX > 25) |
| Volatility | LOW או NORMAL (ATR% <= 5%) |
| SignalScore | >= 70 (סף סטטי) |
| Same-Asset | ללא פוזיציית Futures קיימת |

**ניתוב Spot:**
| תנאי | ערך |
|------|-----|
| Regime | TRENDING, RANGING, או SOFT_TREND |
| SignalScore | >= 60 (סף סטטי, 65 ב-SOFT_TREND) |

**סף ביטחון סטטי:**
```typescript
// הסף קבוע — לא משתנה לפי ATR%
function dynamicConfidenceThreshold(baseThreshold, atrPercent) {
  return baseThreshold; // סף סטטי ללא דינמיות
}
```

| סוג עסקה | סף מינימלי |
|----------|-----------|
| Futures | 70 |
| Spot | 60 (65 ב-SOFT_TREND) |

---

### LAYER 3: Risk Management — ניהול סיכונים

**מקור:** `src/services/tradeEngine.ts` → `calculateRiskParameters()`

**פרמטרים:**
| פרמטר | תיאור |
|-------|-------|
| `stopLoss` | מחיר Stop Loss |
| `takeProfit1` | Take Profit ראשון |
| `takeProfit2` | Take Profit שני |
| `leverage` | מינוף (1x-5x) |
| `betSizeUsd` | גודל התערבוב בדולרים |
| `riskRewardRatio` | יחס סיכון-רווח |
| `kellyFraction` | שביר Kelly לחישוב גודל |

**חישוב גודל פוזיציה (Kelly Criterion):**
```typescript
// עם 30+ עסקאות סגורות
kellyFraction = winRate - (1 - winRate) / R
betFraction = clamp(kellyFraction × 0.5, 0, 0.10)

// ללא 30 עסקאות — ברירת מחדל
betFraction = 0.06 (6%)
```

הערה: זהה לנוסחת Pro — Legacy התיישר איתה, לא נוסחת half-Kelly ישנה יותר.

**מגבלות:**
| פרמטר | מקסימום |
|-------|---------|
| `leverage` | 5x |
| `riskPerTrade` | 2% מהתיק |
| `kellyFraction` | 10% מהתיק |

**מינוף לפי תנודתיות:**
| תנודתיות | מינוף בסיסי | מינוף עם Confidence >= 80 |
|----------|------------|---------------------------|
| LOW | 5x | 5x |
| NORMAL | 3x | 4x |
| HIGH | חסום | חסום |

---

## 4. Entry Timing — תזמון כניסה

**מקור:** `src/services/tradeEngine.ts` → `calculateOptimalEntry()`

**מטרה:** מניעת רטיטות — כניסה רק אחרי pullback ל-EMA20.

**אינדיקטורים:**
| מדד | תיאור |
|-----|-------|
| **RSI(14)** | מדד כוח יחסי |
| **EMA20** | ממוצע עובר |
| **Bollinger Bands** | רצועות בולינג'ר |
| **ATR** | תנודתיות לחישוב pullback |
| **Relative Volume** | נפח יחסי (מינימום 0.6) |

**לוגיקת החלטה:**
```typescript
if (action === 'BUY') {
  // אם מחיר מורחק מעל EMA20 — ממתין לירידה
  if (currentPrice > ema20 + atr * 1.5) → shouldEnter = false
  // אחרת — כניסה מיידית
  else → shouldEnter = true, entryPrice = currentPrice
}
else if (action === 'SELL') {
  // אם מחיר מורחק מתחת ל-EMA20 — ממתין לעלייה
  if (currentPrice < ema20 - atr * 1.5) → shouldEnter = false
  // אחרת — כניסה מיידית
  else → shouldEnter = true, entryPrice = currentPrice
}
```

---

## 5. חישוב Confidence

**מקור:** `src/services/legacySimExecution.ts`

```typescript
// חישוב confidence מ-Layer 1
confidence = layer1.confidence; // כבר כולל קנסות

// High-confidence bypass: אם confidence >= 72, Layer 3 blocks נדרסים
const effectiveLayer3 = layer3 ?? (confidence >= HIGH_CONFIDENCE_BYPASS
  ? buildFallbackLegacyRisk(entryPrice, layer2.side, confidence)
  : null);
```

**סינון בסימולציה:**
```typescript
// legacySimExecution.ts — Confidence floor
const minConf = config.minConfidenceOverride ?? 58;
if (layer1.confidence < minConf) → BLOCK
```

**סף מינימלי:** 58 (ניתן לשינוי דרך ה-UI)

---

## 6. שערול נוספים בסימולציה

### Circuit Breakers

```typescript
const LEGACY_WEEKLY_DRAWDOWN_LOCK_PERCENT = 15;
const LEGACY_DAILY_DRAWDOWN_BLOCK_PERCENT = 8;
if (weeklyDrawdownPercent >= 15) → LOCK
if (dailyDrawdownPercent >= 8) → BLOCK
```

### Streak Cooldown — השהיה אחרי הפסדים (לפי מטבע)

```typescript
// אחרי 2 הפסדים רצופים על אותו מטבע — השהיה של 30 דקות
// הפוגה מבוטלת אם ההפסד היה > 5% מסך השווי התיק
const symbolStreakCooldownUntil = streakCooldownFromHistory(closedTradeMetrics, equity, symbol);
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

multiplier = streakFactor × drawdownFactor × winRateFactor, מוגבל ל-0.2–1.0

מוכפל ישירות ב-betFraction (Kelly) — יכול רק להקטין, לעולם לא להגדיל.

### Correlation Gate — מניעת קורלציה

```typescript
// מקסימום 12 פוזיציות מקורלציות
// סף קורלציה: 0.7 (Pearson על log-returns)
// חלון זיהוי: 72 נרות H1
if (correlatedPositions >= maxCorrelated) → BLOCK
```

### Same-Asset Dedup — מניעת כפילות

```typescript
// אין כניסה חוזרת לאותו נכס
if (isHeld) → BLOCK
```

### Cost / Edge Gate

```typescript
// יחס סיכון-רווח נמוך מדי
if (effectiveLayer3.riskRewardRatio < MIN_RISK_REWARD_RATIO) → BLOCK
```

### Budget Floor

```typescript
// תקציב נמוך מדי
const budget = computeEntryBudget(cash, tradeType);
if (budget < 5) → BLOCK
```

---

## 7. זרימת ביצוע סימולציה

### מחזור ראשי (Tick)

```
1. Refresh Market Data (כל 60 שניות)
    ├── getAggregatedPrices() — מחירי שוק
    └── getUniverseMarketData() — נרות H1

2. Build Evaluations
    └── buildLegacyEvaluations() — החלטה לכל סימבול
        ├── detectMarketRegime() (Layer 0)
        ├── evaluateSignals() (Layer 1)
        ├── routeTradeType() (Layer 2)
        ├── calculateOptimalEntry() (Entry Timing)
        ├── calculateRiskParameters() (Layer 3)
        ├── Correlation Gate
        ├── Cost/Edge Gate
        ├── Confidence Floor
        └── Streak Cooldown

3. Generate Orders
    └── generateLegacyOrders() — יצירת פקודות
        ├── evaluateExit() — בדיקת יציאה מפוזיציות קיימות
        └── entries חדשים

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

## 8. יציאה מפוזיציה (Exit)

**מקור:** `src/services/tradeEngine.ts` → `evaluateExit()`

**סוגי יציאה:**
| סוג | תנאי |
|-----|------|
| `FULL` | Stop Loss או Take Profit |
| `PARTIAL_50` | 50% סגירה ב-TP1 |
| `TRAILING` | עקיבת סטופ |
| `REVERSAL` | היפוך אותות |
| `TIME_STOP` | סגירה לפי זמן — Spot לאחר 48 שעות |

**קנס זמן (Time Exit):**
```typescript
// Spot: סגירה מלאה לאחר 48 שעות
if (position.type === 'SPOT' && hoursHeld >= 48) → FULL (time exit)
```

---

## 9. קונפיגורציה

**ערכי ברירת מחדל:**
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
| `minConfidenceOverride` | 58 |
| `positionPercent` | 10% |

---

## 10. סיכום שדות SignalEvaluation

| שדה | תיאור |
|-----|-------|
| `symbol` | סימבול |
| `action` | `buy` / `sell` / `hold` |
| `tradeType` | `SPOT` / `FUTURES` / `HOLD` |
| `tradeSide` | `LONG` / `SHORT` / `BUY` / `SELL` / `NONE` |
| `confidence` | ציון ביטחון (0-100) |
| `price` | מחיר כניסה (Limit Order) |
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

---

## 11. הבדלים מהבוטים האחרים

| תכונה | Legacy | חדש (MTF) | Pro |
|-------|--------|-----------|-----|
| מקור אותות | tradeEngine.ts (סטה) | intradayEngine.ts (MTF) | proAdvancedAnalysis.ts (האתר) |
| פריימים זמן | H1 בלבד | 1H + 15M + 5M | H1 בלבד |
| SPOT threshold | 58 (סטטי) | 52 (סטטי) | 60 (דינמי לפי ATR%) |
| FUTURES threshold | 70 (סטטי) | 52 (סטטי) | 72 (דינמי לפי ATR%) |
| Daily circuit breaker | 8% | 8% | 8% |
| Weekly circuit breaker | 15% | 15% | 15% |
| Time exit | 48 שעות (Spot) | TREND_PULLBACK: 120ד', BREAKOUT_RETEST: 60ד', MEAN_REVERSION: 45ד' | 24 שעות + הרחבה ל-36 שעות |
| Position sizing | Kelly (6%) | risk-first (0.5% equity / stop distance) | Kelly ישיר (6%) |
| Entry timing | calculateOptimalEntry | confirmEntry5M | calculateProOptimalEntry |
| Cost/Edge gate | MIN_RISK_REWARD_RATIO | evaluateCostEdge | MIN_RISK_REWARD_RATIO |
| Correlation gate | כן | כן | כן |
| Streak cooldown | לפי מטבע | לפי מטבע | לפי מטבע |
| High-confidence bypass | 72 (Layer 3) | 72 (NO_ENTRY + COST) | 72 (Layer 3) |

---

## 12. תיקוני באגים

### תיקון: `MIN_ENTRY_RELATIVE_VOLUME` לא מוגדר

**קובץ:** `src/services/legacySimExecution.ts`

**בעיה:** המשתנה `MIN_ENTRY_RELATIVE_VOLUME` שייוצא מ-`src/services/tradeEngine.ts` נעשה שימוש ב-`legacySimExecution.ts` ללא ייבוא, גרם ל-`ReferenceError: MIN_ENTRY_RELATIVE_VOLUME is not defined` בזמן ריצה.

**תיקון:** נוסף הייבוא החסר:
```typescript
import { ..., MIN_ENTRY_RELATIVE_VOLUME } from './tradeEngine';
```
