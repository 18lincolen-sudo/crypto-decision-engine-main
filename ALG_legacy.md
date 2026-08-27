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
| `src/services/tradeEngine.ts` | מנוע מסחר בסיסי — Layers 0-3 |
| `src/services/legacySimExecution.ts` | לוגיקת ביצוע סימולציה Legacy |
| `server/legacySimEngine.ts` | מנוע סימולציה 24/7 בשרת |

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
| קנס | תנ�י | השפעה |
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
| SignalScore | >= dynamic threshold (base 70) |
| Same-Asset | ללא פוזיציית Futures קיימת |

**ניתוב Spot:**
| תנאי | ערך |
|------|-----|
| Regime | TRENDING, RANGING, או SOFT_TREND |
| SignalScore | >= dynamic threshold (base 60, 65 ב-SOFT_TREND) |

**Dynamic Confidence Threshold:**
```typescript
function dynamicConfidenceThreshold(baseThreshold, atrPercent) {
  if (atrPercent <= 2) return baseThreshold;
  const ramp = Math.min(1, (atrPercent - 2) / 6);
  return baseThreshold + ramp * 15;
}
```

| ATR% | Futures Threshold | Spot Threshold |
|------|-------------------|----------------|
| <= 2% | 70 | 60 |
| 4% | 75 | 65 |
| 6% | 80 | 70 |
| >= 8% | 85 | 75 |

---

### LAYER 3: Risk Management — ניהול סיכונים

**מקור:** `src/services/tradeEngine.ts` → `calculateRiskParameters()`

**פרמטרים:**
| פרמטר | תיאור |
|-------|-------|
| `stopLoss` | מחיר Stop Loss |
| `takeProfit1` | מחיר Take Profit ראשון |
| `takeProfit2` | מחיר Take Profit שני |
| `leverage` | מינוף (1x-5x) |
| `betSizeUsd` | גודל התערבוב בדולרים |
| `riskRewardRatio` | יחס סיכון-רווח |
| `kellyFraction` | שביר Kelly לחישוב גודל |

**חישוב גודל פוזיציה (Kelly Criterion):**
```typescript
// חישוב בסיסי
kellyFraction = winRate - (1 - winRate) / riskRewardRatio
betSizeUsd = portfolioValue × kellyFraction × 0.5 (half-Kelly)
```

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

## 4. חישוב Confidence

**מקור:** `src/services/legacySimExecution.ts`

```typescript
// חישוב confidence מ-Layer 1
confidence = layer1.signalScore;

// קנסות
if (volumeSignal === 'NEUTRAL') confidence *= 0.6;
if (regime === 'RANGING') confidence *= 0.7;
```

**סינון בסימולציה:**
```typescript
// legacySimExecution.ts — Confidence floor
const minConf = config.minConfidenceOverride ?? 58;
if (layer1.signalScore < minConf) → BLOCK
```

**סף מינימלי:** 58 (ניתן לשינוי דרך ה-UI)

---

## 5. שערול נוספים בסימולציה

### Streak Cooldown — השהיה אחרי הפסדים

```typescript
// אחרי 3 הפסדים רצופים — השהיה של 24 שעות
if (streakCooldownActive) → BLOCK
```

### Correlation Gate — מניעת קורלציה

```typescript
// מקסימום 3 פוזיציות מקורלציות
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
   └── buildLegacyEvaluations() — החלטה לכל סימבול

3. Generate Orders
   └── generateLegacyOrders() — יצירת פקודות

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

**מקור:** `src/services/legacySimExecution.ts` → `evaluateExit()`

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

**ערכי ברירת מחדל:**
| פרמטר | ערך |
|-------|-----|
| `initialAmount` | 10,000$ |
| `stopLoss` | 4.2% |
| `takeProfit` | 3% |
| `maxPositions` | דינמי (7 × 1000 / initialAmount) |
| `maxFuturesPositions` | 2 |
| `feePercent` | 0.1% |
| `slippagePercent` | 0.05% |
| `executionDelaySec` | 3 |
| `minConfidenceOverride` | 58 |
| `positionPercent` | 10% |

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
