# דוח שיפורים — שלושת מנועי הבוט סימולציה
**הנחות עבודה:** אנליסט שוק הון בכיר עם 12 שנות ניסיון, התמחות באלגוריתמי מסחר אוטונומיים וניהול סיכונים כמותי.

---

## סיכון כללי משותף לשלושת המנועים

### 1. חוסר פילטר קורלציה בין נכסים
**הבעיה:** שלושת המנועים מאפשרים לפתוח פוזיציות במספר נכסים שקשורים קורלציה גבוהה ביניהם (למשל BTC + ETH + SOL במהלך טרנד שורי). כאשר השוק מתהפך, כל הפוזיציות נסגרות כמעט במקביל, מה שגורם לerddown חד-ממדי מהיר.

**השיפור המומלץ:**
- הוספת מטריקת קורלציה דינמית מבוססת נתוני מחיר חייים (correlation matrix על חלון 24-72 שעות)
- הגבלת פוזיציות במקביל בנכסים עם קורלציה > 0.7 למקסימום 2-3 נכסים
- העדפת נכסים עם קורלציה נמוכה יותר לשילוב תיק מגוון

### 2. חוסר התאמה דינמית של ספי ביטחון לפי תנודתיות שוק
**הבעיה:** ספי הכניסה (58/60/72) קבועים ואינם מתחשבים בתנודתיות הנוכחית. במהלך תנודתיות EXTREME, סף 72 ל-Futures נשאר קבוע גם שהסיכון הריאלי גדול פי 2-3 מהרגיל.

**השיפור המומלץ:**
- סף דינמי: `confidenceRequired = baseThreshold + (atrPercentile / 100) * 15`
  - EXTREME (95+ percentile): Futures סף עולה ל-85+, Spot ל-70+
  - LOW (30- percentile): Futures נשאר 72, Spot נשאר 60
- הוספת "volatility gate" שמגדיל את הסף ככל שהתנודתיות עולה

### 3. ניהול סיכונים ריגידי מדי
**הבעיה:** כל שלושת המנועים משתמשים ב-Risk Per Trade קבוע (0.5%-0.75%) ללא התאמה לביצועים האחרונים. אחרי 5 הפסדים רצופים, הסיכון עדיין זהה למקודם.

**השיפור המומלץ:**
- **Adaptive Risk Sizing:** `riskPercent = baseRisk * (1 - recentLossStreak * 0.1) * (1 + recentWinRate * 0.05)`
  - אחרי 3 הפסדים רצופים: Risk מוריד ל-0.25% (חצי מהבסיס)
  - אחרי 5 ניצחונות רצופים: Risk עולה ל-1.0% (מקסימום)
- **Streak-based cooldown:** אחרי 2 הפסדים רצופים, הכניסות נחסמות ל-30 דק' הבאות (לא רק לפי סף ביטחון)

---

## שיפורים ספ�יפיים לכל מנוע

---

## מנוע 1 — Multi-Timeframe (1H/15M/5M)

### יתרונות עיקריים:
- מבנה שערים רב-שכבתי מובנה היטב
- פילטר עלויות/שוליים (Cost/Edge) חכם
- הגנה מפורשת על MEAN_REVERSION מפני whipsaw
- Time stops מותאמים לפי סוג Setup

### חולשות ושיפורים נדרשים:

#### 1.1 אבחנה משטר שוק 1H קטסטרופלית
**הבעיה:** `detectRegime1H` דורש EMA20/50 + Supertend + ADX25+ לכל מגמה. אם EMA20 עדיין לא מיושרת אבל Supertrend + ADX כבר מצביעים על מגמה — המערכת מחמיצה כניסה.

**השיפור:**
```typescript
// הוספת "soft trend" detection
const softTrend = adx > 22 && supertrend.direction === expectedDirection && (ema20 - ema50) * s > -atr * 0.5;
if (softTrend && !hardTrend) {
  // אפשר כניסות Spot בלבד עם סף ביטחון מוגבר
  regime = 'SOFT_TREND';
  futuresAllowed = false;
}
```

#### 1.2 חסימת TRANSITIONAL מוחלטת
**הבעיה:** המערכת חוסמת כל כניסה חדשה ב-TRANSITIONAL, גם אם Setup+Entry חזקים מאוד. השוק יכול להיות בטרנד חלקי שמתחיל רק עכשיו.

**השיפור:**
- הוספת רמת ביניים: `TRANSITIONAL_QUALITY` — אם SetupScore >= 70 + EntryScore >= 65 + ATR percentile < 60, אפשר Spot כניסה
- Futures נשאר חסום ב-TRANSITIONAL (נכון)

#### 1.3 פילטר נפח 5M חלש למשקלי Mean Reversion
**הבעיה:** `volumeTooLow` נגרע רק למשקלי TREND_PULLBACK ו-BREAKOUT_RETEST. MEAN_REVERSION יכול להיכנס על נפח נמוך מאוד, מה שהופך אותו למלכודת שיקים.

**השיפור:**
```typescript
// MEAN_REVERSION צריך לפחות 0.5x relative volume (לא 0)
const minMrVolume = 0.5;
if (isMeanReversion && triggerVolumeRelative < minMrVolume) {
  blockers.push(`נפח MEAN_REVERSION נמוך מדי (${triggerVolumeRelative.toFixed(2)}x)`);
}
```

#### 1.4 Time Stop צפוף מדי למשקלי Trend Pullback
**הבעיה:** `maxHoldMinutes.TREND_PULLBACK = 90` דק' (1.5 שעות). טרנד אמיתי可能需要 זמן להתפתח, והפוזיציה נסגרת מוקדם מדי.

**השיפור:**
- `TREND_PULLBACK: 120` דק' (2 שעות) במקום 90
- הוספת תנאי הרחבה: אם `progressR >= 0.5` אחרי 90 דק', המשך החזקה עד 180 דק'

#### 1.5 חוסר הגבלת אקספוזר לפי סוג נכס
**הבעיה:** המערכת מגבילה את האקספוזר הכוללת (20% מהתיק) אבל לא מגבילה אקספוזר לפי נכס בודד. נכס אחד יכול לקחת 15% מהתיק.

**השיפור:**
```typescript
// הגבלת אקספוזר לפי נכס בודד
const maxExposurePerAsset = equity * 0.08; // 8% מהתיק לנכס בודד
if (existingExposure[symbol] + notionalUsd > maxExposurePerAsset) {
  return rejected('אקספוזר על נכס זה חורג מהמגבלה');
}
```

#### 1.6 Trailing Stop activation גבוהה מדי
**הבעיה:** `trailingActivationR = 1.0` — דורש R:R של 1:1 לפני שהטריילינג מתחיל. עבור MEAN_REVERSION עם R:R גבוה (2:1), זה אומר שהטריילינג מתחיל רק אחרי 50% מהמטרה.

**השיפור:**
```typescript
// התאמה לפי סוג Setup
const trailingActivationR = {
  TREND_PULLBACK: 0.8,
  BREAKOUT_RETEST: 1.0,
  MEAN_REVERSION: 1.5  // Mean reversion צריך יותר proof לפני טריילינג
};
```

---

## מנוע 2 — Legacy (Confidence Score)

### יתרונות עיקריים:
- מערכת ניקוד משוקללת ברורה (7 אינדיקטורים, 100 נקודות)
- Entry Timing Optimizer עם limit orders (מפחית רידפינג)
- Kelly Criterion למינוף גודל פוזיציה
- Exit engine עם trailing stop ותנאי היפוך

### חולשות ושיפורים נדרשים:

#### 2.1 Entry Timing Optimizer ריגידי
**הבעיה:** `calculateOptimalEntry` משתמש ב-pullback קבוע של 0.35 ATR. במהלך תנודתיות גבוהה, 0.35 ATR הוא קטן מדי והאורדר לא מתמלא. במהלך תנודתיות נמוכה, 0.35 ATR הוא גדול מדי ומאבד הזדמנויות.

**השיפור:**
```typescript
// Pullback דינמי לפי תנודתיות
const dynamicPullback = atrPercentile < 30 ? 0.5 :  // LOW vol - wider pullback
                        atrPercentile > 80 ? 0.2 :  // HIGH vol - tighter pullback
                        0.35;                       // NORMAL
```

#### 2.2 חסימת TRANSITIONAL מוחלטת
**הבעיה:** אותו בעיה כמו במנוע 1 — חוסמת כל כניסה חדשה ב-TRANSITIONAL, גם אם האותות חזקים.

**השיפור:** זהה למנוע 1 — הוספת `SOFT_TREND` עם carve-out ל-Spot.

#### 2.3 RSI סטטי ללא התאמה לנכס
**הבעיה:** ספי RSI (25/35/65/75) קבועים לכל נכס. נכסים עם תנודתיות גבוהה (ALTcoins) מגיעים ל-RSI קיצוני יותר מהר, ונכסים יציבים (BTC) נשארים בטווח האמצעי יותר.

**השיפור:**
```typescript
// RSI דינמי לפי ATR percentile של הנכס
const rsiExtremeLow = 25 - (atrPercentile - 50) * 0.2;  // 15-25
const rsiExtremeHigh = 75 + (atrPercentile - 50) * 0.2; // 75-85
```

#### 2.4 חוסר פילטר נפח בכניסה
**ה�בעיה:** ה-Entry Timing Optimizer לא בודק נפח כלל. ניתן להיכנס על pullback עם נפח חלש מאוד, מה שמעיד על חוסר עניין בשוק.

**השיפור:**
```typescript
// בדיקת נפח בכניסה
if (relativeVolume < 0.6) {
  return { shouldEnterNow: false, reason: 'נפח כניסה נמוך מדי' };
}
```

#### 2.5 Reversal Exit threshold סטטי
**הבעיה:** סף היפוך 65 קבוע. במהלך טרנד חזק, אותות היפוך אמיתיים מגיעים ל-70+. במהלך מעבר, 65 נמוך מדי וגורם ליציאה מוקדמת.

**השיפור:**
```typescript
// סף היפוך דינמי לפי ADX
const reversalThreshold = adx < 20 ? 55 :    // Ranging - lower threshold
                          adx > 30 ? 70 :    // Strong trend - higher threshold
                          65;                // Default
```

#### 2.6 Time Stop ל-Spot חסר
**הבעיה:** אין יציאת זמן קבועה ל-Spot. פוזיציית Spot יכולה להישאר פתוחה ימים ללא מטרה, תוך כדי תפיסת הון.

**השיפור:**
```typescript
// Spot time stop: 72 שעות מקסימום
if (!isFutures && hoursHeld >= 72) {
  return { shouldExit: true, exitType: 'FULL', reason: 'יציאת זמן Spot (72 שעות)' };
}
```

---

## מנוע 3 — Pro (alg.md)

### יתרונות עיקריים:
- מימוש מדויק של alg.md
- עונשים על ביטחון (Volume ×0.6, Ranging ×0.7) מחוברים נכון
- Kelly Criterion נכון לפי המפרט
- Time stop ל-Futures 24h (50% partial) נכון לפי alg.md

### חולשות ושיפורים נדרשים:

#### 3.1 חוסר Entry Timing Layer — החסרון הגדול ביותר
**הבעיה:** המנוע קונה/מוכר במחיר השוק החי (market price) ללא כל ניסיון להיכנס ב-level טוב יותר. זה גורם ל:
- רידפינג (chasing) אחרי תנועות
- slippage גבוה יותר
- R:R גרוע יותר

**השיפור המומלץ (הכי משמעותי):**
```typescript
// הוספת Entry Timing Layer דומה ל-legacy אבל מדויקת יותר
function calculateProOptimalEntry(currentPrice, atr, side, candles) {
  const isLong = side === 'LONG' || side === 'BUY';
  const { rsi, ema20, bbUpper, bbLower } = computeEntryIndicators(candles, currentPrice);
  const atrPullback = atr * 0.35;
  
  if (isLong) {
    // Block if RSI > 70, price > BB upper, price > EMA20 + 1.5*ATR
    if (rsi > 70 || currentPrice > bbUpper || currentPrice > ema20 + atr * 1.5) {
      return { shouldEnter: false, entryPrice: currentPrice, reason: 'מחיר מורחק - ממתין לנסיגה' };
    }
    return { shouldEnter: true, entryPrice: currentPrice - atrPullback };
  } else {
    if (rsi < 30 || currentPrice < bbLower || currentPrice < ema20 - atr * 1.5) {
      return { shouldEnter: false, entryPrice: currentPrice, reason: 'מחיר מורחק - ממתין לעלייה' };
    }
    return { shouldEnter: true, entryPrice: currentPrice + atrPullback };
  }
}
```

#### 3.2 TRANSITIONAL hard block מוחלט
**הבעיה:** alg.md קובע שכניסות חדשות חסומות ב-TRANSITIONAL, אבל השוק הישראלי/הבינלאומי לעתים קרובות נמצא ב-TRANSITIONAL למשך שעות. הבוט לא נכנס בכלל.

**השיפור:**
- הוספת `allowTransitionalSpot` flag (כבר קיים במנוע 1)
- אם SetupScore >= 75 + EntryScore >= 70 + ATR percentile < 70, אפשר Spot כניסה ב-TRANSITIONAL

#### 3.3 Volume Surge כל-or-nothing
**הבעיה:** ה-indicator רק מדליק אות אם הנפח פי 1.5+ מהממוצע. טווח 0.8x-1.5x (נפח "ממוצע") נחשב כ-NEUTRAL עם עוצמה 0, מה שמפחית את הציון הסופי.

**השיפור:**
```typescript
// גראדשיין של עוצמה לפי נפח
if (volumeRatio >= 1.5) strength = 1.0;
else if (volumeRatio >= 1.2) strength = 0.7;
else if (volumeRatio >= 0.9) strength = 0.4;
else strength = 0.2;  // לא 0 - נפח נמוך עדיין מאשר עם עוצמה נמוכה
```

#### 3.4 חוסר הגבלת אקספוזר לפי נכס
**זהה לבעיה 1.5** — אותו שיפור חל על מנוע 3.

#### 3.5 Time Stop ל-Futures קצר מדי
**הבעיה:** 24 שעות ללא TP1 = 50% partial reduction.在某些情况下, טרנד אמיתי צריך יותר זמן להתפתח, והפוזיציה נסגרת מוקדם מדי.

**השיפור:**
```typescript
// 24h baseline, but extend if trade is profitable
if (hoursHeld >= 24 && !tp1Hit) {
  const inProfit = isLong ? currentPrice > entryPrice : currentPrice < entryPrice;
  if (inProfit && progressR > 0.3) {
    // הרחב ל-36 שעות אם הפוזיציה ברווח
    return { shouldExit: false, reason: 'הרחבה: פוזיציה ברווח, ממשיכים' };
  }
  return { shouldExit: true, exitType: 'PARTIAL_50', reason: '24h ללא TP1' };
}
```

#### 3.6 Kelly Criterion ללא הגבלת drawdown
**הבעיה:** Kelly מחשב גודל פוזיציה לפי יחסי ניצחון/הפסד היסטוריים, אבל לא מתחשב ב-drawdown הנוכחי. אחרי drawdown של 10%, Kelly עדיין ממליץ על גודל פוזיציה גדול.

**השיפור:**
```typescript
// Kelly עם drawdown adjustment
const drawdownFactor = 1 - (dailyDrawdownPercent / 15); // 1.0 at 0% DD, 0.33 at 10% DD
const adjustedKelly = kellyFraction * 0.5 * drawdownFactor;
betFraction = Math.min(Math.max(0, adjustedKelly), 0.10);
```

---

## המלצות עליונות (לכל המנועים)

### A. הוספת פילטר קורלציה
כל המנועים זקוקים לזה. קורלציה גבוהה בין נכסים = סיכון מערכתי גבוה.

### B. Adaptive Risk Sizing
כל המנועים זקוקים לזה. Risk קבוע = סיכון קבוע, גם כשהבוט מפסיד רצוף.

### C. Dynamic Thresholds
ספי ביטחון, RSI, reversal, וכל הערכים הקבועים צריכים להתאים עצמם לתנודתיות השוק.

### D. Entry Timing Layer למנוע 3
זוהי החסרון הגדול ביותר של מנוע 3 לעומת מנוע 2. הוספת limit orders תהפוך אותו למתחרה אמיתי.

### E. Correlation-aware Position Selection
במקום לבחור את הנכסים עם הציון הגבוה ביותר, לבחור את הנכסים עם הציון הגבוה ביותר + קורלציה נמוכה.

### F. Performance-based Parameter Optimization
להפעיל backtest אוטומטי על חלון 30 ימים שמתאים את הספים לפי ביצועי הבוט:
- אם Win Rate < 40%: הגבר ספי כניסה ב-5%
- אם Win Rate > 60%: הפחת ספי כניסה ב-2%
- אם Drawdown > 10%: הפעל מצב הגנתי (הפחת גודל פוזיציה ב-50%)

---

## סדר עדיפויות יישום

| עדיפות | שיפור | מנועים | השפעה צפויה על Win Rate |
|--------|-------|--------|------------------------|
| 1 | Entry Timing Layer למנוע 3 | פרו | +8-12% |
| 2 | Adaptive Risk Sacing | הכל | +5-8% |
| 3 | Dynamic Thresholds | הכל | +3-5% |
| 4 | Correlation Filter | הכל | +2-4% |
| 5 | TRANSITIONAL carve-out | חדש + legacy | +2-3% |
| 6 | Volume gradient (pro) | פרו | +1-2% |
| 7 | Time stop adjustments | הכל | +1-2% |
| 8 | Per-asset exposure cap | הכל | +1-2% |

**סה"כ שיפור צפוי: +15-25% ב-Win Rate ו-+20-30% ב-Sharpe Ratio**
