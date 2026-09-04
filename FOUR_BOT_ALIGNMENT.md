# יישור ארכיטקטורת ארבעת בוטי הסימולציה — נקודת שמירה

קובץ זיכרון למשימה. אם העבודה נקטעה, כאן כתוב מה נעשה, מה נבדק, ומה נשאר פתוח.

**סטטוס:** הושלם. 403 בדיקות עוברות, שני טייפצ'קים נקיים, ESLint 0 שגיאות, שני ה-builds עוברים.

---

## 1. הבעיה ששיטת התיקון תוקנה בה

הבוט הרביעי (Empirical Path 4H) הוצג ב-UI כשווה בין שווים, בזמן ששמונה חישובי
aggregation עדיין קראו `intraday + legacy + pro`. אף בדיקה לא נכשלה — מד סיכון
שמשמיט מנוע נראה בדיוק כמו מד סיכון שאין לו מה לדווח. זו הסיבה שהתיקון כולל
בדיקות ולא רק קוד.

---

## 2. קבצים ששונו

### חדשים

| קובץ | תפקיד |
|---|---|
| `src/lib/botAggregation.ts` | כל האריתמטיקה המשולבת. מחוץ לקומפוננטת React כי אין jsdom בפרויקט — וזה בדיוק החלק שהיה שגוי. |
| `src/__tests__/fourBotIntegration.test.ts` | Tests 1-6, 11 + רצפת הביטחון של Path (23 בדיקות). |
| `src/__tests__/thresholdSourceOfTruth.test.ts` | Tests 7-10 (17 בדיקות). |

### שונו

| קובץ | מה השתנה |
|---|---|
| `packages/engine/src/services/tradeEngine.ts` | `LEGACY_SPOT_BASE_THRESHOLD = 58` ו-`LEGACY_FUTURES_BASE_THRESHOLD = 70` מיוצאים. סף ה-Spot הפך דינמי. שני `< 72` בענפי הטלמטריה הוחלפו ב-`futuresThreshold`. הערות שסתרו את הקוד תוקנו. |
| `packages/engine/src/services/proAlgEngine.ts` | `PRO_SPOT_BASE_THRESHOLD = 60`, `PRO_FUTURES_BASE_THRESHOLD = 72` מיוצאים. כל ה-routing עבר ל-`routingConfidence` (אחרי קנסות). |
| `packages/engine/src/services/pathEngine.ts` | `minConfidence?` אופציונלי ב-`PathDecisionInput`, מוחל על ה-`pLow` של הדלי. |
| `packages/engine/src/{analysis,execution}.ts` | ייצוא הקבועים החוצה. |
| `server/{legacy,pro,}SimEngine.ts` | ה-58/58/52 הוגדרו פעמיים בכל קובץ; הפכו לקבוע אחד. |
| `server/pathSimEngine.ts` | `PATH_MIN_CONFIDENCE = 33` מוגדר פעם אחת, ו-`minConfidenceOverride` מועבר סוף-סוף למנוע. |
| `src/contexts/PathSimulationBotContext.tsx` | מפתח ה-cache מיוצא; `hasServerData` נוסף. |
| `src/components/trading/PortfolioRiskMeter.tsx` | `unavailableEngines` + באנר "נתונים חסרים". |
| `src/pages/SimulationBot.tsx` | `allBots` במקום שמונה סכומים; כל הטקסטים; הספים נקראים מהמנועים. |

---

## 3. ספים — המצב הסופי

```
Legacy Spot
  Base:              58   (LEGACY_SPOT_BASE_THRESHOLD, tradeEngine.ts)
  Dynamic mechanism: dynamicConfidenceThreshold(base, atrPercent)
                     שטוח עד ATR 4%, ‎+15 נק׳ לינארית עד ATR 8%, מקסימום 73

Legacy Futures
  Base:              70   (LEGACY_FUTURES_BASE_THRESHOLD) — היה 72
  Dynamic mechanism: אותו מנגנון בדיוק, מקסימום 85

Pro Spot
  Base:              60   (PRO_SPOT_BASE_THRESHOLD, proAlgEngine.ts)
  Dynamic mechanism: אותה נוסחה, מקסימום 75

Pro Futures
  Base:              72   (PRO_FUTURES_BASE_THRESHOLD) — נשאר 72 לפי alg.md
  Dynamic mechanism: אותה נוסחה, מקסימום 87

Pro minimum confidence
  מקור ההחלטה:       signal.confidence (אחרי קנסות)
  Override:          config.minConfidenceOverride, מוחל ב-ProAdapter.normalize
  ברירת מחדל:        58

Path minimum confidence
  מקור ההחלטה:       bucket.pLow × 100 (הסתברות, לא ציון)
  Override:          config.minConfidenceOverride → PathDecisionInput.minConfidence
  ברירת מחדל:        33 (PATH_MIN_CONFIDENCE)
```

Legacy ו-Pro **מותר** להם לחלוק ספים שונים — הם שני אלגוריתמים. מה שאסור הוא
עותק שני של אחד מהמספרים ב-UI או ב-worker, וזה מה שהוסר.

---

## 4. שלושת הפגמים שתוקנו במנועים

1. **סף ה-Spot של Legacy היה קבוע 58** בזמן שסף ה-Futures טיפס עם ה-ATR. תנודתיות
   הידקה רגל אחת והשאירה את השנייה במקום, כך שכל אות שהתנודתיות דחפה מחוץ לטווח
   ה-Futures נחת על רף Spot שלא זז.
2. **סף ה-Futures של Legacy היה 72** בזמן שההערה מעליו כבר תיעדה `base 70`. הקוד
   סתר את התיאור של עצמו.
3. **Pro ניתב על `rawConfidence`** בזמן שה-adapter חסם על `confidence` שאחרי
   הקנסות — ואז הדפיס את המספר שאחרי הקנסות במחרוזת האישור של החלטה שהמספר הגולמי
   קיבל. עכשיו `routingConfidence` הוא המספר היחיד, וה-log אומר את האמת.

---

## 5. מה שנמצא ולא היה בהוראות

**§13 לא מדויק.** `minConfidenceOverride` של Pro **כן** משפיע — `ProAdapter.normalize`
מיישם אותו (שורה ~477). הבוט שבו הפקד באמת היה מת הוא **Path**: שלושת האחרים
מעבירים את הרצפה דרך `DecisionContext.config` לאדפטרים, ו-Path קורא ל-
`evaluatePathDecision` ישירות. הפאנל הציג רצפת ביטחון שאפשר לערוך ושום החלטה לא
קראה. תוקן לפי הכלל הכללי של §13, בתוך הלוגיקה של Path עצמו.

---

## 6. נשאר פתוח — לא הוסתר

1. **`softTrendBase` ב-Legacy (65) אינו עובר דרך ה-ramp** — `Math.max(spotThreshold, 65)`
   ולא `Math.max(spotThreshold, dynamic(65, atr))`. הסף הדינמי עוקף אותו מ-ATR ‎5.9%
   ומעלה, ולכן ההתנהגות שמרנית; אבל זו אי-עקביות. שינוי כאן הוא שינוי
   אסטרטגיה ולא בוצע.
2. **Entry timing ב-Pro עדיין קורא `rawConfidence`** (`proAdapter.ts:~205`, מוזן
   ל-`calculateProOptimalEntry`). §11 מנה ארבעה שימושים ו-entry timing אינו אחד
   מהם, ולכן הושאר.
3. **ברירות המחדל של הפרונט ‎`minConfidenceOverride: 58`** ב-
   `LegacySimulationBotContext.tsx:40` / `ProSimulationBotContext.tsx:43`, ו-
   `?? 58` בשורה 236, משכפלות את ברירות המחדל של ה-worker. הן נדרסות מהשרת
   בפולינג הראשון, והפרונט לא יכול לייבא מ-`server/`. לא תוקן — דורש החלטה על
   endpoint שמחזיר קונפיגורציה לפני הרינדור הראשון.
4. **`tradeEngine.ts` — עקיפת סף האות המעגלית** שסומנה בסבב קודם עדיין שם.
5. **`abBacktest.ts` עדיין ללא מנוע `intraday`**, ולכן שינויי ה-intraday לא נמדדו.

---

## 7. פריסה

הבוטים מחושבים בצד השרת. שינוי במנוע דורש **גם Render (worker) וגם Netlify**.

---

# סבב 2 — Shared Config + Intraday Backtest Parity

**סטטוס:** הושלם. 416 בדיקות, שני טייפצ'קים, ESLint 0 שגיאות, שני builds.

## 3. מקור אחד לברירות המחדל

`packages/engine/src/services/simDefaults.ts` — מודול חדש שגם ה-worker וגם הפרונט
צורכים דרך `@cde/engine/execution`:

```
                 simDefaults.ts
                  ├── server/tradingWorker.ts  (+ שכבת env מעל)
                  ├── server/{legacy,pro,path,}SimEngine.ts
                  └── src/contexts/*SimulationBotContext.tsx
```

`SIM_MIN_CONFIDENCE = { intraday: 52, legacy: 58, pro: 58, path: 33 }`,
`SIM_MAX_FUTURES_POSITIONS`, `SIM_BASE_DEFAULTS`, `simBotDefaults(id)`.

### מה שנמצא תוך כדי — פקד שמשקר

`ProSimulationBotContext.tsx:224` ו-`useProSimulationBot.ts:580` הציגו
**`minConfidence: 60`** בזמן שהמנוע חוסם על **58**. הקונפיג תוקן ל-58 בסבב קודם
וה-fallback של התצוגה נשאר מאחור. הפאנל פרסם סף הדוק בשתי נקודות מזה שבאמת דחה
עסקאות. כל שבעת ה-fallbacks של התצוגה קוראים עכשיו מ-`SIM_MIN_CONFIDENCE`.

### מה שלא נסגר — לא הומצא פתרון

ה-worker קורא `BOT_MIN_CONFIDENCE`, `BOT_POSITION_PERCENT`,
`BOT_MAX_OPEN_POSITIONS`, `BOT_RISK_LEVEL` מהסביבה ומניח אותם **מעל** הבסיס
המשותף. הדפדפן לא רואה משתני סביבה. לכן מה שמוצג לפני הפולינג הראשון הוא הבסיס,
לא בהכרח מה שה-worker מריץ בפועל.

**נדרש config bootstrap endpoint** שהפרונט קורא באתחול. לא מומש — זה מקרה
"ה-default תלוי runtime" מההוראות.

## 5. Intraday ב-abBacktest

`EngineType` = `'legacy' | 'pro' | 'intraday'`.

**שני קבצי snapshot בכוונה.** Intraday דורש 1H+15M+5M, ו-`snapshot.json` הוא H1
בלבד. הורדה מחדש שלו הייתה משנה את סרגל המדידה ומבטלת בשקט כל הרצת legacy/pro
קיימת. לכן:

```
npx tsx scripts/abBacktest.ts snapshot-mtf --from 2025-01-01 --to 2025-07-01
npx tsx scripts/abBacktest.ts run --label <name> --engine intraday
```

`snapshot-mtf.json` — 6 מטבעות, 443,106 נרות.

**החלטות parity** (מתועדות בקוד):
- Intraday מחליט על שעון ה-H1, כמו שני האחרים. זו הפשטה מכוונת: הבוט החי סורק
  בטיימר, וכניסות תוך-שעתיות נבחנות כאן בגבול השעה הבא. זו הנקודה היחידה שבה
  ה-backtest אינו רפליקה של הפרודקשן.
- Intraday מסדר את עצמו — `buildRiskPlan` מחזיר כמות, מינוף, סטופים, יעדים
  ותקציב זמן. **לא** עבר דרך `calculateRiskParameters` כמו Legacy ו-Pro; זה היה
  מודד אסטרטגיה אחרת תחת השם Intraday.
- סמנים מתקדמים (cursors) ל-15M/5M מתקדמים רק עד סגירת הנר הנוכחי — אין הצצה
  קדימה.
- snapshot של H1 בלבד **זורק שגיאה** במקום להחזיר אפס עסקאות. אפס שקט הוא תוצאת
  ה-backtest הגרועה ביותר האפשרית.

## Benchmark — לפני/אחרי (Intraday, 2025-01-01 → 2025-07-01, 6 מטבעות)

לפני = `123a07c`, הקומיט שלפני מעבר חיזוק-הסיכון. אחרי = HEAD.

```
    metric          before      after      delta
    totalTrades        199        345       +146
    winRate          44.2%      44.3%       +0.1
    netProfit      1480.62    -299.16   -1779.78
    profitFactor     1.502      0.784     -0.718
    maxDrawdown     12.14%     11.34%      -0.80
    R mean           0.849     -0.006     -0.855
    R median        -0.053     -0.055     -0.001
    R stdev          3.463      0.807     -2.657
    R best          14.560      3.696
    R worst        -13.291     -2.765
```

**הקריאה הנכונה, בשני חלקים — שניהם נכונים:**

1. **המספרים של "לפני" לא היו אמינים.** טווח של ‎-13.3R עד ‎+14.6R הוא בלתי אפשרי
   כשסטופ עובד: פוזיציה רצה פי 13 מעבר לסטופ שלה. זה בדיוק ה-invariant של כיוון
   הסטופ ומרחק הסטופ המינימלי שחיזוק-הסיכון הפך לדחייה קשה. ה-‎$1480 הגיע מקומץ
   עסקאות שה-risk שלהן נמדד שגוי, והזנב היה סימטרי — הוא פשוט נחת לטובה בחלון
   הזה. ה-R median כמעט זהה (‎-0.053 מול ‎-0.055): היתרון לעסקה לא השתנה, רק הזנב.

2. **המספרים של "אחרי" אמינים, והם שליליים.** PF 0.784 על 345 עסקאות. Intraday
   בקונפיגורציה הנוכחית מפסיד כסף בחלון הזה.

זו **החלטה אסטרטגית** ולא באג יישור. לא בוצע שינוי.

## אימות — הסבב הזה אינו משנה מסחר

Legacy ו-Pro הורצו שוב אחרי כל השינויים: **דלתא אפס בכל מטריקה**
(48 עסקאות / PF 1.019, ו-30 עסקאות / PF 0.856). ה-refactor של הקונפיג המשותף
הוא no-op מוכח.
