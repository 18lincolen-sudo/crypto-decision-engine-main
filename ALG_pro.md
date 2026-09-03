# ALG_pro.md — אלגוריתם בוט פרו (Bot Pro — alg.md)

> מסמך זה מתאר בפירוט את אלגוריתם ההחלטה של בוט פרו, כולל כל השלבים, השערולים, והחישובים. בוט פרו מיישם את מפרט ASSETS/alg.md לניתוב, ניהול סיכונים ויציאה, אך **מקור האותות שונה** — הוא משתמש במנוע הניתוח המתקדם של האתר (`proAdvancedAnalysis.ts`) כדי לקבל המלצה, ולאחר מכן עובר את אותות alg.md דרך שלבי הניתוב והסיכון.

---

## 1. סקירה כללית

בוט פרו מיישם את מפרט **ASSETS/alg.md** לניתוב, ניהול סיכונים ויציאה, אך **מקור האותות שונה** מהאלגוריתם המקורי — הוא משתמש במנוע הניתוח המתקדם של האתר (`proAdvancedAnalysis.ts`) כדי לקבל המלצה, ולאחר מכן עובר את אותות alg.md דרך שלבי הניתוב והסיכון.

**מקורות מידע:**
- **Bybit** — נתוני שוק (candles, ticker, instruments-info) עם גיבוי מ-Binance
- **CoinGecko** — נתוני ניתוח
- **Alternative.me** — מדד פחד וחמדנות (Fear & Greed Index)

**קבצים מרכזיים:**
| קובץ | תפקיד |
|------|-------|
| `packages/engine/src/services/proAdvancedAnalysis.ts` | מקור אותות Pro — מנוע הניתוח המתקדם של האתר |
| `packages/engine/src/services/proAlgEngine.ts` | מנוע החלטות Pro — זיהוי משטר, ניתוב, סיכון, יציאה (alg.md) |
| `packages/engine/src/services/proSimExecution.ts` | לוגיקת ביצוע סימולציה Pro — buildProEvaluations, generateProOrders |
| `packages/engine/src/services/adaptiveRisk.ts` | סיכון אדפטיבי + streak cooldown (משותף) |
| `packages/engine/src/services/correlation.ts` | מניעת קורלציה (משותף) |
| `packages/engine/src/services/simExecution.ts` | ביצוע פקודות משותף (fillDueOrders) |
| `server/proSimEngine.ts` | adapter למנוע סימולציה 24/7 בשרת |
| `server/simEngineFactory.ts` | tick loop, hydrate, persist, getSnapshot משותף |

---

## 2. שלבי ההחלטה (Layer Order)

```
Layer 0: Market Regime Detection (זיהוי משטר שוק)
    ↓
Layer 1: Advanced Analysis Signal (מנוע הניתוח המתקדם של האתר)
    ↓
Layer 1.5: Entry Timing (תזמון כניסה)
    ↓
Layer 2: Trade Routing (ניתוב סוג עסקה)
    ↓
Layer 3: Risk Management (ניהול סיכונים)
    ↓
Layer 4: Exit Logic (לוגיקת יציאה)
```

**שערולים נוספים (בסדר ביצוע):**
```
CIRCUIT_BREAKER → EXPOSURE → (Layer 0-4) → Correlation Gate → Cost/Edge → Confidence Floor → Streak Cooldown → Budget Floor
```

---

## 3. פירוט השלבים

### LAYER 0: Market Regime Detection — זיהוי משטר שוק

**מקור:** `packages/engine/src/services/proAlgEngine.ts` → `detectProRegime()`

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

### LAYER 1: Advanced Analysis Signal — אותות מנוע הניתוח המתקדם

**מקור:** `packages/engine/src/services/proAdvancedAnalysis.ts` → `computeProAdvancedAnalysis()`

**תיאור:** במקום חישוב ציון ביטחון פנימי (כפי שהיה בקוד הקודם), בוט פרו משתמש כעת במנוע הניתוח המתקדם של האתר (`generateSmartRecommendation`) כדי לקבל המלצה וציון ביטחון. האלגוריתם מחשב אינדיקטורים טכניים (RSI, MACD, Bollinger Bands, Stochastic, Williams %R) ומשקל אותות לפי עוצמתם.

**אינדיקטורים ומשקלות (סה"כ 100):**
| אינדיקטור | משקל | תנאי BUY | תנאי SELL |
|-----------|------|----------|-----------|
| **Advanced Analysis** | 50 | recommendation = buy | recommendation = sell |
| **RSI** | 15 | < 30 (מכירת יתר) | > 70 (קניית יתר) |
| **MACD** | 18 | MACD חיובי | MACD שלילי |
| **Stochastic** | 10 | oversold | overbought |
| **Williams %R** | 7 | < -80 | > -20 |

**חישוב Confidence:**
```typescript
// confidence = הציון מהמנוע המתקדם (0-100)
// rawConfidence = confidence (ללא קנסות בפרו)
```

**קנסות (Penalties):**
| קנס | תנאי | השפעה |
|-----|------|-------|
| פחד קיצוני | Fear & Greed < 25 | הוספת הערת סנטימנט |
| חמדנות קיצוני | Fear & Greed > 75 | הוספת הערת סנטימנט |

---

### LAYER 1.5: Entry Timing — תזמון כניסה

**מקור:** `packages/engine/src/services/proAlgEngine.ts` → `calculateProOptimalEntry()`

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
  if (currentPrice > ema20 + atr * 1.5) → shouldEnter = false, sizeMultiplier < 1
  // אחרת — כניסה מיידית
  else → shouldEnter = true, entryPrice = currentPrice
}
else if (action === 'SELL') {
  // אם מחיר מורחק מתחת ל-EMA20 — ממתין לעלייה
  if (currentPrice < ema20 - atr * 1.5) → shouldEnter = false, sizeMultiplier < 1
  // אחרת — כניסה מיידית
  else → shouldEnter = true, entryPrice = currentPrice
}
```

**Size Multiplier:** כניסות מורחבות (מעל EMA20 ± 1.5×ATR) עדיין מותרות עם הפחתת גודל (sizeMultiplier < 1) במקום חסימה קשה.

---

### LAYER 2: Trade Routing — ניתוב סוג עסקה

**מקור:** `packages/engine/src/services/proAlgEngine.ts` → `routeProTradeType()`

**קלט:** אות מהמנוע המתקדם (`action`, `rawConfidence`) + משטר שוק מ-Layer 0.

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
| rawConfidence | >= dynamic(72) (סף דינמי לפי ATR%) |
| Same-Asset | ללא פוזיציית Futures קיימת |

**ניתוב Spot:**
| תנאי | ערך |
|------|-----|
| Regime | TRENDING, RANGING, או SOFT_TREND |
| rawConfidence | >= dynamic(60) (סף דינמי לפי ATR%, 65 ב-SOFT_TREND) |

**סף ביטחון דינמי:**
```typescript
// הסף משתנה לפי ATR% — בטווח שבין 2% ל-8% ATR, הסף עולה לינארית עד +15 נקודות
function dynamicConfidenceThreshold(baseThreshold, atrPercent) {
  if (atrPercent <= 2) return baseThreshold;
  if (atrPercent >= 8) return baseThreshold + 15;
  return baseThreshold + ((atrPercent - 2) / 6) * 15;
}
```

| סוג עסקה | סף מינימלי (ATR% <= 2) | סף מקסימלי (ATR% >= 8) |
|----------|------------------------|------------------------|
| Futures | 72 | 87 |
| Spot | 60 | 75 |
| Spot (SOFT_TREND) | 65 | 80 |

---

### LAYER 3: Risk Management — ניהול סיכונים

**מקור:** `packages/engine/src/services/proAlgEngine.ts` → `calculateProRisk()`

**מגבלות פורפוליו:**
| מגבלה | ערך |
|-------|-----|
| מקסימום פוזיציות | 7 |
| מקסימום Futures | 2 |

**חישוב Stop Loss / Take Profit:**
| סוג | SL | TP1 | TP2 |
|-----|----|----|-----|
| **SPOT** | entry - ATR × 1.8 | - | entry + ATR × 2.7 |
| **FUTURES LONG** | entry - ATR × 1.5 | entry + ATR × 2.3 | entry + ATR × 3.5 |
| **FUTURES SHORT** | entry + ATR × 1.5 | entry - ATR × 2.3 | entry - ATR × 3.5 |

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

**High-Confidence Fallback:**
```typescript
// אם calculateProRisk דחה אבל confidence >= 72 — fallback עם SL 1.8% / TP 3%
if (!risk.approved && signal.rawConfidence >= HIGH_CONFIDENCE_BYPASS) → buildFallbackProRisk()
```

---

### LAYER 4: Exit Logic — לוגיקת יציאה

**מקור:** `packages/engine/src/services/proAlgEngine.ts` → `evaluateProExit()`

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
// 24 שעות ללא TP1 — בדיקת התקדמות
// אם הפוזיציה התקדמה ב-30% ממרחק ה-SL — הרחבה ל-36 שעות
// אחרת — סגירה חלקית של 50%
if (hoursHeld >= 24 && !tp1Hit) {
  const progressR = (currentPrice - entryPrice) / stopDistance;
  if (progressR > 0.3 && hoursHeld < 36) {
    → ממשיכים עד 36 שעות
  } else {
    → PARTIAL_50 (סגירת 50%)
  }
}
```

**היפוך אותות:**
```typescript
// אם אות הפוך עם confidence >= 65 — סגירה מלאה
if (isLong && sellConfidence >= 65) → FULL (reversal)
if (isShort && buyConfidence >= 65) → FULL (reversal)
```

---

## 4. חישוב Confidence

**מקור:** `packages/engine/src/services/proAdvancedAnalysis.ts` → `computeProAdvancedAnalysis()`

```typescript
// confidence = הציון מהמנוע המתקדם (0-100)
// rawConfidence = confidence (ללא קנסות בפרו)
// הערות סנטימנט מצורפות אם Fear & Greed בקיצוניות
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

### Circuit Breakers

```typescript
const PRO_WEEKLY_DRAWDOWN_LOCK_PERCENT = 15;
const PRO_DAILY_DRAWDOWN_BLOCK_PERCENT = 8;
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

מקור: `packages/engine/src/services/adaptiveRisk.ts`

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
// אין כניסה חוזרת לאותו נכס (Spot בלבד — alg.md לא חוסם Futures כפול)
if (isHeld) → BLOCK
```

### Cost / Edge Gate

```typescript
// יחס סיכון-רווח נמוך מדי
if (effectiveRisk.riskRewardRatio < MIN_RISK_REWARD_RATIO) → BLOCK
```

### Budget Floor

```typescript
// תקציב נמוך מדי
const budget = computeEntryBudget(cash, tradeType);
if (budget < 5) → BLOCK
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
        ├── computeProAdvancedAnalysis() (Layer 1)
        ├── detectProRegime() (Layer 0)
        ├── routeProTradeType() (Layer 2)
        ├── calculateProOptimalEntry() (Layer 1.5)
        ├── calculateProRisk() (Layer 3)
        ├── Correlation Gate
        ├── Cost/Edge Gate
        ├── Confidence Floor
        └── Streak Cooldown

3. Generate Orders
    └── generateProOrders() — יצירת פקודות
        ├── evaluateProExit() — בדיקת יציאה מפוזיציות קיימות
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

## 7. קונפיגורציה

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

## 8. הבדלים מהבוט המקורי (Legacy)

| תכונה | Legacy | Pro |
|-------|--------|-----|
| מקור אותות | tradeEngine.ts (סטה) | proAdvancedAnalysis.ts (מנוע האתר) |
| SPOT threshold | 58 (סטטי) | 60 (דינמי לפי ATR%) |
| FUTURES threshold | 70 (סטטי) | 72 (דינמי לפי ATR%) |
| Daily circuit breaker | 8% | 8% |
| Weekly circuit breaker | 15% | 15% |
| Supertrend match | נדרש ל-Futures | לא נדרש (לא ב-alg.md) |
| Position sizing | risk-first + Kelly (6%) | Kelly ישיר (6%) |
| קנסות Layer 1 | לא מיושמים | לא מיושמים (מקור אותות חדש) |
| Time exit | סגירה מלאה אחרי 48 שעות | 50% סגירה + הרחבה ל-36 שעות |
| Entry timing | calculateOptimalEntry | calculateProOptimalEntry (עם size multiplier) |
| Cost/Edge gate | MIN_RISK_REWARD_RATIO | MIN_RISK_REWARD_RATIO |
| High-confidence bypass | 72 (Layer 3) | 72 (Layer 3) |

---

## 9. סיכום שדות SignalEvaluation

| שדה | תיאור |
|-----|-------|
| `symbol` | סימבול |
| `action` | `buy` / `sell` / `hold` |
| `tradeType` | `SPOT` / `FUTURES` / `HOLD` |
| `tradeSide` | `LONG` / `SHORT` / `BUY` / `SELL` / `NONE` |
| `confidence` | ציון ביטחון (0-100) ממנוע הניתוח המתקדם |
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
| `advancedPredictions` | תחזיות (24h/7d/30d) |
| `advancedReason` | ניתוח מתקדם |
| `advancedSupport` | רמת תמיכה |
| `advancedResistance` | רמת התנגדות |
| `advancedRiskLevel` | רמת סיכון |
