# אלגוריתם ההחלטה וניהול הסיכונים (Spot + Futures) — ארכיטקטורת 7 שכבות

מסמך זה מתאר באופן מלא ומדויק את שרשרת ההחלטה האלגוריתמית של מערכת המסחר.  
המערכת פועלת על בסיס מנוע החלטות אחוד (`tradeEngine.ts`) המבטיח תאימות מלאה (100% Parity) בין בוט הסימולציה לבוט המסחר החי ב-Bybit.

> **עדכון אחרון**: גרסה 2.1 — משקפת את הקוד ב-`tradeEngine.ts` במלואו.

---

## ═══════════════════════════════════════════════════════
## LAYER 0 — MARKET REGIME DETECTION (מופעל ראשון תמיד)
## ═══════════════════════════════════════════════════════

לפני כל החלטת מסחר, המערכת מזהה את משטר השוק לפי **3 מדדים**:

### 1. ADX(14) — עוצמת מגמה

| ערך ADX | משטר | משמעות |
|---|---|---|
| `ADX > 25` | **TRENDING** | שוק מגמתי — תומך Futures + Spot |
| `ADX < 20` | **RANGING** | שוק דשדוש — רק Spot מותר |
| `20 ≤ ADX ≤ 25` | **TRANSITIONAL** | משטר מעבר — **חסימה הרמטית** לכל כניסה חדשה |

> ברירת מחדל במקרה של מעט נרות: `ADX = 22` (TRANSITIONAL)

### 2. Supertrend(10, 3) — כיוון מגמה

- קו Supertrend **מתחת** למחיר → **BULL**
- קו Supertrend **מעל** למחיר → **BEAR**
- במצב RANGING → **NEUTRAL** (ללא כיוון מגמתי)

### 3. Volatility Regime — ATR%(14)

$$\text{ATR\%} = \frac{\text{ATR}(14)}{\text{Price}} \times 100$$

| ATR% | משטר | השפעה |
|---|---|---|
| `< 2%` | **LOW** | מינוף בסיס 5x מותר |
| `2% – 5%` | **NORMAL** | מינוף בסיס 3x מותר |
| `> 5%` | **HIGH** | **Futures חסום לחלוטין** — Spot בלבד בסף מוגבר |

**פלט Layer 0:**
```typescript
interface MarketRegimeResult {
  regime:     'TRENDING' | 'RANGING' | 'TRANSITIONAL';
  direction:  'BULL' | 'BEAR' | 'NEUTRAL';
  volatility: 'LOW' | 'NORMAL' | 'HIGH';
  adx:        number;
  atr:        number;
  atrPercent: number;
  supertrend: { value: number; direction: 'BULL' | 'BEAR' };
}
```

---

## ═══════════════════════════════════════════════════════
## LAYER 1 — SIGNAL ENGINE (מנוע האותות)
## ═══════════════════════════════════════════════════════

### אינדיקטורים, משקולות ועוצמות (סה"כ משקל מקסימלי: 100)

| אינדיקטור | משקל | BUY חזק (1.0) | BUY בינוני | SELL חזק (1.0) | הערות |
|---|---|---|---|---|---|
| **MACD (12/26/9)** | 20 | חציית קו מעל אפס | MACD > Signal (0.7–0.85) | חציית קו מתחת לאפס | היסטוגרמה חיובית/שלילית |
| **EMA 20/50** | 18 | Golden Cross טרי | EMA20 > EMA50 (0.8) | Death Cross טרי | EMA20 < EMA50 (0.8) |
| **RSI(14)** | 12 | RSI ≤ 25 | RSI 25–35 (0.8) | RSI ≥ 75 | RSI 65–75 (0.8) |
| **Bollinger Bands (20/2)** | 12 | מחיר < BB Lower | — | מחיר > BB Upper | בתוך הרצועות = NEUTRAL |
| **Volume Surge** | 18 | ≥1.5x ממוצע + עלייה | <0.8x ממוצע (0.3) | ≥1.5x ממוצע + ירידה | 0.8x–1.5x = NEUTRAL (0) |
| **Supertrend (10/3)** | 12 | כיוון BULL | — | כיוון BEAR | תמיד עוצמה 1.0 |
| **Stochastic (14/3)** | 8 | K<20 & D<25 (0.85) | — | K>80 & D>75 (0.85) | אחרת NEUTRAL |

### חישוב ה-SignalScore (ציון ביטחון סופי)

$$\text{SignalScore} = \sum_{i} (\text{weight}_i \times \text{strength}_i)$$

- **ציון מקסימלי אפשרי**: 100
- מחושבים בנפרד: `buyScore` ו-`sellScore`
- הכיוון עם הציון הגבוה ביותר נבחר כ-Action
- **קנסות** (penalties) מצורפים ל-UI בלבד — **אינם מורידים את הציון** (Hard Gates נמצאים בLayer 2)

### Fear & Greed Index
- מוצג כהקשר בלבד (`penalties[]`) — אינו גורע מה-SignalScore
- `< 25` → הערת "פחד קיצוני"
- `> 75` → הערת "חמדנות קיצונית"

---

## ═══════════════════════════════════════════════════════
## LAYER 2 — TRADE ROUTER & HARD GATES (ניתוב + שערים קשיחים)
## ═══════════════════════════════════════════════════════

**סדר בדיקת שערים** (הראשון שמופעל — עוצר את השרשרת):

### שערים קשיחים (Hard Gates) — לפי סדר בדיקה

| סדר | שם | תנאי | תוצאה |
|---|---|---|---|
| 1 | **Weekly Circuit Breaker** | `weeklyDrawdown ≥ 13%` | HOLD — נעילה מלאה עד איפוס ידני |
| 2 | **Daily Circuit Breaker** | `dailyDrawdown ≥ 6%` | HOLD — חסימת כניסות חדשות |
| 3 | **Transitional Regime Block** | `ADX 20–25` | HOLD — משטר מעבר, הרמטי |
| 4 | **Same-Asset Cross-Block** | קיים Futures/Spot על אותו נכס | HOLD — חסימת כניסה נוספת |
| 5 | **No Directional Action** | `buyScore == sellScore` | HOLD — ללא יתרון כיווני |

### ניתוב FUTURES
**כל** התנאים הבאים חייבים להתקיים:
1. `regime === 'TRENDING'` (ADX > 25)
2. `volatility !== 'HIGH'` (ATR% ≤ 5%)
3. `signalScore ≥ 70`
4. Supertrend מתואם לכיוון: LONG→BULL, SHORT→BEAR
5. אין פוזיציית Futures פתוחה על אותו נכס

→ כיוון: BUY=`LONG`, SELL=`SHORT`

### ניתוב SPOT
מוערך **באופן עצמאי** (לא כ-fallback בלבד):
1. `regime === 'TRENDING'` או `'RANGING'`
2. `signalScore ≥ 58` (תנודתיות LOW/NORMAL) | `signalScore ≥ 62` (תנודתיות HIGH)

→ כיוון: BUY=`BUY`, SELL=`SELL`

### HOLD
- ציון מתחת לסף המינימלי (58) — ממתין

---

## ═══════════════════════════════════════════════════════
## LAYER 3 — RISK MANAGEMENT ENGINE (ניהול סיכונים)
## ═══════════════════════════════════════════════════════

### 1. יעדי רווח ועצירת הפסד — ATR-Dynamic

**Spot:**
$$\text{SL} = \text{entryPrice} - (\text{ATR} \times 1.8)$$
$$\text{TP} = \text{entryPrice} + (\text{ATR} \times 2.7) \quad (R:R \approx 1.5)$$

**Futures Long:**
$$\text{SL} = \text{entryPrice} - (\text{ATR} \times 1.5)$$
$$\text{TP1 (50\%)} = \text{entryPrice} + (\text{ATR} \times 2.0)$$
$$\text{TP2 (100\%)} = \text{entryPrice} + (\text{ATR} \times 3.5)$$

**Futures Short:**
$$\text{SL} = \text{entryPrice} + (\text{ATR} \times 1.5)$$
$$\text{TP1 (50\%)} = \text{entryPrice} - (\text{ATR} \times 2.0)$$
$$\text{TP2 (100\%)} = \text{entryPrice} - (\text{ATR} \times 3.5)$$

### 2. מינוף (Futures בלבד)

| תנודתיות | מינוף בסיס | תוספת אם SignalScore ≥ 80 | מקסימום |
|---|---|---|---|
| LOW | 5x | +1x (→ אך מקסימום 5x) | **5x** |
| NORMAL | 3x | +1x → 4x | **5x** |
| HIGH | חסום | — | — |

### 3. גודל פוזיציה — Risk-First (0.75% Portfolio Risk Budget)

$$\text{MaxRiskAmount} = \text{PortfolioValue} \times 0.0075$$

$$\text{StopDistance} = |\text{entryPrice} - \text{SL}|$$

$$\text{PositionSizeUnits} = \frac{\text{MaxRiskAmount}}{\text{StopDistance}}$$

$$\text{NotionalUSD} = \text{PositionSizeUnits} \times \text{entryPrice}$$

**מגבלות גודל:**
- Spot: `Notional ≤ 15% × PortfolioValue`
- Futures: סה"כ חשיפה ממונפת לא תחרוג מ-**20% מהתיק** (Hard Block אם חורג)

**Kelly Modifier** (מופעל רק עם ≥ 30 עסקאות סגורות):
$$\text{Kelly} = W - \frac{1-W}{R}$$
- $W$ = Win Rate מ-30+ עסקאות אחרונות
- $R$ = avgWin / avgLoss
- $\text{KellyScale} = \min(1.0, \max(0.2, \text{Kelly} \times 0.5))$ — חצי-Kelly, מוגבל לסקאלה 0.2–1.0
- `maxRiskAmount = maxRiskAmount × KellyScale` (תמיד ≤ 0.75%)

**ברירת מחדל ללא היסטוריה**: Kelly = 0, scale = 0.2 → risk budget = 0.15% מהתיק

**הגבלות קיבולת:**
- מקסימום **7 פוזיציות** בסך הכל
- מקסימום **2 פוזיציות Futures** בו-זמנית
- מינימום גודל עסקה: **$5**

---

## ═══════════════════════════════════════════════════════
## LAYER 3.5 — ENTRY TIMING VALIDATOR (שער כניסה אופטימלי)
## ═══════════════════════════════════════════════════════

שכבה זו מונעת "רדיפה אחרי שיאים מקומיים" לאחר שLayer 2 אישר כניסה.

### חסימות כניסה BUY / LONG

| תנאי | סיבת חסימה |
|---|---|
| `RSI > 72` | RSI קנוי-יתר — ממתין לקירור |
| `price > BB_Upper × 0.999` | מחיר בשיא Bollinger — ממתין לנסיגה |
| `price > EMA20 + ATR × 1.5` | מחיר מרוחק מהממוצע — ממתין לנסיגה |

### חסימות כניסה SELL / SHORT

| תנאי | סיבת חסימה |
|---|---|
| `RSI < 28` | RSI מכירת-יתר — ממתין לעלייה |
| `price < BB_Lower × 1.001` | מחיר בשפל Bollinger — ממתין לעלייה |
| `price < EMA20 - ATR × 1.5` | מחיר מרוחק מהממוצע — ממתין לחזרה |

### מחיר כניסה (Limit Order)

$$\text{EntryPrice}_{BUY} = \text{CurrentPrice} - (\text{ATR} \times 0.35)$$
$$\text{EntryPrice}_{SELL} = \text{CurrentPrice} + (\text{ATR} \times 0.35)$$

---

## ═══════════════════════════════════════════════════════
## LAYER 4 — EXIT ENGINE (מנוע יציאות — מנוטר בכל טיק)
## ═══════════════════════════════════════════════════════

**סדר בדיקת יציאות** לכל פוזיציה פתוחה:

### 1. Drawdown Circuit Breaker (עדיפות עליונה)
- `weeklyDrawdown ≥ 15%` → **סגירה מיידית מלאה** של הפוזיציה (הגנת הון)

> הערה: שערי כניסה חסומים כבר ב-13%, אך יציאה מוחלטת של פוזיציות מופעלת ב-15%

### 2. Stop Loss
- Long/BUY: `currentPrice ≤ SL` → יציאה מלאה
- Short: `currentPrice ≥ SL` → יציאה מלאה

### 3. Take Profit & Trailing Stop

**Spot:**
- `price ≥ TP` → יציאה מלאה (100%)
- Trailing Stop: מופעל לאחר רווח של `> 1.0 ATR` → Stop נע `1.3 ATR` מתחת לשיא

**Futures Long:**
- `price ≥ TP2` → יציאה מלאה (100%)
- `price ≥ TP1` ולא הופעל עדיין → יציאה **50% (PARTIAL_50)** + הפעלת Trailing Stop
- לאחר TP1: Stop = `peak - 1.0 ATR`

**Futures Short:**
- `price ≤ TP2` → יציאה מלאה (100%)
- `price ≤ TP1` ולא הופעל עדיין → יציאה **50% (PARTIAL_50)** + הפעלת Trailing Stop
- לאחר TP1: Stop = `valley + 1.0 ATR`

### 4. Signal Reversal Exit
- Long/BUY פתוח + ציון SELL `≥ 65` → יציאה מיידית
- Short/SELL פתוח + ציון BUY `≥ 65` → יציאה מיידית

### 5. Time-Based Exit
- **Spot**: אחרי 48 שעות, אם הפוזיציה בהפסד `> 50%` ממרחק ה-SL → יציאה
- **Futures**: אחרי 24 שעות, אם TP1 לא הושג → צמצום 50% (PARTIAL_50)

---

## ═══════════════════════════════════════════════════════
## LAYER 5 — FEES & REALISTIC SLIPPAGE (עמלות + החלקה)
## ═══════════════════════════════════════════════════════

### עמלות Bybit רשמיות

| סוג | Maker | Taker |
|---|---|---|
| **Spot** | 0.1% | 0.1% |
| **Futures (Linear)** | 0.02% | 0.055% |

> הסימולציה משתמשת בעמלת Taker (מחמירה יותר) לכל הפקודות.

### Break-Even Price (כולל עמלות הלוך-חזור)

$$\text{BE}_{Spot} = \text{entryPrice} \times 1.002 \quad (0.2\% \text{ round-trip})$$
$$\text{BE}_{Futures} = \text{entryPrice} \times 1.0011 \quad (0.11\% \text{ round-trip})$$

### מודל החלקה (Slippage)

$$\text{Slippage} \in [0.05\%, 0.15\%] \quad \text{(random, uniform)}$$
$$\text{FillPrice}_{BUY} = \text{MarketPrice} \times (1 + \text{slippage\%})$$
$$\text{FillPrice}_{SELL} = \text{MarketPrice} \times (1 - \text{slippage\%})$$

---

## ═══════════════════════════════════════════════════════
## LAYER 6 — DATA PIPELINE (מקורות נתונים חיים)
## ═══════════════════════════════════════════════════════

הבוט פועל **אך ורק** עם נרות OHLCV אמיתיים — **אפס מוק/נתונים מזויפים**.

### היררכיית מקורות נרות (לפי עדיפות)

| עדיפות | מקור | תדירות | הערה |
|---|---|---|---|
| 1 | **Bybit Klines** | `'D'`, 30 נרות | מקור ראשי — מהיר, כולל נפח |
| 2 | **Binance Public API** | `'1d'`, 60 נרות | גיבוי אם Bybit נכשל |
| 3 | **CoinGecko Historical** | 30 ימים | גיבוי אחרון — סדרתי, 4s delay בין קריאות |

- רענון אוטומטי כל **5 דקות**
- נכסים ללא נרות (`candles.length < 2`) — **מדולגים לחלוטין** (לא מוערכים)

---

## ═══════════════════════════════════════════════════════
## מסמך עזר — סיכום סף כניסות
## ═══════════════════════════════════════════════════════

| סוג | VOL | סף SignalScore | ADX נדרש |
|---|---|---|---|
| Futures LONG/SHORT | LOW/NORMAL | **≥ 70** | > 25 (TRENDING) |
| Spot BUY/SELL | LOW/NORMAL | **≥ 58** | > 20 (TRENDING/RANGING) |
| Spot BUY/SELL | HIGH | **≥ 62** | > 20 |
| כל כניסה | כל | — | **≠ TRANSITIONAL (20–25)** |

## ═══════════════════════════════════════════════════════
## מסמך עזר — Circuit Breakers
## ═══════════════════════════════════════════════════════

| סוג | סף | פעולה |
|---|---|---|
| **Daily Drawdown Block** | `≥ 6%` | חסימת כניסות חדשות בלבד |
| **Weekly Drawdown Lock** | `≥ 13%` | נעילה מלאה — שחרור ידני בלבד |
| **Forced Position Close** | `≥ 15%` (שבועי) | סגירת פוזיציות קיימות |

---

## תאימות מלאה (100% Parity)

- סימולציה + מסחר חי משתמשים **באותו** `tradeEngine.ts`
- כל החישובים (Regime, Signals, Kelly, TP/SL, Exits) — זהים לחלוטין
- בבוט החי: פקודות נשלחות ל-Bybit API v5, Unified Account
  - Spot: category `'spot'`
  - Futures: category `'linear'`
