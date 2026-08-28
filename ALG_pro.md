# ALG_pro.md — אלגוריתם בוט פרו (Bot Pro — alg.md)

> מסמך זה מתאר בפירוט את אלגוריתם ההחלטה של בוט פרו, כולל כל השלבים, השערולים, והחישובים. בוט זה הוא יישום מדויק של מפרט ASSETS/alg.md.

---

## 1. סקירה כללית

בוט פרו הוא יישום **מדויק ונאמן** של מפרט ASSETS/alg.md, ללא סטיות. האלגוריתם מחולק ל-5 שלבים (Layers) עם שערול קשיחים ברורים.

**מקורות מידע:**
- **Bybit** — נתוני שוק (candles, ticker, instruments-info) עם גיבוי מ-Binance
- **CoinGecko** — נתוני ניתוח
- **Alternative.me** — מדד פחד וחמדנות (Fear & Greed Index)

**קבצים מרכזיים:**
| קובץ | תפקיד |
|------|-------|
| `src/services/proAlgEngine.ts` | מנוע החלטות Pro (alg.md) |
| `src/services/proSimExecution.ts` | לוגיקת ביצוע סימולציה Pro |
| `server/proSimEngine.ts` | מנוע סימולציה 24/7 בשרת |

---

## 2. שלבי ההחלטה (Layer Order)

```
Layer 0: Market Regime Detection (זיהוי משטר שוק)
    ↓
Layer 1: Signal Engine (חישוב ציון ביטחון)
    ↓
Layer 1.5: Entry Timing (תזמון כניסה)
    ↓
Layer 2: Trade Routing (ניתוב סוג עסקה)
    ↓
Layer 3: Risk Management (ניהול סיכונים)
    ↓
Layer 4: Exit Logic (לוגיקת יציאה)
```

---

## 3. פירוט השלבים

### LAYER 0: Market Regime Detection — זיהוי משטר שוק

**מקור:** `src/services/proAlgEngine.ts` → `detectProRegime()`

**מדדים מרכזיים:**
| מדד | תיאור |
|-----|-------|
| **ADX(14)** | עוצמת מגמה |
| **ATR(14)** | תנודתיות |
| **Supertrend(10,3)** | כיוון מגמה |

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

**כיוון מגמה:**
| כיוון | תנאי |
|-------|------|
| `BULL` | מחיר >= Supertrend |
| `BEAR` | מחיר < Supertrend |
| `NEUTRAL` | Regime = RANGING |

---

### LAYER 1: Signal Engine — חישוב ציון ביטחון

**מקור:** `src/services/proAlgEngine.ts` → `evaluateProSignals()`

**אינדיקטורים ומשקלות (סה"כ 100):**
| אינדיקטור | משקל | תנאי BUY | תנאי SELL |
|-----------|------|----------|-----------|
| **MACD(12/26/9)** | 20 | MACD > Signal | MACD < Signal |
| **EMA 20/50** | 18 | EMA20 > EMA50 | EMA20 < EMA50 |
| **RSI(14)** | 12 | < 30 (מכירת יתר) | > 70 (קניית יתר) |
| **Bollinger Bands** | 12 | מחיר מתחת לתחתית | מחיר מעל לעליון |
| **Volume Surge** | 18 | נפח גבוה מממוצע | - |
| **Supertrend** | 12 | כיוון BULL | כיוון BEAR |
| **Stochastic(14/3)** | 8 | K < 20 && D < 25 | K > 80 && D > 75 |

**חישוב Scores:**
```
buyScore = Σ(weight × strength) עבור אותות BUY
sellScore = Σ(weight × strength) עבור אותות SELL
```

**החלת פעולה:**
```typescript
if (buyScore > sellScore) → action = BUY, rawConfidence = buyScore
else if (sellScore > buyScore) → action = SELL, rawConfidence = sellScore
else → action = HOLD, rawConfidence = max(buyScore, sellScore)
```

**קנסות (Penalties):**
| קנס | תנאי | השפעה |
|-----|------|-------|
| חוסר נפח | Volume Surge NEUTRAL | Confidence × 0.6 |
| שוק דשדוש | Regime = RANGING (ADX < 20) | Confidence × 0.7 |

**חישוב Confidence:**
```typescript
let confidence = rawConfidence;
if (volumeSignal === 'NEUTRAL') confidence *= 0.6;
if (regime === 'RANGING') confidence *= 0.7;
```

---

### LAYER 1.5: Entry Timing — תזמון כניסה

**מקור:** `src/services/proAlgEngine.ts` → `calculateProOptimalEntry()`

**מטרה:** מניעת רטיטות — כניסה רק אחרי pullback ל-EMA20.

**אינדיקטורים:**
| מדד | תיאור |
|-----|-------|
| **RSI(14)** | מדד כוח יחסי |
| **EMA20** | ממוצע עובר |
| **Bollinger Bands** | רצועות בולינג'ר |
| **ATR** | תנודתיות לחישוב pullback |

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

### LAYER 2: Trade Routing — ניתוב סוג עסקה

**מקור:** `src/services/proAlgEngine.ts` → `routeProTradeType()`

**שערול קשיחים (Hard Gates):**
| # | שערול | תנאי |
|---|-------|------|
| 1 | Weekly Drawdown Lock | הפסד שבועי >= 15% |
| 2 | Daily Drawdown Block | הפסד יומי >= 8% |
| 3 | Transitional Regime | 20 <= ADX <= 25 (ללא SOFT_TREND) |
| 4 | Same-Asset Futures | כבר פתוח Futures על נכס זה |

**ניתוב Futures (כל התנאים חובה):**
| תנאי | ערך |
|------|-----|
| Regime | TRENDING (ADX > 25) |
| Volatility | LOW או NORMAL (ATR% <= 5%) |
| rawConfidence | >= 70 (סף סטטי) |
| Same-Asset | ללא פוזיציית Futures קיימת |

**ניתוב Spot:**
| תנאי | ערך |
|------|-----|
| Regime | TRENDING, RANGING, או SOFT_TREND |
| rawConfidence | >= 60 (סף סטטי, 65 ב-SOFT_TREND) |

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

**מקור:** `src/services/proAlgEngine.ts` → `calculateProRisk()`

**מגבלות פורפוליו:**
| מגבלה | ערך |
|-------|-----|
| מקסימום פוזיציות | 7 |
| מקסימום Futures | 2 |

**חישוב Stop Loss / Take Profit:**
| סוג | SL | TP1 | TP2 |
|-----|----|----|-----|
| **SPOT** | entry - ATR × 1.8 | - | entry + ATR × 2.7 |
| **FUTURES LONG** | entry - ATR × 1.5 | entry + ATR × 2.0 | entry + ATR × 3.5 |
| **FUTURES SHORT** | entry + ATR × 1.5 | entry - ATR × 2.0 | entry - ATR × 3.5 |

**מינוף:**
| תנודתיות | מינוף בסיסי | מינוף עם Confidence >= 80 |
|----------|------------|---------------------------|
| LOW | 5x | 5x |
| NORMAL | 3x | 4x |
| HIGH | חסום | חסום |

**חישוב גודל פוזיציה (Kelly Criterion):**
```typescript
// עם 30+ עסקאות סגורות
kellyFraction = winRate - (1 - winRate) / R
betFraction = clamp(kellyFraction × 0.5, 0, 0.10)

// ללא 30 עסקאות — ברירת מחדל
betFraction = 0.06 (6%)

// התאמה אדפטיבית
betFraction *= adaptiveFactor (drawdown/streak/winRate)
```

---

### LAYER 4: Exit Logic — לוגיקת יציאה

**מקור:** `src/services/proAlgEngine.ts` → `evaluateProExit()`

**סוגי יציאה:**
| סוג | תנאי |
|-----|------|
| `FULL` | Stop Loss או Take Profit |
| `PARTIAL_50` | 50% סגירה ב-TP1 (24 שעות ללא TP1) |
| `TRAILING` | עקיבת סטופ |
| `REVERSAL` | היפוך אותות (confidence >= 65) |
| `TIME_STOP` | סגירה לפי זמן |

**קנס זמן (Time Exit):**
```typescript
// 24 שעות ללא TP1 — סגירה חלקית של 50%
if (hoursHeld >= 24 && !tp1Hit) → PARTIAL_50
```

**היפוך אותות:**
```typescript
// אם אות הפוך עם confidence >= 65 — סגירה מלאה
if (isLong && sellConfidence >= 65) → FULL (reversal)
if (isShort && buyConfidence >= 65) → FULL (reversal)
```

---

## 4. חישוב Confidence

**מקור:** `src/services/proSimExecution.ts`

```typescript
// rawConfidence = ציון גומרי מ-Layer 1 (לפני קנסות)
// confidence = ציון סופי (אחרי קנסות)

// קנסות
if (volumeSignal === 'NEUTRAL') confidence *= 0.6;
if (regime === 'RANGING') confidence *= 0.7;
```

**סינון בסימולציה:**
```typescript
// proSimExecution.ts — Confidence floor
const minConf = config.minConfidenceOverride ?? 58;
if (signal.rawConfidence < minConf) → BLOCK
```

**סף מינימלי:** 58 (ניתן לשינוי דרך ה-UI)

---

## 5. שערול נוספים בסימולציה

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

מקור: src/services/adaptiveRisk.ts

streakFactor:   רצף 2 הפסדים → ×0.75, רצף 3 → ×0.5, רצף 5+ → ×0.25
drawdownFactor: ליניארי מ-1.0 (drawdown=0%) עד 0.25 (drawdown=11.25%), רצפה שם
winRateFactor:  ±10% לפי win-rate (רק מעל 10 עסקאות בחלון)

multiplier = streakFactor × drawdownFactor × winRateFactor, מוגבל ל-0.2–1.0

מוכפל ישירות ב-betFraction (Kelly) — יכול רק להקטין, לעולם לא להגדיל.

### Correlation Gate — מניעת קורלציה

```typescript
// מקסימום 12 פוזיציות מקורלציות
if (correlatedPositions >= maxCorrelated) → BLOCK
```

### Same-Asset Dedup — מניעת כפילות

```typescript
// אין כניסה חוזרת לאותו נכס
if (isHeld) → BLOCK
```

---

## 6. זרימת ביצוע סימולציה

### מחזור ראשי (Tick)

```
1. Refresh Market Data (כל 60 שניות)
   ├── getAggregatedPrices() — מחירי שוק
   └── getUniverseMarketData() — נרות H1

2. Build Evaluations
   └── buildProEvaluations() — החלטה לכל סימבול

3. Generate Orders
   └── generateProOrders() — יצירת פקודות

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

## 7. קונפיגורציה

**ערכי ברירת מחדל:**
| פרמטר | ערך |
|-------|-----|
| `initialAmount` | 10,000$ |
| `stopLoss` | 4.2% |
| `takeProfit` | 3% |
| `maxPositions` | 7 (קבוע: עד 7 פוזיציות פתוחות, 2 ממתינות בתור) |
| `maxFuturesPositions` | 2 |
| `feePercent` | 0.1% |
| `slippagePercent` | 0.05% |
| `executionDelaySec` | 3 |
| `minConfidenceOverride` | 58 |
| `positionPercent` | 10% |

---

## 8. הבדלים מהבוט המקורי (Legacy)

| תכונה | Legacy | Pro |
|-------|--------|-----|
| מקור אלגוריתם | tradeEngine.ts (סטה) | proAlgEngine.ts (מדויק ל-alg.md) |
| SPOT threshold | 58 (סטטי) | 58 (סטטי) |
| FUTURES threshold | 70 (סטטי) | 70 (סטטי) |
| Daily circuit breaker | 8% | 8% |
| Weekly circuit breaker | 15% | 15% |
| Supertrend match | נדרש ל-Futures | לא נדרש (לא ב-alg.md) |
| Position sizing | risk-first + Kelly (6%) | Kelly ישיר (6%) |
| קנסות Layer 1 | לא מיושמים | מיושמים (×0.6, ×0.7) |
| Time exit | סגירה מלאה אחרי 48 שעות | 50% סגירה |

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
| `reasoning` | הסבר החלטה |
| `status` | סטטוס (מוכן/חסום) |
| `willExecute` | האם יבוצע |
| `factors` | גורמי החלטה |
| `regime` | משטר שוק |
| `leverage` | מינוף |
| `stopLoss` | Stop Loss |
| `takeProfit1` | Take Profit ראשון |
