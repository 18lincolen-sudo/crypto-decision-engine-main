# אלגוריתם ההחלטה וניהול הסיכונים (Spot + Futures) — ארכיטקטורת 6 שכבות

מסמך זה מתאר באופן מלא ומדויק את שרשרת ההחלטה האלגוריתמית של מערכת המסחר (בוט הסימולציה ובוט המסחר האמיתי ב-Bybit).
המערכת פועלת על בסיס מנוע החלטות אחוד (`tradeEngine.ts`), המבטיח תאימות מלאה (100% Parity) בין הסימולציה לביצוע החי.

---

## ═══════════════════════════════════════════════════════
## LAYER 0 — MARKET REGIME DETECTION (מופעל ראשון תמיד)
## ═══════════════════════════════════════════════════════

לפני כל החלטת מסחר, המערכת מזהה ומנתחת את משטר השוק הנוכחי על פי 3 רכיבים מרכזיים:

1. **מדד עוצמת מגמה ADX(14)**:
   - `ADX > 25` → **TRENDING** (שוק מגמתי מובהק — תומך במסחר Futures ממונף).
   - `ADX < 20` → **RANGING** (שוק דשדוש / ציר — מותר מסחר Spot בלבד).
   - `20 <= ADX <= 25` → **TRANSITIONAL** (משטר מעבר — חסימה מוחלטת לפתיחת כל עמדה חדשה).

2. **כיוון מגמה Supertrend(10, 3)**:
   - קו ה-Supertrend מתחת למחיר הנכס → **BULLISH TREND (BULL)**.
   - קו ה-Supertrend מעל למחיר הנכס → **BEARISH TREND (BEAR)**.

3. **משטר תנודתיות Volatility Regime מבוסס ATR(14)**:
   - חישוב תנודתיות באחוזים: $\text{ATR}\% = \frac{\text{ATR}(14)}{\text{Price}} \times 100$
   - $\text{ATR}\% < 2\%$ → **LOW VOL** (תנודתיות נמוכה, מאפשרת מינוף מרבי של עד 5x).
   - $2\% \le \text{ATR}\% \le 5\%$ → **NORMAL VOL** (תנודתיות רגילה, מינוף מרבי 3x).
   - $\text{ATR}\% > 5\%$ → **HIGH VOL** (תנודתיות קיצונית — איסור מוחלט על פתיחת עמדות Futures חדשות).

**פלט Layer 0**:
```typescript
interface MarketRegimeResult {
  regime: 'TRENDING' | 'RANGING' | 'TRANSITIONAL';
  direction: 'BULL' | 'BEAR' | 'NEUTRAL';
  volatility: 'LOW' | 'NORMAL' | 'HIGH';
  adx: number;
  atr: number;
  atrPercent: number;
  supertrend: { value: number; direction: 'BULL' | 'BEAR' };
}
```

---

## ═══════════════════════════════════════════════════════
## LAYER 1 — SIGNAL ENGINE (מנוע האותות)
## ═══════════════════════════════════════════════════════

מנוע האותות מופעל **אך ורק** אם:
$$\text{regime} \ne \text{TRANSITIONAL} \quad \text{AND} \quad \text{volatility} \ne \text{HIGH}$$

### אינדיקטורים, משקולות ורגישויות (סה"כ 100 נקודות משקל)

| אינדיקטור | משקל | תנאי אות חזק (Strength 1.0) | תנאי אות רגיל (Strength 0.7-0.8) |
|---|---|---|---|
| **MACD Cross (12, 26, 9)** | **20** | חציית קו מעל/מתחת לאפס | מומנטום היסטוגרמה חיובי/שלילי |
| **EMA 20 / 50 Cross** | **18** | Golden Cross / Death Cross טרי | EMA20 מעל/מתחת ל-EMA50 |
| **RSI(14)** | **12** | $<25$ (Oversold קיצוני) / $>75$ (Overbought) | $<35$ (Buy) / $>65$ (Sell) |
| **Bollinger Bands (20, 2)** | **12** | Squeeze Bandwidth + פריצה מעבר לרצועה | נגיעה או חריגה מהרצועה |
| **Volume Surge** | **18** | $\text{Volume} \ge 1.5 \times \text{SMA}_{20}(\text{Volume})$ | פחות מ-1.5x ממוצע 20 נרות |
| **Supertrend (10, 3)** | **12** | מחיר מעל/מתחת ל-Supertrend | אישוש כיוון מגמה |
| **Stochastic (14, 3)** | **8** | $K < 20 \ \& \ D < 25$ / $K > 80 \ \& \ D > 75$ | פילטר אישוש בלבד |

### חישוב הביטחון (Confidence) וקנסות פילטר קשיחים:
1. סכימת נקודות המשקל עבור כל צד (BUY מול SELL):
   $$\text{RawConfidence} = \frac{\sum (\text{weight}_i \times \text{strength}_i)}{\text{TotalWeight}} \times 100$$
2. **קנס חוסר נפח**: אות ללא אישור נפח נחשב כושל — אם `Volume Surge === NEUTRAL`:
   $$\text{Confidence} = \text{RawConfidence} \times 0.6$$
3. **קנס שוק דשדוש**: אם `ADX < 20` (משטר Ranging), כל אות מגמתי מקבל קנס:
   $$\text{Confidence} = \text{Confidence} \times 0.7$$

---

## ═══════════════════════════════════════════════════════
## LAYER 2 — TRADE TYPE ROUTER (ניתוב סוג העסקה)
## ═══════════════════════════════════════════════════════

המערכת קובעת באופן אוטונומי האם העסקה תתבצע ב-**Futures (מינוף)** או ב-**Spot**:

### 1. FUTURES (Long / Short)
מתבצע אך ורק אם **כל** התנאים הבאים מתקיימים בו-זמנית:
1. $\text{regime} === \text{'TRENDING'}$
2. $\text{confidence} \ge 72\%$
3. $\text{volatility} === \text{'NORMAL'} \text{ או } \text{'LOW'}$
4. $\text{ADX} > 25$
5. אין פוזיציית Futures פתוחה על אותו נכס

* כיוון: `LONG` אם פעולת השכבה היא BUY, או `SHORT` אם פעולת השכבה היא SELL.

### 2. SPOT (Buy / Sell)
מתבצע כאשר:
1. $\text{confidence} \ge 60\%$
2. $\text{regime} === \text{'TRENDING'} \text{ או } \text{'RANGING'}$
3. לא עומד בכל תנאי ה-Futures (למשל ביטחון בין 60% ל-71%, או שוק Ranging).

### 3. HOLD (המתנה)
כאשר הביטחון נמוך מ-60% או כאשר תנאי הסיכון אינם מאפשרים כניסה.

---

## ═══════════════════════════════════════════════════════
## LAYER 3 — RISK MANAGEMENT ENGINE (ניהול סיכונים מקצועי)
## ═══════════════════════════════════════════════════════

### 1. יעדי רווח ועצירת הפסד דינמיים מבוססי ATR(14)
יעדי המסחר אינם אחוזים קבועים, אלא מחושבים דינמית לפי מדד ה-ATR של הנכס:

- **עסקאות Spot**:
  $$\text{Stop Loss} = \text{entryPrice} - (\text{ATR} \times 1.8)$$
  $$\text{Take Profit} = \text{entryPrice} + (\text{ATR} \times 2.7) \quad (R:R \ge 1.5)$$

- **עסקאות Futures Long**:
  $$\text{Stop Loss} = \text{entryPrice} - (\text{ATR} \times 1.5)$$
  $$\text{TP1 (50\% מימוש)} = \text{entryPrice} + (\text{ATR} \times 2.0)$$
  $$\text{TP2 (סגירת שארית)} = \text{entryPrice} + (\text{ATR} \times 3.5)$$

- **עסקאות Futures Short**:
  $$\text{Stop Loss} = \text{entryPrice} + (\text{ATR} \times 1.5)$$
  $$\text{TP1 (50\% מימוש)} = \text{entryPrice} - (\text{ATR} \times 2.0)$$
  $$\text{TP2 (סגירת שארית)} = \text{entryPrice} - (\text{ATR} \times 3.5)$$

### 2. לוגיקת קביעת מינוף (Leverage)
- $\text{volatility} === \text{LOW}$ → מינוף בסיס **5x**
- $\text{volatility} === \text{NORMAL}$ → מינוף בסיס **3x**
- $\text{confidence} \ge 80\%$ → תוספת $+1\text{x}$ (עד מקסימום 5x)
- **חסימת קוד קשיחה**: מינוף לעולם לא יעלה על 5x.

### 3. גודל פוזיציה — Kelly Criterion מוגבל
חישוב גודל הפוזיציה מבוצע לפי מודל קלי:
$$\text{KellyFraction} = W - \frac{1 - W}{R}$$
כאשר:
- $W$ = אחוז ההצלחה (Win Rate) מתוך היסטוריית 30 עסקאות אחרונות לפחות.
- $R$ = יחס רווח ממוצע להפסד ממוצע ($\frac{\text{Avg Win}}{\text{Avg Loss}}$).
- $\text{BetSize} = \text{PortfolioValue} \times \min(\max(0, \text{KellyFraction} \times 0.5), 0.10)$
- **תקרה קשיחה**: מקסימום 10% משווי התיק לעסקה בודדת.
- **ברירת מחדל בהיעדר היסטוריה מספקת**: 3% משווי התיק.

### 4. הגבלת חשיפת תיק כוללת
- מקסימום **7 פוזיציות פתוחות** בו-זמנית בכל התיק.
- מקסימום **2 פוזיציות Futures** בו-זמנית.
- סה"כ חשיפה ממונפת לא תעלה על **20% משווי התיק**.

---

## ═══════════════════════════════════════════════════════
## LAYER 4 — EXIT ENGINE (מנוע יציאות מנוטר בכל טיק)
## ═══════════════════════════════════════════════════════

בכל טיקט מנוטרות 5 שכבות יציאה לכל פוזיציה פתוחה:

1. **פגיעה ב-TP / SL**:
   - Spot: פגיעה ב-SL או ב-TP מובילה לסגירה מיידית מלאה (100%).
   - Futures: פגיעה ב-TP1 מבצעת סגירה של 50% מהפוזיציה ומפעילה Trailing Stop. פגיעה ב-TP2 או ב-SL מבצעת סגירה מלאה.
2. **Trailing Stop מבוסס ATR**:
   - ב-Futures (לאחר נגיעה ב-TP1):
     - עבור Long: קו ה-Stop נע ב-$\text{ATR} \times 1.0$ מתחת לשיא שנרשם.
     - עבור Short: קו ה-Stop נע ב-$\text{ATR} \times 1.0$ מעל לשפל שנרשם.
   - ב-Spot (בפוזיציה ברווח): ה-Stop נע ב-$\text{ATR} \times 1.3$ מתחת לשיא.
3. **יציאת היפוך אותות (Signal Reversal)**:
   - פוזיציית BUY / LONG פתוחה ועכשיו ביטחון SELL עולה ל-$\ge 65\%$ → יציאה מיידית.
   - פוזיציית SELL / SHORT פתוחה ועכשיו ביטחון BUY עולה ל-$\ge 65\%$ → יציאה מיידית.
4. **יציאה מבוססת זמן (Time-Based Exit)**:
   - ב-Spot: אם לאחר 48 שעות הפוזיציה בהפסד של מעל 50% ממרחק ה-SL → יציאה.
   - ב-Futures: אם לאחר 24 שעות לא נרשמה נגיעה ב-TP1 → צמצום הפוזיציה ב-50%.
5. **הגנת תיק מפני Drawdown (Circuit Breakers)**:
   - ירידת ערך תיק יומית של $\ge 8\%$ → עצירה מוחלטת של פתיחת עסקאות חדשות.
   - ירידת ערך תיק שבועית של $\ge 15\%$ → כיבוי אוטומטי מלא של הבוט והתרעה קריטית.

---

## ═══════════════════════════════════════════════════════
## LAYER 5 — עמלות, החלקה ותאימות מלאה (Simulation vs Live)
## ═══════════════════════════════════════════════════════

### עמלות Bybit רשמיות
- **Bybit Spot**: Maker 0.1%, Taker 0.1%
- **Bybit Futures**: Maker 0.02%, Taker 0.055%

### מודל החלקה (Slippage Simulation)
- בסימולציה, מיושמת החלקה רנדומלית מציאותית בטווח של $0.05\%$ עד $0.15\%$ לרעת העסקה:
  $$\text{FillPrice}_{\text{Buy}} = \text{MarketPrice} \times (1 + \text{Slippage})$$
  $$\text{FillPrice}_{\text{Sell}} = \text{MarketPrice} \times (1 - \text{Slippage})$$

### תאימות מלאה (100% Parity)
- שני הבוטים משתמשים באותו קובץ `tradeEngine.ts`.
- כל חישובי ה-Regime, ה-Signal, ה-Kelly, ה-TP/SL והיציאות זהים לחלוטין.
- בבוט החי, כל הפקודות נשלחות דרך Bybit API v5 ב-Unified Account (קטגוריות `spot` ו-`linear`).
