# מדריך ייחוס — שלושת בוטי הסימולציה

> קובץ זה נבנה ע"י קריאת הקוד עצמו (לא תיעוד קודם). כל שורה כאן מצוינת עם
> הקובץ שבו היא באמת קורית. עדכן אותו כשהחישוב עצמו משתנה — לא לפני.
> נכון לתאריך: 2026-09-06, מסביב לקומיטים עד `1c54229`.

שלושת הבוטים רצים כ-3 מופעים נפרדים לגמרי של אותה תשתית
(`server/simEngineFactory.ts` → `createGenericSimEngine`) — לכל אחד `cash`,
`positions`, `history` ו-KV store נפרדים ב-Firestore. **תוצאה של בוט אחד
לעולם לא יכולה להשפיע על בוט אחר** — הם חולקים רק קבועים (סף drawdown, תקרת
נכס בודד) ונתוני שוק (נרות), לא state.

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
LIQUIDITY → SPREAD → NO_SETUP → NO_ENTRY → COST → RISK
```
מיושם ב-`intradayEngine.ts:126` (`evaluateIntradayDecision`).

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
`MIN_CONFIDENCE` (`intradayAdapter.ts:361-368`). זהו **ציון (Score)**, לא
הסתברות — קנה מידה משותף ל-Pro, שונה מ-Path.

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
- **הזמנה מינימלית:** $5.

### יציאה (Stop/Target קבועים)
```
fixedSlPercent = 1.8%
fixedTpPercent = 3.0%
```
(`intradayRisk.ts:245-246`) — ה-"3%" הזה הוא **טייק-פרופיט**, לא תקרת הפסד.

### עוקף high-confidence (`intradayEngine.ts`)
אם `buildRiskPlan` נדחה **וגם** `confidence >= 72` → תוכנית fallback מינימלית
($5 בסיס). **לא** עוקף חסימת תקרת נכס בודד (בדיקת מחרוזת על הודעת הדחייה —
שביר, ראה הערה בקוד).

### מה תוצאה בריאה אמורה להיראות
- רוב הסימבולים: `NO_SETUP`/`NO_ENTRY` (זה תקין — הגנה נגד רעש).
- SIGNAL רק כשכל 11 השערים עברו + `confidence >= 60`.
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
מינימום הזמנה: $5.

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

## 3. מנוע נתיב 4H (Path · Empirical)

**קבצי מפתח:** `packages/engine/src/services/pathEngine.ts` (החלטה חיה),
`pathStudy.ts` (בניית/אימות טבלה), `pathSimExecution.ts` (הזמנות),
`server/pathSimEngine.ts` (rebuild + wiring).

### נתוני קלט נדרשים
```
PATH_MIN_H4_BARS  = 62   (ברי 4H סגורים, מתוכם 60 קודמים + 1 מתויג)
MIN_PATH_CANDLES  = 248  (= 62 × 4, ברי H1 הדרושים לצבור אותם)
M5                = 30 נרות מינימום (לאישור 5M)
```
מוגדר פעם אחת ב-`pathEngine.ts` (המנוע העמוק ביותר), מיוצא מחדש בכל מקום
אחר (`pathSimExecution.ts`, `pathAdapter.ts`) — כך שלא יכולה להיות סתירה
בין הדרישה של המנוע לזו של ה-gate שמחליט אם בכלל לקרוא לו.

### תיוג מצב (`labelBarState`, `pathStudy.ts`)
לכל בר 4H **סגור** (לא הבר הנוכחי): `regime` (TRENDING_UP / TRENDING_DOWN /
RANGING, מ-`detectMarketRegime`) × `fng` (Fear&Greed bucket). **`useFearGreed`
כפוי `false` בשני מקומות הקריאה** (`pathEngine.ts`, `server/pathSimEngine.ts`)
— כל הברים מתקפלים ל-`NEUTRAL` יחיד, בכוונה: מונע דליפת-עתיד (ה-Fear&Greed
"של היום" מוחל על ברים היסטוריים) מלהשפיע בפועל, גם אם `DEFAULT_USE_FEAR_GREED`
ישתנה בעתיד עבור המחקר האופליין.

### הטבלה (`table` — הליבה של הבוט)
נבנית ע"י `buildPathTable(outcomes, {minSamples})` (`pathStudy.ts:520`):
```
key = (regime, fng, slot∈[0,15], direction∈{LONG,SHORT})   ← עד 96 תאים אפשריים
כל תא נכנס לטבלה רק אם:
  1. group.length >= minSamples          (בשרת החי: 120 — LIVE_MIN_SAMPLES)
  2. bucket.expectedR > minExpectedR     (0.05 — MIN_EXPECTED_R)
```
**שני התנאים ביחד**, לכל תא בנפרד.

### שלושה מקורות טבלה אפשריים (`tableSource`, `server/pathSimEngine.ts`)
| מצב | איך מגיעים אליו | אמינות |
|---|---|---|
| `none` | לפני כל rebuild | — |
| `live-in-sample` | `rebuildTable()` כל 30 דק' (`TABLE_REBUILD_MS`), מהנרות שבזיכרון כרגע | **לא מאומת** — נבדק על אותם נתונים שנבנה מהם |
| `validated` | `POST /api/path-sim/table` (`scripts/pathStudy.ts publish`) | walk-forward, out-of-sample |

**המעבר ל-`validated` לא קורה לבד** — מישהו צריך להריץ `publish` עם
`WORKER_URL`+`BOT_ADMIN_TOKEN`. עד אז, ותמיד אחרי `rebuildTable()` הראשון,
`tableSource` נשאר `live-in-sample` לצמיתות.

### חישוב הביטחון (Probability, לא Score!)
```
confidence = round(bucket.pLow × 100)
```
`pLow` הוא **Wilson lower bound** על שיעור ההצלחה ההיסטורי של הדלי — לא ציון
משוקלל. סף כניסה: `BOT_PATH_MIN_CONFIDENCE` (env, כרגע **33**) — נמוך בכוונה,
כי יעד 1.5R צריך רק ~36% הצלחה כדי להיות רווחי. **אסור** להשתמש ב-
`BOT_MIN_CONFIDENCE` (60, סף ה-Score) עבור הבוט הזה — `simBotDefaults()`
אוכפת את זה (`simDefaults.ts`).

### גודל פוזיציה (Kelly, `pathEntryBudget`, `pathSimExecution.ts:83`)
```
budget = min(
  equity × pathKellyFraction(bucket),   ← half-Kelly על ה-pLow הנמדד
  ceiling (positionPercent × riskLevel multiplier),
  equity × 8%                            ← PER_ASSET_EXPOSURE_CAP_PERCENT
)
```

### יציאה
```
SL = entry ∓ 1R          (riskUnit = ATR של 15M לפני הבר)
TP = entry ± riskUnit × bucket.tpR   (בד"כ 1.5R)
תקרת החזקה: בר 4H אחד (PATH_MAX_HOLD_MS)
Time Stop: חצי בר בלי התקדמות >= 0.3R (PATH_TIME_STOP_MS)
```
Spot LONG בלבד — כל התוחלות נמדדות כעסקת ספוט עם סטופ של 1R.

### מעגל שבירה ותקרת נכס
זהה לשני הבוטים האחרים (8%/15% drawdown, 8% תקרת נכס) — מיושם ב-
`pathSimExecution.ts:generatePathOrders`.

### מה תוצאה בריאה אמורה להיראות
- כל עוד `tableSource: "live-in-sample"` **וגם** `buckets: 0` — הבוט
  **אמור** להראות `NO_SIGNAL [NO_BUCKET]` בכל מקום. זו לא תקלה, זו המנגנון
  עובד כמתוכנן ("נמנע במקום לנחש").
- `readiness: "warming-up"` → `"ok"` כשכל 53 המטבעות עברו את סף ה-248 H1.
- מספר הדגימות בכל תא אמור לגדול עם הזמן (uptime מצטבר, עד
  `MAX_CANDLES_PER_TF=600` ב-`marketDataService.ts`) — לא בקפיצה מיידית.
- הופעת buckets בפועל **לא** מעידה על קצה אמיתי כל עוד `source !== "validated"`.

---

## מה משותף בין שלושתם (ולמה אסור להתערבב)

| נושא | קבוע יחיד | קובץ מקור |
|---|---|---|
| Drawdown יומי | 8% | `intradayParams.ts` → `DAILY_DRAWDOWN_BLOCK_PERCENT` |
| Drawdown שבועי | 15% | `intradayParams.ts` → `WEEKLY_DRAWDOWN_LOCK_PERCENT` |
| תקרת נכס בודד | 8% | `intradayParams.ts` → `PER_ASSET_EXPOSURE_CAP_PERCENT` |
| מכפיל סיכון אדפטיבי | לפי streak הפסדים | `adaptiveRisk.ts` |
| Fill/Fee/Slippage | מנוע אחד | `simExecution.ts` |

כל אחד מהם **נמדד בנפרד** על ה-equity/positions/history של הבוט שלו בלבד
(`server/simEngineFactory.ts`) — משותף הוא רק הסף, לא המדידה.

## פערים ידועים, לא-קריטיים (לא תוקנו — לתעד בלבד)
- **Pro `PRO_COVERAGE_FULL_WEIGHT=88`** מול סכום משקלות בפועל **105** —
  לא נבדק לעומק אם זה מקדים coverage=1 בתקופת חימום. (`proAlgEngine.ts:116`)
- **Path sentiment leak** — קיים בקוד (`rebuildTable` מעביר Fear&Greed של
  "היום"), אך רדום כל עוד `useFearGreed=false` נשאר `false` בכל קריאה.
