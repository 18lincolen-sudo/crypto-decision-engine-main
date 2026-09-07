# מדריך ייחוס — ארבעת בוטי הסימולציה

> קובץ זה נבנה ע"י קריאת הקוד עצמו (לא תיעוד קודם). כל שורה כאן מצוינת עם
> הקובץ שבו היא באמת קורית. עדכן אותו כשהחישוב עצמו משתנה — לא לפני.
> נכון לתאריך: 2026-09-07, מסביב לקומיטים עד `e1ca516` + תוספת בוט 4 (Bybit).

ארבעת הבוטים רצים כ-4 מופעים נפרדים לגמרי של אותה תשתית
(`server/simEngineFactory.ts` → `createGenericSimEngine`) — לכל אחד `cash`,
`positions`, `history` ו-KV store נפרדים ב-Firestore. **תוצאה של בוט אחד
לעולם לא יכולה להשפיע על בוט אחר** — הם חולקים רק קבועים (סף drawdown, תקרת
נכס בודד) ונתוני שוק (נרות), לא state.

> **בוט 4 (Bybit · TrendBreakout) הוא סימולציה בלבד.** הוא לא מיועד לכסף אמיתי
> עד להחלטה נפרדת. נוסף כדי להשוות אותו מול שלושת האחרים ולבחור מי ראוי
> לקידום לבוט אמיתי.

---

## 1. בוט חדש (Intraday · Multi-Timeframe)

**קבצי מפתח:** `packages/engine/src/services/intradayEngine.ts` (אורקסטרטור),
`intradayRegime.ts` (1H), `intradaySetup.ts` (15M), `intradayEntry.ts` (5M),
`intradayRisk.ts` (עלות + גודל), `intradayParams.ts` (כל הספים).

### נתוני קלט נדרשים
| טיימפריים | מינימום | קובץ |
|---|---|---|
| H1 | 200 נרות | `intradayEngine.ts:142` |
| M15 | 300 נרות | `intradayEngine.ts:143` |
| M5 | 500 נרות | `intradayEngine.ts:144` |

מתחת לזה → `NO_DATA`, בלי חישוב בכלל.

### סדר השערים (§55, כל שער עוצר את הראשון שנכשל)
```
NO_DATA → CIRCUIT_BREAKER → EXPOSURE → NO_REGIME → VOLATILITY →
LIQUIDITY → SPREAD → NO_SETUP → NO_ENTRY → RISK → COST → DATA_MISMATCH
```
מיושם ב-`intradayEngine.ts:126` (`evaluateIntradayDecision`).

**RISK לפני COST** (שונה, 2026-09-07): `buildRiskPlan` מייצר את ה-Entry/SL/TP1
**הסופיים** (מודל אחוזים קבוע), ו-`evaluateCostEdge` + כל מספרי ה-R:R מחושבים
על אותם ה-levels בדיוק — **מקור אמת יחיד**. `DATA_MISMATCH` = שער חדש שעוצר
SIGNAL אם ניתוח העלות רץ על levels שונים מהפקודה (סטייה > `1e-8`), ומדפיס את שני
הסטים ללוג. אין fallback שמסתיר את זה.

### חישוב הביטחון
`confidence = round((setupScore + entryScore) / 2)` — ממוצע של שני ציונים
0–100 (`decisionEngine/adapters/intradayAdapter.ts:355`):
- **setupScore** — נבנה ב-`intradaySetup.ts` משקלול 5 גורמים: trend 0.25,
  momentum 0.20, location 0.20, participation 0.15, structure 0.20
  (`intradayParams.ts:209`). סף מינימלי: **46** (`setupScoreMin`).
- **entryScore** — נבנה ב-`intradayEntry.ts` (אישור 5M). סף מינימלי: **50**
  (`entryScoreMin`).

**סף תפעולי נוסף**, מעל שני אלה: `BOT_MIN_CONFIDENCE` (env, כרגע **60**) —
נבדק **אחרי** שהמנוע כבר אישר SIGNAL; אם `confidence < 60` הדחייה מתויגת
`MIN_CONFIDENCE` (`intradayAdapter.ts:361-368`). זהו **ציון (Score)** 0–100 —
קנה מידה משותף לכל ארבעת הבוטים (מאז שמנוע ה-probability של נתיב 4H הוחלף).

### מעגל שבירה (Circuit Breaker) — שער 2
```
p.dailyDrawdownPercent  >= 8   → NO_SIGNAL (חסימת כניסות חדשות)
p.weeklyDrawdownPercent >= 15  → NO_SIGNAL (נעילה)
```
קבועים יחידים: `DAILY_DRAWDOWN_BLOCK_PERCENT` / `WEEKLY_DRAWDOWN_LOCK_PERCENT`
ב-`intradayParams.ts:195-196` — משותפים ל-3 הבוטים כולם (מיובאים, לא
מוקלדים מחדש).

### גודל פוזיציה וסיכון (`intradayRisk.ts` — `buildRiskPlan`)
- **סיכון לעסקה:** `riskUsd = equity × 0.5% × sizingMultiplier` (adaptive,
  יורד לפי הפסדים אחרונים, לעולם לא עולה מעל 1).
- **תקרת FUTURES:** מרג'ין ≤ `equity × 4%`, מינוף ≤ **5x**.
- **תקרת SPOT:** נוציונל ≤ `equity × 15%`.
- **תקרת חשיפה ממונפת כוללת:** `equity × 20%`.
- **תקרת נכס בודד (רק FUTURES):** `equity × 8%` — `PER_ASSET_EXPOSURE_CAP_PERCENT`
  ב-`intradayParams.ts` (משותף גם ל-Pro/Path, ראה שם). **לא חל על SPOT.**
- **הזמנה מינימלית:** בסימולציה **$100** — `SIM_INTRADAY_PARAMS_OVERRIDE.minOrderUsd`
  ב-`simExecution.ts` (בקשת מפעיל). `buildRiskPlan` מעגל פוזיציה קטנה מ-$100
  כלפי מעלה לסף; `generateNewOrders` הוא backstop שמעגל שוב אם צריך (מזומן +
  equity ≥ $100). (לבוט האמיתי הסף נשאר $5 — `DEFAULT_INTRADAY_PARAMS.minOrderUsd`.)

### יציאה (Stop/Target קבועים) — זו האסטרטגיה, לא מבנה
```
FIXED_SL_PERCENT = 1.8%   (מרחק הסטופ מ-entry)
FIXED_TP_PERCENT = 3.0%   (מרחק TP1 מ-entry) → gross R:R = 3.0/1.8 ≈ 1.667
```
קבועים יחידים ב-`intradayRisk.ts` (משותפים ל-`buildRiskPlan` ול-fallback).
ה-"3%" הוא **טייק-פרופיט**, לא תקרת הפסד.

`RiskPlanInput.stopReference` / `targetReference` הם **טלמטריה בלבד** — נכנסים
ליומן ההחלטה ולסקורינג של ה-setup/entry, אבל `buildRiskPlan` **מתעלם מהם**
לחישוב ה-levels. אם אי-פעם רוצים סטופ מבני — זה שינוי אסטרטגיה מכוון, במקום
אחד (`buildRiskPlan`), ו-`validateLevelDirection` תופס סטופ/TP בצד הלא נכון.

**R:R** מחושב תמיד מ-3 המספרים של `buildRiskPlan`:
```
riskPercent   = |entry - stopLoss|   / entry * 100
rewardPercent = |takeProfit1 - entry| / entry * 100
grossRR       = rewardPercent / riskPercent
netRR         = (rewardPercent - totalCostPercent) / riskPercent
```
כל SIGNAL מדפיס שורת `SIGNAL_LEVELS ENTRY=.. SL=.. TP1=.. RISK%=.. REWARD%=..
GROSS_RR=.. ENTRY_FEE%=.. EXIT_FEE%=.. SLIPPAGE%=.. TOTAL_COST%=.. NET_RR=..`
לאימות ידני.

### עוקף high-confidence (`intradayEngine.ts`)
אם `buildRiskPlan` נדחה **וגם** `confidence >= 72` → תוכנית fallback מינימלית
($5 בסיס). **לא** עוקף חסימת תקרת נכס בודד (בדיקת מחרוזת על הודעת הדחייה —
שביר, ראה הערה בקוד).

### מה תוצאה בריאה אמורה להיראות
- רוב הסימבולים: `NO_SETUP`/`NO_ENTRY` (זה תקין — הגנה נגד רעש).
- SIGNAL רק כשכל 12 השערים עברו + `confidence >= 60`.
- Drawdown יומי/שבועי אף פעם לא אמור לחרוג מ-8%/15% — אם קורה, הבוט **חייב**
  להפסיק לפתוח (לא לסגור פוזיציות קיימות).
- אין פוזיציה שחורגת מ-8% מההון בנכס בודד (futures) או 15% (spot).

---

## 2. בוט פרו (Pro · alg.md מדויק)

**קבצי מפתח:** `packages/engine/src/services/proAlgEngine.ts` (סיגנל + סף +
הקצאה), `proSimExecution.ts` (שערים + הזמנות).

### נתוני קלט נדרשים
`MIN_PRO_CANDLES = 40` (`proAlgEngine.ts:465`) — נמוך משמעותית מ-Intraday,
כי Pro לא בונה רג'ים רב-טיימפריים.

### חישוב הביטחון (Score 0–100)
8 אינדיקטורים משוקללים (`§2`, `proAlgEngine.ts`):
```
RSI 15 · MA 15 · MACD 18 · Bollinger 12 · Stochastic 8 ·
Volume Profile 15 · Volume Trend 10 · שינוי 24h 12   (סה"כ משקל = 105)
```
`confidence = dominance × margin × coverage`, כאשר
`coverage = min(1, totalWeight / PRO_COVERAGE_FULL_WEIGHT)` ו-
`PRO_COVERAGE_FULL_WEIGHT = 88` (**לא** 105 — ראה סעיף פערים בתחתית).

### סף כניסה
**שטוח, 70**, בלי קשר ל-riskLevel (`PRO_DEFAULT_ENTRY_CONFIDENCE`,
`proAlgEngine.ts:419`). טבלת `PRO_CONFIDENCE_BY_RISK` (55/40/25 לפי
low/medium/high) קיימת כ**רפרנס בלבד** — `proMinConfidence()` מתעלמת ממנה
במפורש (`void riskLevel`). `minConfidenceOverride > 0` (הגדרת מפעיל/env)
מחליף את ה-70 לגמרי.

### שערי כניסה (§4, `applyProEntryGates` ב-`proSimExecution.ts:161`)
```
1. הבוט פעיל?  2. ORDER_QUEUED  3. ALREADY_HELD  4. BELOW_THRESHOLD
5. NO_SLOTS (occupiedSlots >= maxPositions)  6. NO_PRICE  7. NO_BUDGET
```
מוערך פעם אחת, על אצווה ממוינת ביטחון-יורד — כך שהסלוטים/המזומן מוקצים
לאיתותים החזקים קודם.

### גודל פוזיציה (§4 gate 7)
```
budget = min(
  initialAmount × (confidence > 80 ? 15% : 10%),   ← proAllocationPercent()
  projectedCash,
  equity × 8%                                       ← PER_ASSET_EXPOSURE_CAP_PERCENT
)
```
טבלת `PRO_ALLOCATION_BY_RISK` **הוסרה** (הייתה קוד מת — אף gate לא קרא לה).
מינימום הזמנה בסימולציה: **$100** (`MIN_SIM_ENTRY_USD`) — budget מתחת לזה
**מעוגל כלפי מעלה ל-$100** אם יש מזומן פנוי ו-equity ≥ $100 (עלול לחרוג
מתקרת ה-8% לנכס בודד — פשרה מקובלת ל"מינימום $100 תמיד"); `NO_SIGNAL
[NO_BUDGET]` רק כשאין $100 מזומן פנוי. חל על כל ארבעת בוטי הסימולציה.

### כניסה — Market או Limit (§6, `proSimEngine.ts` config `proLimitEntries`)
- **Market (ברירת מחדל §6):** מילוי מיידי ב-`executeAt`, במחיר שוק + slippage.
- **Limit (כשמופעל):** מנוחה במחיר "אופטימלי" (`calculateOptimalEntryPrice`
  — ממוצע משוקלל של Bollinger lower/MA20/VAL/POC/מחיר×0.99), ממתין שהשוק
  יגיע אליו או טוב יותר. פג תוקף אחרי `LIMIT_ORDER_TTL_MS` (2 שעות בסימולציה)
  אם אף פעם לא נחצה. **מעוגל לפי סדר גודל המחיר** (`roundToPriceScale`,
  `tradeEngine.ts`) — לא `.toFixed(2)` קבוע, אחרת נכס תת-סנט מתעגל לשגיאה.

### יציאה
```
Stop Loss  = -4.2%   (PRO_STOP_LOSS_PERCENT)
Take Profit = +3.0%  (PRO_TAKE_PROFIT_PERCENT)
+ Flip-to-SELL: אם מגיע איתות SELL בביטחון >= סף — סוגר את כל הפוזיציה
```
Spot בלבד — אין שורט, SELL על פוזיציה לא-מוחזקת מוצג בלבד.

### מעגל שבירה
זהה ל-Intraday (8%/15%), אבל **מיושם בקובץ שונה** — `proSimEngine.ts`
(לפני שהאיתותים מגיעים ל-gates), ולא בתוך `proAlgEngine.ts` עצמו. הקבועים
משותפים (`intradayParams.ts`), המימוש נפרד.

### מה תוצאה בריאה אמורה להיראות
- ביטחון מוצג הוא **Score**, לא הסתברות — 70% אומר "70 מתוך 100 בציון
  משוקלל", לא "70% סיכוי להצליח".
- אם `proLimitEntries=true`: לצפות להרבה `ORDER_QUEUED` שלא ממלאים מיד —
  זה תקין, לא תקוע, כל עוד לא עברו 2 שעות.
- שינוי `riskLevel` בממשק **לא אמור** לשנות תדירות כניסה או גודל פוזיציה —
  זו החלטת מוצר מתועדת, לא באג.

---

## 3. נתיב 4H (Prev-4H Range · טווח נר קודם)

> **החליף את מנוע ה-Empirical Path.** הבקטסט של המשתמש
> (`ASSETS/path-slot-study33/diagnostic.json`, 4.9M תוצאות) הראה **0 דליים עם
> תוחלת חיובית אחרי עלויות** בכל regime — הקצה (~0.05R) קטן פי 5–10 מעלות
> ה-round-trip (~0.28R). מודל הדליים, הטבלה, `/api/path-sim/table`
> ו-`installValidatedTable` הוסרו. `pathEngine.ts`/`pathStudy.ts`/
> `scripts/pathStudy.ts` נשארו על הדיסק (מספקים `aggregateToH4` וכו') אבל
> **אף בוט לא קורא להם יותר**. סימולציה בלבד.

**קבצי מפתח:** `packages/engine/src/services/prev4hRange.ts` (הסיגנל),
`prev4hRangeExecution.ts` (גודל + יציאות), `server/pathSimEngine.ts` (חיבור).

### נתוני קלט נדרשים
```
PREV4H_MIN_H4_BARS   = 24   (ברי 4H מלאים — ל-EMA20 + מרווח)
PREV4H_MIN_H1_CANDLES = 96  (= 24 × 4; aggregateToH4 פולט בר רק כשכל 4 ה-H1 נסגרו)
```
`prev = h4[last]` הוא הבר ה-4H ה**אחרון שנסגר לגמרי** — אין lookahead.

### חלון וזיהוי
```
H = prev.high · L = prev.low · mid = (H+L)/2 · range = H−L · rangePct = range/prev.close
```
פועלים רק כש-`barOpenFor(now) === prev.timestamp + BAR_MS` (החלון שמיד אחרי
`prev`). נתוני H1 לא עדכניים → `STALE_BAR`. פוזיציה אחת לסימבול לכל חלון.

### פילטר מגמה (§4)
`ema = EMA(20)` על סגירות ה-4H (`calculateEMA`, `tradeEngine.ts`).
`trendUp = ema>emaPrev AND prev.close>ema` · `trendDown` = המראה. אף אחד →
`AGAINST_TREND` (אין עסקה).

### פילטר טווח
`rangePct` חייב להיות ב-`[minRangePct 0.005, maxRangePct 0.08]` — אחרת
`RANGE_TOO_TIGHT` / `RANGE_TOO_WIDE`.

### סיגנל (פריצה)
`trendUp AND live > H` → **LONG** (`SPOT`). `trendDown AND live < L` → **SHORT**
(`FUTURES` מינוף 1x — spot לא יכול לשרטט). אחרת `NO_BREAKOUT` (מצב `ARMED`).

### חישוב הביטחון (Score 0–100 — לא הסתברות!)
```
40 + 30·clamp(breakoutDist/(range·0.5)) + 20·trendStrength + 10·rangeSweetSpot
```
סף כניסה `minConfidence = 55` (`SIM_BOTS.path.minConfidence`). **קנה מידה
משותף ל-Intraday/Pro/Bybit** — `BOT_MIN_CONFIDENCE` מגיע אליו עכשיו כמו לשאר
(מנוע ה-Wilson/probability הישן נעלם).

### גודל פוזיציה
```
riskUsd  = equity × riskPerTrade (0.5%)
notional = riskUsd / (R/entry)          ← R = |entry − mid| = range/2
נחתך ב: נכס בודד 8% · חשיפה כוללת 20% (MAX_TOTAL_EXPOSURE_PERCENT) · רצפת $100 (MIN_SIM_ENTRY_USD)
```
פוזיציה אחת לסימבול, בלי scale-in.

### יציאה
```
SL = mid (אמצע הטווח)
TP = H + range×tpRangeMult (LONG) / L − range×tpRangeMult (SHORT)   [ברירת מחדל ×1 → ~2:1]
Time stop: סוף החלון — now >= barOpenFor(openTimestamp) + BAR_MS
היפוך: EMA20 (4H) כבר לא בכיוון הפוזיציה
```

### מעגל שבירה ותקרת נכס
זהה לשלושת האחרים (8%/15% drawdown, 8% תקרת נכס) — ב-
`generatePrev4hRangeOrders`.

### מה תוצאה בריאה אמורה להיראות
- רוב הסימבולים: `NO_SIGNAL [AGAINST_TREND]` או `[NO_BREAKOUT]` — תקין,
  צריך מגמה **וגם** פריצה **וגם** טווח בתחום.
- כל `NO_SIGNAL` נושא סיבה: `STALE_BAR`, `AGAINST_TREND`, `RANGE_TOO_TIGHT`,
  `RANGE_TOO_WIDE`, `NO_BREAKOUT`, `CONFIDENCE_BELOW_MIN`.
- כל פוזיציה נסגרת לכל המאוחר בסוף נר ה-4H שבו נפתחה.

---

## 4. בוט Bybit (TrendBreakout · פריצת מגמה) — סימולציה בלבד

**קבצי מפתח:** `packages/engine/src/services/trendBreakout.ts` (הסיגנל),
`packages/engine/src/services/trendBreakoutExecution.ts` (גודל, scale-in,
ניהול סטופ, יציאות), `server/bybitSimEngine.ts` (חיבור לתשתית),
`TRENDBREAKOUT_SPEC.md` (המפרט המלא של המשתמש).

**אסטרטגיה עצמאית לחלוטין** — לא קונצנזוס של Intraday/Pro/Path ולא משתמשת
בסיגנלים שלהם. חולקת רק נתוני שוק, מנוע המילוי, הקבועים המשותפים ותשתית
הסימולציה.

### נתוני קלט
H1 ≥ 200 · M15 ≥ 300 · M5 ≥ 30 (מובטח ע"י ה-READY של ה-MTF snapshot). רק נרות
**סגורים** — אין lookahead.

### מגמה (H1, §3)
LONG רק אם: Supertrend(10,3) = BULL **וגם** EMA50 > EMA200 **וגם** close > EMA50.
SHORT = המראה. אחרת NEUTRAL → אין עסקה.

### פריצה (M15, §4)
close > Donchian-High(20) הקודם (LONG) / < Donchian-Low(20) (SHORT), **וגם**
נפח ≥ VolumeSMA(20) × 1.2, **וגם** כיוון = מגמת H1.

### אישור כניסה (M5, §5)
LONG: EMA9 > EMA21 **וגם** close > EMA9 **וגם** המחיר במרחק ≤ 1.0×ATR(M5)
ממחיר הפריצה (אחרת `ENTRY_TOO_EXTENDED` — לא רודפים).

### ביטחון (Score 0–100, §7)
H1 Supertrend 25 · H1 EMA 20 · פריצת M15 25 · אישור נפח 15 · אישור M5 15.
סף כניסה `MIN_CONFIDENCE = 70`. זהו **Score**, לא הסתברות — קנה מידה משותף
ל-Intraday/Pro, שונה מ-Path.

### גודל פוזיציה (§14 + §15)
`riskUsd = equity × 0.5%` ; `fullNotional = riskUsd / (|entry−SL| / entry)`.
נחתך קשיח ע"י התקרות המשותפות: נכס בודד ≤ 8% מ-equity
(`PER_ASSET_EXPOSURE_CAP_PERCENT`), חשיפה כוללת ≤ 20%
(`MAX_TOTAL_EXPOSURE_PERCENT`, `trendBreakoutExecution.ts`). **מכיוון שה-SL
הדוק (1.5×ATR(M15)), תקרת ה-8% היא לרוב האילוץ הכובל — וזה מכוון.**

### Scale-in (§11) — מודל lots
`fillDueOrders` לא יודע להוסיף לפוזיציה, לכן כל scale הוא `SimPosition` נפרד.
עסקה לוגית אחת = כל ה-lots עם אותו נכס-בסיס + כיוון, אותו SL/TP לוגי, נסגרים
יחד. לוטים 50/30/20% מ-`fullNotional`. SCALE_2 רק מעל +0.5R + מגמה תקפה;
SCALE_3 רק מעל +1.0R + Supertrend עדיין בכיוון. אף פעם לא מוסיפים בהפסד
(אין מרטינגייל / averaging-down). SCALE_1 מעוגל כלפי מעלה ל-`MIN_SIM_ENTRY_USD`
($100) אם צריך; SCALE_2/3 שנחתכים מתחת ל-$100 פשוט מדולגים (עיגול היה שובר
את יחס ה-50/30/20).

### ניהול סטופ (§12) — מחושב מחדש בכל tick
מ-entry קבוע + ה-highest/lowest ש-factory כבר עוקב אחריו (הקוד אף פעם לא
משנה את `pos.stopLoss`). ב-+1R → סטופ אפקטיבי = entry (break-even). ב-+1.5R →
טריילינג `extreme ∓ 1.0×ATR(M15)`, מונוטוני בכיוון הרווח, לעולם לא מתרופף.

### יציאות (§13)
סטופ אפקטיבי נחצה · TP (2R) · היפוך H1 Supertrend נגד הפוזיציה · Time Stop
אחרי 24 נרות H1. setup שהתבטל → חוסם scale-in נוסף, לא סוגר.

### SHORT
בסימולציה אי-אפשר לשרטט ב-SPOT, לכן SHORT = `FUTURES` במינוף **1x**
(מתנהג כמו ספוט הפוך; כל התקרות חלות). `SIM_BOTS.bybit.maxFuturesPositions = 3`
(ו-`path` = 2) — בניגוד ל-Pro שהוא 0.

### מעגל שבירה
זהה לשלושת האחרים (8%/15% על ה-equity של הבוט עצמו), מיושם ב-
`generateTrendBreakoutOrders` (יציאות בלבד כשמופעל).

### מה תוצאה בריאה אמורה להיראות
- רוב הסימבולים: `NO_SIGNAL [H1_TREND_NEUTRAL]` או `[BREAKOUT_NOT_CONFIRMED]` —
  תקין, המנוע דורש מגמה **וגם** פריצה **וגם** נפח **וגם** אישור M5.
- כל `NO_SIGNAL` נושא סיבה מפורשת (§22): `VOLUME_TOO_LOW`,
  `M5_CONFIRMATION_FAILED`, `ENTRY_TOO_EXTENDED`, `CONFIDENCE_BELOW_MIN`.
- פוזיציה יחידה עשויה להופיע כ-1–3 lots (scale-in) — לא באג.

---

## מה משותף בין ארבעתם (ולמה אסור להתערבב)

| נושא | קבוע יחיד | קובץ מקור |
|---|---|---|
| Drawdown יומי | 8% | `intradayParams.ts` → `DAILY_DRAWDOWN_BLOCK_PERCENT` |
| Drawdown שבועי | 15% | `intradayParams.ts` → `WEEKLY_DRAWDOWN_LOCK_PERCENT` |
| תקרת נכס בודד | 8% | `intradayParams.ts` → `PER_ASSET_EXPOSURE_CAP_PERCENT` |
| מכפיל סיכון אדפטיבי | לפי streak הפסדים | `adaptiveRisk.ts` |
| Fill/Fee/Slippage/Funding | מנוע אחד | `simExecution.ts` |

כל אחד מהם **נמדד בנפרד** על ה-equity/positions/history של הבוט שלו בלבד
(`server/simEngineFactory.ts`) — משותף הוא רק הסף, לא המדידה.

### Funding (נוסף עם בוט 4, חל על כל ארבעתם)
`applyFundingAccrual` (`simExecution.ts`) מנוכה בכל tick ב-`simEngineFactory.ts`
לפני חישוב ה-equity, על פוזיציות **FUTURES** פתוחות בלבד:
`notional × lastFundingRate × (elapsed / 8h)`. LONG משלם כשהריבית חיובית,
SHORT מקבל. חלון הצבירה חסום ל-8 שעות כדי שהשבתת worker ארוכה לא תחייב סכום
חד-פעמי. Pro ו-Path הם spot בלבד → `totalFunding = 0` בפועל; רק פוזיציות
ה-futures של Intraday והשורטים של Bybit מרגישים את זה. זהו תיקון מודל-עלויות
אחיד — לא שינוי באלגוריתם של אף מנוע.

## פערים ידועים, לא-קריטיים (לא תוקנו — לתעד בלבד)
- **Pro `PRO_COVERAGE_FULL_WEIGHT=88`** מול סכום משקלות בפועל **105** —
  לא נבדק לעומק אם זה מקדים coverage=1 בתקופת חימום. (`proAlgEngine.ts:116`)
- **`scripts/pathStudy.ts` + `pathEngine.ts`/`pathStudy.ts`** — נשארו בקוד
  (מיוצאים מ-`@cde/engine/analysis`, מסופקים ל-`aggregateToH4` ולבקטסטים) אך
  **אף בוט לא סוחר לפיהם יותר** מאז שנתיב 4H עבר ל-Prev-4H Range.
- **Prev-4H Range** — פילטר מגמת EMA20 בלבד; אין הוכחה לקצה אחרי עלויות
  (פריצות 4H מאובררות היטב). נוסף כ**עמית השוואה**, לא כהמלצה.
