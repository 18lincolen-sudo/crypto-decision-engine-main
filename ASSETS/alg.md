# אלגוריתם ההחלטה של הבוטים (סימולציה ומסחר אמיתי)

מסמך זה מתאר את כל שרשרת החישוב — מהנתונים הגולמיים ועד להחלטת כניסה/יציאה מהשקעה.

---

## 1. מקורות הנתונים

- `useCryptoData` — מחירים חיים, שינוי 24 שעות, נפח מסחר.
- `smartRecommendationEngine` — מנוע ההמלצות שמייצר לכל מטבע: `recommendation` (buy/sell/hold), `confidence`, `reasoning`, `riskLevel`, `timeframe` ואינדיקטורים.
- אינדיקטורים מחושבים: RSI(14), MA20, Bollinger Bands, MACD, Stochastic, Volume Profile, מגמת נפח, שינוי 24ש'.

---

## 2. מנוע ההמלצות — חישוב הביטחון

כל אינדיקטור מייצר "אות" עם משקל (weight) וביטחון פנימי:

| אינדיקטור | משקל |
|---|---|
| RSI | 15 |
| ממוצעים נעים (MA) | 15 |
| MACD | 18 |
| Bollinger Bands | 12 |
| Stochastic | 8 |
| Volume Profile | 15 |
| מגמת נפח | 10 |
| שינוי 24ש' / מומנטום | 12 |

### צבירת ניקוד

```text
weighted     = weight * (signalConfidence / 100)
buyScore    += weighted   (אם האות buy)
sellScore   += weighted   (אם האות sell)
holdScore   += weighted   (אם האות hold)
totalWeight += weight
```

### נוסחת הביטחון הסופית

```text
maxScore    = max(buyScore, sellScore, holdScore)
secondScore = הציון השני בגובהו

dominance = maxScore / totalWeight            // שליטה: איזה חלק מהמשקל תומך בצד המנצח
margin    = (maxScore - secondScore) / maxScore // מרווח מול הצד הנגדי
coverage  = min(1, totalWeight / 88)            // כיסוי: כמה אינדיקטורים סיפקו אות ברור

confidence = 50 + (dominance * 45 + margin * 25) * coverage - (1 - coverage) * 10
```

הביטחון מוגבל לטווח סביר ומוצג באחוזים. חוסר כיסוי (מעט אינדיקטורים) מוריד ביטחון; אות דומיננטי עם מרווח גדול מעלה ביטחון.

---

## 3. סף הביצוע של הבוט

```text
minConfidence = minConfidenceOverride > 0
              ? minConfidenceOverride       // סף ידני מההגדרות
              : CONFIDENCE_BY_RISK[riskLevel]
```

| רמת סיכון | סף ביטחון | הקצאה לעסקה (מההון ההתחלתי) |
|---|---|---|
| נמוכה (low) | 55% | 15% |
| בינונית (medium) | 40% | 25% |
| גבוהה (high) | 25% | 40% |

---

## 4. שכבת ההערכה (Single Source of Truth)

לכל המלצה מחושב `SignalEvaluation` — אותו אובייקט מזין גם את פאנל ההמלצות בממשק וגם את מנוע הביצוע, כך שאין פער בין מה שמוצג לבין מה שמבוצע.

סדר הבדיקות לקנייה (`buy`):

1. הבוט פעיל? אחרת — "הבוט מושבת".
2. יש כבר פקודה בתור לאותו מטבע? — "פקודה בתור ביצוע".
3. המטבע כבר מוחזק? — "כבר מוחזק בתיק".
4. `confidence >= minConfidence`? אחרת — "ביטחון נמוך מהסף".
5. יש סלוט פנוי? `maxPositions - openPositions - queuedBuys > 0`.
6. יש מחיר תקף?
7. תקציב: `budget = min(initialAmount * allocation, projectedCash)`, חייב `budget >= 5`.
8. אם הכול עבר → `willExecute = true`, סטטוס "מבצע קנייה".

לוגיקת מכירה (`sell`):
- אם המטבע לא מוחזק — אין פעולה (המערכת לא פותחת שורט).
- אם מוחזק והביטחון עובר את הסף — נשלחת פקודת מכירה לכל הפוזיציה.

ההמלצות ממוינות לפי ביטחון יורד, כך שהסלוטים והמזומן מוקצים קודם לאותות החזקים ביותר.

---

## 5. יציאות ניהול סיכון (עצמאיות מההמלצות)

בכל טיקט, לכל פוזיציה פתוחה:

```text
change% = (currentPrice - avgPrice) / avgPrice * 100

if change% <= -stopLoss    -> פקודת מכירה "Stop Loss"
if change% >=  takeProfit  -> פקודת מכירה "Take Profit"
```

ברירות מחדל: **Take Profit 3%**, **Stop Loss 4.2%**. יציאות אלו קודמות לכל איתות ומתבצעות גם אם ההמלצה עדיין "buy".

---

## 6. מנוע הביצוע — עמלות, החלקה והשהיה

פקודות לא מתבצעות מיידית: הן נכנסות לתור `pending` עם `executeAt = now + executionDelaySec`.

כשהזמן מגיע, המילוי מחושב לפי מחיר השוק **באותו רגע** (לא מחיר האיתות):

```text
fillPrice(buy)  = market * (1 + slippagePercent/100)   // תמיד לרעת הבוט
fillPrice(sell) = market * (1 - slippagePercent/100)

fee = grossValue * feePercent / 100                    // עמלת Taker בכל צד
```

- קנייה: `quantity = budget / fillPrice`, מהמזומן יורד `budget`, נרשמת `entryFee`.
- מכירה: `gross = quantity * fillPrice`, `net = gross - fee`,
  `pnl = net - (quantity * avgPrice) - entryFee`, `pnl% = pnl / costBasis * 100`.

עלות ההחלקה המצטברת נרשמת בנפרד מהעמלות ומוצגת בכרטיס "עלויות מסחר".

---

## 7. מחזור החיים והרציפות

- **דופק (Heartbeat)** כל 5 שניות: הערכה מחדש של האותות, עדכון Mark-to-Market של הפוזיציות, ורישום נקודת שווי תיק.
- **ספירה לאחור** מוצגת עד הטיקט הבא.
- **המשכיות**: כל המצב (מזומן, פוזיציות, עסקאות, תור פקודות, היסטוריה, עמלות) נשמר ב-`localStorage` תחת `simulation-bot-state-v1`; ההגדרות והסטטוס תחת `simulation-bot-config-v1` / `simulation-bot-status-v1`. הבוט ממשיך לרוץ אחרי רענון עד לפעולת השהיה או ביטול.

---

## 8. היסטוריית תיק ומדדי ביצוע

- **חוצץ ברזולוציה גבוהה**: נקודה כל 5 שניות (עד 720 נקודות).
- **חוצץ שעתי**: נקודה אחת לשעה (עד 720 שעות ≈ 30 יום).

לכל טווח נבחר (1D / 7D / 30D) מחושב:

```text
רווח/הפסד לתקופה = last.portfolio - first.portfolio
%                = change / first.portfolio * 100

רווח ממומש      = סכום ה-pnl של עסקאות שנסגרו בטווח
אחוז הצלחה      = (עסקאות עם pnl > 0) / (עסקאות סגורות בטווח) * 100

Max Drawdown:
  peak = 0
  for point in history(range):
      peak = max(peak, point.portfolio)
      dd   = peak - point.portfolio
      maxDd = max(maxDd, dd)
  maxDd% = maxDd / peakAtMaxDd * 100
```

---

## 9. בוט המסחר האמיתי — הבדלים

הבוט האמיתי (`advancedTradingService`) משתמש באותן המלצות וסף ביטחון, ובנוסף:

- **ניהול סיכון מורחב**: הפסד יומי מקסימלי, גודל פוזיציה מקסימלי, מספר פוזיציות פתוחות, תקופת צינון (cooldown) בין עסקאות באותו מטבע.
- **Trailing Stop** אופציונלי באחוז מוגדר.
- **Dynamic Position Sizing** — גודל הפוזיציה מותאם לתנודתיות הנכס.
- **מסננים**: ניתוח נפח, מדד Fear & Greed, סנטימנט ומצב שוק — כל אחד יכול לחסום עסקה גם כשהביטחון עובר את הסף.
- **ביצוע אמיתי** מול הבורסה (Bybit) עם פקודות SL/TP בצד הבורסה, ולא סימולציה של מילוי.
- מדדים נצברים: Win Rate, Profit Factor, Sharpe, Max Drawdown, זמן החזקה ממוצע, רצפי ניצחון/הפסד.

---

## 10. תרשים זרימה מקוצר

```text
נתוני שוק חיים
      ↓
אינדיקטורים (RSI, MA, MACD, BB, Stoch, Volume)
      ↓
ניקוד משוקלל → dominance / margin / coverage → confidence
      ↓
SignalEvaluation (סף ביטחון, סלוטים, מזומן, החזקה קיימת)
      ↓                          ↘
willExecute = true                willExecute = false → מוצג בפאנל עם סיבה
      ↓
תור פקודות (executionDelay)
      ↓
מילוי עם slippage + fee
      ↓
פוזיציה פתוחה → ניטור SL/TP בכל טיקט → יציאה
```
