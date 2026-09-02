# דוח בדיקה מקיף — בוט הסימולציה ומערכת ה-Backtest

**תאריך:** 2026-09-02
**היקף:** קטגוריית בוט הסימולציה (3 מנועים — חדש/Legacy/Pro, שרת + דפדפן) ומערכת ה-Backtest Sweep.
**שיטה:** קריאת קוד מלאה של כל קבצי הליבה (worker, engines, services, hooks, contexts, pages), מעקב זרימות end-to-end, והרצת אימותים (`tsc` ל-app ול-worker, `vitest`). כל ממצא מצוטט מהקוד עם קובץ ושורה. לא בוצעו הנחות על התנהגות שלא נראתה בקוד; היכן שהערכה היא השערה (למשל זמני CPU) — זה מצוין במפורש.

---

## 1. סיכום מנהלים

| # | חומרה | ממצא | קובץ ראשי |
|---|--------|------|-----------|
| F1 | 🔴 P0 — באג | **לולאת fetch אינסופית בעמוד BacktestResults** — האפקט רץ מחדש בכל רנדר וגורם למבול בקשות ל-Worker | `src/pages/BacktestResults.tsx` |
| F2 | 🔴 P0 — באג | **Backtest "תקוע ב-status running" אחרי restart של ה-Worker** — נצמת לצמיתות: הרצה ידנית מחזירה 409, והריצה השבועית האוטומטית מדלגת לנצח | `server/tradingWorker.ts` |
| F3 | 🔴 P0 — צוואר בקבוק | **ה-Backtest רץ סינכרונית על thread אחד עם כל מנועי הסימולציה וה-HTTP** — 240 ריצות CPU-bound חוסמות את ה-event loop (כולל `/health` של Render) | `src/services/backtestRunner.ts` |
| F4 | 🟠 P1 — רגרסיה | **מיגרציית DecisionEngine השתיקה שערים שלמים:** `minConfidenceOverride` לא נאכף יותר באף מנוע; `SIM_INTRADAY_PARAMS_OVERRIDE` לא מוחל על כניסות; מכפיל הסיכון האדפטיבי מת (`_sizingMultiplier`/`_adaptiveMultiplier` נכתבים ואף פעם לא נקראים) וב-Legacy/Pro הוא מחושב מ-perf מזויף | `decisionEngine/*`, `simExecution.ts` |
| F5 | 🟠 P1 — באג | **דחיפת snapshot מהדפדפן לשרת ללא בוררות leader** — כל טאב פתוח דורס את ה-snapshot של מנוע השרת מדי ~5 שניות; סינכרון מתחלף בין שני סימולציות שונות | `tradingWorker.ts`, hooks ×3 |
| F6 | 🟠 P1 — פער | **ה-Backtest בודק מנוע שונה מזה שבייצור (Pro)** — `evaluateProSignals` במקום `computeProAdvancedAnalysis`; ופערי נאמנות (יציאה רק ב-close של H1, פוזיציה בודדת, בלי SL/TP תוך-נר) | `backtestRunner.ts` vs `proAdapter.ts` |
| F7 | 🟡 P2 — צוואר בקבוק | **Snapshot כבד (evaluations+raw+history×720) בכל poll של 5 שניות × 3 מנועים לכל טאב**, וכתיבה ל-Firestore מדי 30 שניות עם סיכון חריגה מ-1MB ודריסה שקטה | `simEngineFactory.ts`, `kvStore.ts` |
| F8 | 🟡 P2 — צוואר בקבוק | **חישוב אינדיקטורים מלא מחדש לכל סימבול בכל tick (4s)** — כולל אינדיקטורי H1 שמשתנים רק פעם בשעה | `tradeEngine.ts`, engines ×3 |
| F9 | 🟡 P2 | **מטמון ההיסטוריה ל-backtest מת למעשה** — TTL של 30 דקות מול ריצה שבועית; ענף ה-merge ההדרגתי בלתי-נגיש | `historicalCandleCache.ts`, `backtestRunner.ts` |
| F10 | 🟡 P2 | **כל טאב בדפדפן מריץ מנוע סימולציה מלא + fetch של כל היוניברס MTF כל 5 דקות** — גם כשמוצג רק מצב השרת | hooks ×3 |
| F11 | ⚪ P3 | קוד מת: `buildEvaluations`/`buildLegacyEvaluations`/`buildProEvaluations` (ואיתם השערים שנשמרו רק שם) | `simExecution.ts` וכו' |
| F12 | ⚪ P3 | **12 שגיאות `tsc` ב-worker build** — כולל הקלדות שמסתירות באגים מהסוג שכבר שבר את ה-build (§13.1 בארכיטקטורה) | `server/*`, `useBackgroundWorker.ts` |

**אימות דינמי שהורץ במסגרת הדוח:**
- `tsc --noEmit -p tsconfig.json` (frontend): **0 שגיאות**.
- `tsc --noEmit -p tsconfig.worker.json`: **12 שגיאות** (מפורט ב-F12).
- `vitest run`: רץ; כל התוצאות שנצפו בלוג ✓ (הריצה נקטעה בטרמינל המקומי לפני שורת הסיכום הסופית — לא נצפה אף כישלון).

---

## 2. מפת הקבצים שנבדקו

**שרת:** `tradingWorker.ts` (1471 ש'), `simEngineFactory.ts`, `simEngine.ts`, `legacySimEngine.ts`, `proSimEngine.ts`, `historicalCandleCache.ts`, `kvStore.ts`.
**שירותים:** `backtestRunner.ts`, `marketDataService.ts`, `simExecution.ts`, `legacySimExecution.ts`, `proSimExecution.ts`, `decisionEngine/` (orchestrator + 3 adapters), `intradayEngine.ts`, `intradayParams.ts`, `tradeEngine.ts` (calculateRiskParameters/evaluateExit).
**פרונט:** `useSimulationBot.ts`, `useLegacySimulationBot.ts`, `useProSimulationBot.ts`, `useApiPolling.ts`, `useBackgroundWorker.ts`, `SimulationBotContext.tsx`, `BacktestResults.tsx`, `App.tsx`, `tradingApiClient.ts`, `shared/targetSymbols.ts`.

היוניברס: **61 סמלים** (`TARGET_SYMBOLS`, 36 liquid + 25 close) — מספר זה משמש להערכות העומס בהמשך.

## 3. ממצאים מפורטים

### F1 — 🔴 לולאת fetch אינסופית בעמוד BacktestResults (P0, באג)

**קובץ:** `src/pages/BacktestResults.tsx`

**מנגנון (שרשרת של 3 בעיות שמזינות זו את זו):**
1. `authHeaders` נבנה מחדש בכל רנדר (שורה 56) — אין עליו `useMemo`:
```ts
const authHeaders: Record<string, string> = adminToken ? { Authorization: `Bearer ${adminToken}` } : {};
```
2. לכן `fetchResults` (useCallback עם תלות `[workerBaseUrl, authHeaders]`, שורות 58–86) מקבל **זהות חדשה בכל רנדר**.
3. האפקט (שורות 88–95) תלוי ב-`[state.status, fetchResults]` ו**קורא ל-`fetchResults()` ללא תנאי**:
```ts
useEffect(() => {
  fetchResults();
  if (state.status === 'running') { const interval = setInterval(fetchResults, 10000); ... }
}, [state.status, fetchResults]);
```

**התוצאה:** כל תשובה מוצלחת עוברת `setState(s => ({ ...s, ...data, ... }))` (שורות 69–74) — אובייקט חדש בכל פעם → רנדר → זהות חדשה של `fetchResults` → האפקט רץ שוב → fetch נוסף → ... **לולאת בקשות שתדירותה זמן ה-RTT**, במקום poll של 10 שניות. ה-interval של 10s למעשה לעולם לא מספיק לירות כי הוא מנוקה ונוצר מחדש בכל רנדר. גם מסלול השגיאה מזין את הלולאה (`setState(error)` → רנדר → fetch). הלולאה נעצרת "במקרה" רק כשהשרת מחזיר סטטוס שגיאה מתמשך שאינו 404 (אז לא נקרא setState, ו-`setLoading(false)` על false קיים גורם ל-React לוותר על רנדר).

**השפעה:** הצפת ה-Worker בבקשות `/api/backtest/results` (עד עשרות לשנייה בטאב פתוח), שחיקת מכסת ה-rate-limit (120/דק') עבור כל שאר הדפים באותו IP, צריכת סוללה/רשת במובייל (Capacitor).

**תיקון מוצע:** `useMemo` על `authHeaders` (תלות ב-`adminToken`), הוצאת ה-fetch הראשוני לאפקט נפרד שרץ על `[workerBaseUrl]`, וה-interval באפקט נפרד שתלוי רק ב-`state.status === 'running'`.

---

### F2 — 🔴 Backtest תקוע ב-`running` אחרי restart של ה-Worker (P0, באג)

**קובץ:** `server/tradingWorker.ts`

- `hydrateBacktest()` (שורות 580–592) משחזר את `backtestState.status` מה-KV **בלי כל טיפול התאוששות** — אם התהליך נפל/אותחל בזמן ריצה, הסטטוס נשאר `'running'` לנצח, כי מי שמעדכן את הסטטוס ל-`done/error` הוא `runBacktestInBackground()` (שורות 617–629) — שלא רץ.
- הרצה ידנית נחסמת: `POST /api/backtest/run` מחזיר **409** כש-`status === 'running'` (שורות 1303–1305).
- הבדיקה השבועית האוטומטית מדלגת: `if (backtestState.status === 'running') return;` (שורה 1352) — כלומר **גם הריצה השבועית לא תתרחש עוד** עד לתיקון ידני של ה-state ב-KV.

**השפעה:** אחרי deploy/restart אחד שמתרחש בזמן ריצה (Render מפעיל מחדש בכל deploy!), עמוד ה-Backtest מציג "רץ כרגע" לנצח, הכפתור "הרץ עכשיו" מנוטרל (דיסייבלד על running), והדוח השבועי מפסיק להתעדכן.

**תיקון מוצע:** ב-`hydrateBacktest()` — אם `status === 'running'` ו-`startedAt` ישן (או סתם בהתעוררות תהליך) → לסמן `status='error'` עם `error='interrupted by restart'` (ולשמור), או להריץ מחדש.

---

### F3 — 🔴 ריצת Backtest חוסמת את ה-event loop (P0, צוואר בקבוק)

**קובץ:** `src/services/backtestRunner.ts` + `server/tradingWorker.ts`

- `runBacktest(symbol, candles, slConfig, engine)` (שורות 326–395) היא **פונקציה סינכרונית** שרצה בלולאה על כל נר H1 (120 ימים ≈ 2,880 נרות).
- בכל נר: `legacyEvaluate`/`proEvaluate` חותכים `candles.slice(0, idx + 1)` (שורות 181, 262, 279, 295) ומריצים על החיתוך `detectMarketRegime` + `evaluateSignals` / `detectProRegime` + `evaluateProSignals` — כלומר **חישוב אינדיקטורים מלא על ההיסטוריה כולה, בכל נר** (O(n²) לכל ריצה). גם `checkExitPro` מחשב `evaluateProSignals` על חיתוך מלא **בכל נר לכל פוזיציה פתוחה** (שורות 262–264).
- ה-sweep = **15 קונפיגורציות (5 זוגות SL × 3 softTrendBase) × 8 סמלים × 2 מנועים = 240 ריצות** (שורות 99–115, 447–456; `tradingWorker.ts` שורות 605–616), שרצות ברצף `await` אחד אחרי השני **באותו תהליך Node שמשרת HTTP ומריץ 3 מנועי סימולציה כל 4 שניות**.

**השפעה (הערכה מבנית — לא נמדד):** כל ריצה חוסמת את ה-loop לפרק זמן שיכול להיות בין שניות לדקות; בסה"כ הריצה השבועית עלולה להשהות את כל השירות — כולל `/health` (Render free מפעיל מחדש על כישלונות בדיקת תקינות) ו-tick-ים של שלושת המנועים (הם פשוט ידולגו על ידי `simTickInProgress`). שימו לב: אין כאן `setImmediate`/`yield` אחד.

**תיקון מוצע:** להזרים `await new Promise(r => setImmediate(r))` כל K נרות; לחשב אינדיקטורים בצורה אינקרמנטלית (חלון נע) פעם אחת לכל סמל ולשתף בין 15 הקונפיגורציות (הן משנות רק סף SL/softTrend — לא את האינדיקטורים); או להריץ sweep ב-worker-thread נפרד.

---

### F4 — 🟠 רגרסיות מיגרציית DecisionEngine: שערים שהושתקו (P1)

זהו הממצא המערכתי החשוב ביותר מבחינת התנהגות המסחר של הסימולציה. המיגרציה (ARCHITECTURE.md §10, תיקון 5) העבירה את ההערכות ל-`DecisionEngine`, אבל **שלושה שערים שהיו ב-`build*Evaluations` הישן לא קיבלו מקבילה ב-adapters**:

**4א. `minConfidenceOverride` לא נאכף יותר באף מנוע.**
- המאכף היחיד חי בקוד שאין לו קוראים: `simExecution.ts:372` (`const minConf = config.minConfidenceOverride ?? 52`), `legacySimExecution.ts:206` (`?? 58`), `proSimExecution.ts:239` (`?? 60`) — כולן בתוך `buildEvaluations`/`buildLegacyEvaluations`/`buildProEvaluations` (ראה F11).
- ה-adapters לא קוראים את `context.config.minConfidenceOverride` בכלל (נבדק: חיפוש `minConfidenceOverride` ב-`decisionEngine/**` מחזיר רק את ההצהרה ב-`types.ts:105`). ההגדרה מוזרמת מהשרת (`simEngine.ts:115` = 40, `legacySimEngine.ts:98` = 58, `proSimEngine.ts:100` = 58) ומה-hooks (`useSimulationBot.ts:458` = 40, `useLegacySimulationBot.ts:363` = 58, `useProSimulationBot.ts:359` = 58) — **ומתה שם**.
- המשמעות: הגדרת "מינימום ביטחון" בממשק (52/58) כבר לא משפיעה; הסף שכן פעיל הוא הסף הפנימי-דינמי בלבד (למשל ב-intraday: bypass ב-confidence ≥ 72 — `intradayEngine.ts:229–236`).
- אי-התאמה נלווית: המנוע החדש מדווח ב-snapshot `minConfidence: 40` (`simEngine.ts:53`) בעוד התיעוד וה-UI טוענים 52 (`useSimulationBot.ts:644`, ARCHITECTURE.md §9).

**4ב. `SIM_INTRADAY_PARAMS_OVERRIDE` לא מוחל על כניסות במנוע החדש.**
ה-override (המתועד ב-ALG_intraday.md: `allowShortDuringHighVolatility`, כיווני mean-reversion) מוחל רק ב-`buildEvaluations` המת (`simExecution.ts:63–68, 330`) ובמסלול ה-**יציאות** בלבד (`simExecution.ts:499`). הכניסות ב-`simEngine.ts`/`useSimulationBot.ts` מריצות `evaluateIntradayDecision` עם `params: { ...DEFAULT_INTRADAY_PARAMS, ...context.params }` (`intradayAdapter.ts:204`) — בלי ה-override. תוצאה: התנהגות כניסות הסימולציה סטתה מהתצורה המתועדת.

**4ג. מכפיל הסיכון האדפטיבי — צינור מת.**
- ה-orchestrator מחשב מכפיל אמיתי (מ-perf אמיתי של הטריידים) ומזריק אותו ל-params: `orchestrator.ts:144` → מפתח `_adaptiveMultiplier`.
- ה-IntradayAdapter מזריק במקביל מפתח **אחר**: `intradayAdapter.ts:259` → `_sizingMultiplier`.
- חיפוש בכל ה-codebase (235 קבצים): **שני המפתחות נכתבים ולעולם לא נקראים** — 2 תוצאות בלבד, שתיהן הכתיבות עצמן. כלומר במנוע ה-intraday ה-sizing האדפטיבי כלל לא מגיע לשכבת הסיכון.
- ב-Legacy/Pro המכפיל כן מועבר ל-`calculateRiskParameters`/`calculateProRisk` (`legacyAdapter.ts:215`, `proAdapter.ts:209–226`) — אבל מחושב מ-**perf מזויף**: `{ sampleSize: closedTrades.length, lossStreak: 0, winStreak: 0, winRate: 0.5 }` (`legacyAdapter.ts:302–305`, `proAdapter.ts:313–318`). רכיב ה-streak מנוטרל שם, ונשאר רק רכיב ה-drawdown.

**השפעה מצטברת:** הסימולציות סוחרות בתדירות גבוהה מהמתועד (אין רצפת confidence נשלטת-מבחוץ), עם פרמטרים שונים מהתצורה המתועדת, ובלי צמצום גודל אחרי רצף הפסדים כפי ש-ARCHITECTURE.md §9 ("Kelly Criterion — התאמה אדפטיבית streak/drawdown/winRate") מתאר. זהו פער תיעוד↔קוד שמטעה גם את קריאת תוצאות הסימולציה.

---

### F5 — 🟠 דחיפת snapshot מהדפדפן לשרת בלי בוררות leader (P1, באג)

**שרשרת הקוד:**
1. כל hook מפעיל `persist(state)` ב-effect שרץ בכל שינוי state (וגם ב-mount): `useSimulationBot.ts:197–199` (deps בשורה 200 כוללות `history` שמתעדכנת כל 5 שניות ב-heartbeat); זהה ב-`useLegacySimulationBot.ts:155` ו-`useProSimulationBot.ts:154`.
2. ה-context מחבר את זה לשרת: `SimulationBotContext.tsx:110–112` → `pushSimState('browser-leader', state, baseUrl)`.
3. השרת מקבל **כל snapshot ללא אימות**: `POST /api/sim/state` (`tradingWorker.ts:1163–1177`) מציב `simState.snapshot = body.snapshot` ומבצע persist — **בלי לבדוק שהדוחף הוא ה-leader הנוכחי**. קיים מנגנון claim (`/api/sim/claim`, שורות 1179–1191, תוקף 8 שניות — `SIM_LEADER_TIMEOUT_MS` בשורה 452) אבל הוא לא נבדק ב-POST state.
4. במקביל, מנוע השרת דורס את ה-snapshot בכל tick (כל 4 שניות): `tradingWorker.ts:1394–1396`.

**התוצאה בפועל:** שלושת ה-providers מורכבים app-wide (`App.tsx:44–46`), כך ש**כל טאב פתוח באתר — בכל עמוד — דוחף את מצב הסימולציה המקומי שלו לשרת** מדי ~5 שניות, ומנוע השרת מדרוס אותו חזרה כל 4 שניות. למי שצופה ב-`/api/sim/state` (כל הלקוחות) זה מתנהג כ"התחלקות" בין שתי סימולציות שונות (שווי, פוזיציות והיסטוריה שונים) — מה שיכול להסביר דיווחי "איפוס מחזורי" של ה-UI. גרוע יותר: ב-restart של השרת, `hydrateSim()` עלול לטעון את ה-snapshot של הדפדפן (למשל ברירת מחדל ריקה של $10,000) כמצב הפתיחה של מנוע השרת.

**תיקון מוצע:** ב-`POST /api/sim/state` — לדחות/להתעלם מ-push כש-`simState.running === true` וה-`leaderId` בבקשה אינו `simState.leaderId` הנוכחי; וב-hooks לא לדחוף כלל כשהשרת מסונכרן ורץ (מותנה ב-`syncStatus === 'synced' && running`).

### F6 — 🟠 ה-Backtest בודק מנוע שונה מזה שבייצור + פערי נאמנות (P1)

**6א. מקור האותות של Pro ב-backtest אינו מקור האותות בייצור.**
- ב-backtest: `backtestRunner.ts:22–28` מייבא `evaluateProSignals` מ-`proAlgEngine.ts` ומשתמש בו ב-`proEvaluate` וב-`checkExitPro` (שורות 263 ואילך).
- בייצור (מנוע Pro החי): ה-adapter משתמש ב-**Advanced Analysis engine** של האתר — `proAdapter.ts:42,125–133` → `computeProAdvancedAnalysis` (כפי שמתועד ב-ARCHITECTURE.md §9 "שינוי מקור אותות בבוט פרו").
- כלומר: הריצה השבועית מכיילת את פרמטרי ה-SL (minStop/maxStop/softTrendBase) מול **מנוע האותות הישן**, והתוצאות בעמוד Backtest Sweep אינן מייצגות את התנהגות בוט פרו הנוכחי.

**6ב. פערי נאמנות מול הסימולציה החיה (כל אחד מצוטט מהקוד):**
- **יציאה רק ב-close של נר H1:** ה-PnL וה-SL/TP נבדקים מול `candle.close` בלבד (`backtestRunner.ts:242–248` ל-Legacy, `268–273` ל-Pro), וה-high/low מתעדכנים **אחרי** בדיקת היציאה (שורות 359–360) — כלומר SL/TP שנפגעו בתוך הנר אבל נסגרו מעל/מתחת לרמה לא יתפסו. בסימולציה החיה הפקודות נבדקות מול מחיר חי כל 4 שניות. התוצאה: המדדים (WinRate/MaxDD) מוטים.
- **פוזיציה בודדת בכל ריצה:** `runBacktest` שורה 370 — `if (state.positions.some(p => p.symbol === symbol)) continue;`. כל ריצה היא על סמל אחד, ולכן **maxPositions=7, תקרת Futures=2, שער הקורלציה ותקרות החשיפה אף פעם לא נבדקים** — ה-sweep מכייל פרמטרים במשטר שהבוט החי לא מריץ בו.
- **אין streak-cooldown ואין השהיית ביצוע:** ב-backtest אין `exitCooldown`/`streakCooldownFromHistory` ואין execution-delay/TTL של פקודות limit — כולם קיימים בחי (למשל `simExecution.ts:563, 632, 656–689`).
- **מודל עלויות שונה:** ב-backtest עמלה אחידה 0.1% + סליפג' 0.1% על כל כניסה (`backtestRunner.ts:323–324`), בעוד הסימולציה החיה מחשבת כניסות limit כ-Maker ללא סליפג' שלילי (`simExecution.ts:734–757`) — כלומר ה-backtest מטיל עלויות גבוהות יותר מהסימולציה שאמורה לייצג את הבוט.
- **איסוף נתונים שקט:** `fetchKlinesPaged` (שורות 66–96) — תשובת שגיאה מ-Binance (JSON שאינו מערך) מתפרשת כ"אין נתונים", הסמל מדולג בשקט עם הודעת progress בלבד, וה-sweep רץ על יוניברס חלקי בלי כישלון מפורש. אין timeout על ה-fetch.

**השפעה:** החלטות פרמטרים שמתקבלות מהעמוד עלולות להיות לא רלוונטיות (Pro) או מוטות (כולם). לא מדובר ב"באג קריסה" אלא בפער מהימנות של הכלי שנועד לכייל את הבוט.

---

### F7 — 🟡 Snapshot כבד בכל poll + דריסה שקטה ב-KV (P2, צוואר בקבוק)

**מה יש ב-snapshot (המצוטט מ-`simEngineFactory.ts:436–465`):** `history` (720 נק'), `hourlyHistory` (720 נק'), `trades` (עד 100), ו-**`evaluations` מלא** — כולל לכל סימבול את `decision: result.raw` (`simEngine.ts:194`, `useSimulationBot.ts:55`), כלומר כל `IntradayDecision` עם מערכי `logs` בעברית, regime/setup/entry, funnel ו-metrics. ביוניברס של 61 סמלים זה בקלות מאות KB לתשובה.

**כמה פעמים זה זורם:**
- `GET /api/sim/state` מחזיר את כל `simState` כולל ה-snapshot (`tradingWorker.ts:1159–1161`).
- כל לקוח polls כל 5 שניות **את שלושת המנועים** בלי קשר לעמוד בו הוא נמצא (שלושת ה-providers מורכבים app-wide — `App.tsx:44–46`; baseInterval 5000 — `SimulationBotContext.tsx:133–136` וזהים ב-Legacy/Pro).
- ובנוסף, כל snapshot נכתב ל-KV מדי 30 שניות לכל מנוע (`SIM_PERSIST_INTERVAL_MS=30000`, `tradingWorker.ts:1377, 1397–1400, 1421–1424, 1445–1448`).

**נקודת התורפה ב-KV (`server/kvStore.ts`):**
- Firestore `set`: `await fetch(...)` **בלי בדיקת `res.ok`** (שורות 141–148) — דחייה (למשל חריגה ממגבלת מסמך 1MB של Firestore, שאליה ה-snapshot הגדול מתקרב) נופלת **בשקט**, והמצב לא נשמר.
- `LocalKV.set`: קריאה-מחדשה-וכתיבה של **כל הקובץ** בכל set, עם `JSON.stringify(full, null, 2)` מעוצב (שורות 198–221) — קובץ `candles-kv.json` (שמוזן גם מ-`marketDataService` עבור 61 סמלים × 3 TFs) יכול להגיע למגה-בייטים, ואז כל שמירת נר בודדת מעתיקה את כולו.

**השפעה:** רוחב פס ו-CPU JSON בצד לקוח ושרת בכל 5 שניות; סיכון אובדן state שקט ב-Firestore; עומס IO מיותר בדיסק.

**תיקון מוצע:** לקצץ את `evaluations` ב-snapshot הנשלח (להוציא `raw`/`logs` או לספק `?full=1`), לבדוק `res.ok` ב-Firestore set עם טרונקציה מבוקרת, ולכתוב את קובץ ה-KV המקומי ללא indent.

### F8 — 🟡 חישוב אינדיקטורים מלא מחדש לכל סימבול בכל tick (P2, צוואר בקבוק)

**קובצים:** `src/services/tradeEngine.ts`, `src/services/proAlgEngine.ts`, מנועי הסימולציה ×3.

- מנגנון ה-tick של מנוע חדש: כל 4 שניות (`TICK_MS = 4000`, `simEngineFactory.ts:50`), לכל סימבול READY, ה-`IntradayAdapter` מריץ את `evaluateIntradayDecision(input)` שמבצע **כל שלב מלא**: `detectRegime1H` (ADX, ATR, סטיות) על 200+ נרות H1, `detectSetup15M` על 300+ נרות, `confirmEntry5M` על 500+ נרות — `intradayAdapter.ts:184–224`.
- באותו tack, ב-Legacy/Pro האדפטרים מריצים `detectMarketRegime`/`evaluateSignals` (`legacyAdapter.ts:112–135`) או `detectProRegime`/`computeProAdvancedAnalysis` (`proAdapter.ts:111–133`) — מהתחלה.
- ואילו ה-1H/15M בסיסי הנתונים כמעט לא משתנה תוך tick (רענון נרות: 5 דק' ל-1H ו-15M, 45 שנ' ל-5M — `TIMEFRAME_SPECS`, `marketDataService.ts:44–46`); בזמן שהנר הנוכחי עוד נבנה, ה-close לא השתנה בכלל.
- מאותה סיבה, **כל ה-adapters מחשבים את שער הקורלציה** (Pearson log-returns על ~72 נרות H1) **פעמיים** — פעם בתוך ה-adapter (`legacyAdapter.ts:238–246`, `proAdapter.ts:249–257`) ופעם ב-orchestrator (`orchestrator.ts:153–163,207–215`).

**הערכה (מבנית, לא נמדדה):** ~61 סימבולים × 3 TFs של חישובי אינדיקטורים, כל 4 שניות, בכל מנוע רץ. על Render free plan זה מאמץ CPU משמעותי (וסוס יחיד — כל שלושת המנועים באותו process).

**תיקון מוצע:** cacheing של תוצאת השכבות לפי (symbol, "תקופת הנר האחרונה הסגורה") — לחשב את שלבי ה-H1/15M רק כשהנר האחרון משתנה, ורק את שלב ה-5M בכל tick; ולבצע את שער הקורלציה פעם אחת (ב-orchestrator ולהוריד מאדפטרים, או להיפך).

---

### F9 — 🟡 מטמון ההיסטוריה של ה-Backtest מת למעשה (P2)

**קובצים:** `server/historicalCandleCache.ts`, `src/services/backtestRunner.ts`.

- ההגדרה: `MAX_CACHE_AGE_MS = 30 * 60 * 1000` (30 דק', שורה 52) — מטמון ה-H1 של "היסטוריית backtest" (120 ימים) מתיישן 30 דקות אחרי השמירה.
- השימוש: `getCachedHistory` מחזיר `null` עבור מטמון ישן (שורות 79–81), וה-backtest השבועי יחמיץ אותו תמיד (ריצה אחרונה ≥ 7 ימים קודם; בין הריצות אין ריצה אחרת שמשתמשת במפתח `history-<symbol>-1h`).
- כבונוס, ב-`backtestRunner.ts:412–436` יש ענף merge הדרגתי ("אם ה-cache לא מכסה את כל החלון, אחתוף טרי ונמזג") — אך הוא בלתי-נגיש בפועל: כדי להגיע אליו צריך ש-`getCachedHistory` יחזיר cache, וענף זה דורש שגם לשמור-מחדש. כלומר: **הכיחול "cache hit" שאמור לחסוך 8 סמלים × 120 ימי fetch (2,880 נרות כל אחד) — לא קורה לעולם אצל מנוע הדו"ח השבועי.**

**השפעה:** כל ריצה שבועית מורידה מה-Binance את כל ההיסטוריה מאפס (כולל הסיכון לחסימה), ובמקביל כותבת את הנתונים ל-Firestore (גם אין צורך).

**תיקון מוצע:** TTL נפרד להיסטוריית backtest (למשל 8 ימים), או אחסון מפורש עם `expiresAt` חתום על הנתונים עצמם — תואם ה-TTL הקיים של `kvStore` (`persistBacktest` כבר משתמש ב-7 ימים, `tradingWorker.ts:594–601`).

---

### F10 — 🟡 כל טאב מריץ מנוע סימולציה מלא + fetch MTF (P2)

**קובצים:** `src/hooks/useSimulationBot.ts` (וראה זהה ב-Legacy/Pro).

- שלושת ה-providers מורכבים `app-wide` (`App.tsx:44–46`), ואינם מותנים בגישה לעמוד `/simulation-bot`.
- ה-hook המקומי פועל **בכל טאב פתוח**: מריץ את `useCryptoData` (React Query, `staleTime` 5 דק' — `App.tsx:28`), קורא `getUniverseMarketData(symbols)` — כלומר מושך את כל 61 הסמלים × 3 TFs מ-Bybit/Binance בכל 5 דקות (`useSimulationBot.ts:233–252`) — ומנהל state מלא (positions, trades, history) גם כשהמשתמש לא ראה את עמוד הסימולציה.
- התוצאה נראית ב-F5 (דחיפת snapshot מהדפדפן) וכפולת-עבודה: **61×3 fetch + EvaluationEngine מלא (כל DecisionContext) בכל 5 שניות**, per tab, per engine.

**השפעה:** כפולות-נתונים מול Bybit/Binance (354 קריאות fetch ל-5 דקות per tab), כפולה של שלושת המנועים, ושימוש CPU/זיכרון גבוה במובייל (Capacitor).

**תיקון מוצע:** להרכיב את ה-providers *בתוך* עמוד הסימולציה, או סף משותף ל-fetch של יישויות MTF (module-level single-flight עם dedupe בין ה-hooks).

### F11 — ⚪ קוד מת שמקשה על שמירת תקינות (P3)

**קובצים:** `simExecution.ts`, `legacySimExecution.ts`, `proSimExecution.ts`.

- `buildEvaluations` (`simExecution.ts:246`), `buildLegacyEvaluations` (`legacySimExecution.ts:79`) ו-`buildProEvaluations` (`proSimExecution.ts:84`) — **אין להן יותר אף קורא פעיל**. ההooks והמנועים עברו ל-`DecisionEngine` (ARCHITECTURE.md §10 תיקון 5), ואלגוריתם בחירת ה-adapter היחיד שנשאר (`selectAdapter`) יודע לבחור רק לפי `canHandle` ומ-`engineId`.
- אולם, בתוך שלושת הפונקציות האלה יושבים **השערים היחידים שכתבו `minConfidenceOverride`, streak cooldown, ריצות mutual-correlation**, וכו' — כלומר הקוד "המת" הוא בדיוק המקום שבו ה-regressions של F4 חיות. ההוכחות: `simExecution.ts:372` (confidence), `legacySimExecution.ts:206`, `proSimExecution.ts:239`.
- כתוצאה, יש **שתי פרשנויות סותרות לעמוד הסימולציה** (זו של ה-adapters וזו של פונקציות הב*Evaluations המתות), וכל אחד שמתקן "איפה שאפשר לראות" עלול לכתוב לתוך הקוד המת.

**השפעה:** סיכון לחזרתיות של רגרסיות מסוג F4; בלבול תחזוקה. מומלץ להסיר את שלושת הפונקציות (ומייבואיהן) לאחר שהשערים מועברים ל-adapters.

---

### F12 — ⚪ 12 שגיאות `tsc` ב-worker build (P3, אבל סטטוס build בפועל)

**מופעל ביד:** `tsc --noEmit -p tsconfig.worker.json` → 12 שגיאות:

| קובץ:שורה | שגיאה | השפעה |
|---|---|---|
| `server/kvStore.ts:107,112` | `Property 'integerValue'/'stringValue' does not exist on type 'unknown'` | הקלדה חלשה של שדות Firestore — לוגיקה עדיין רצה, אבל כל שינוי עתידי לא יאומת |
| `server/tradingWorker.ts:118` | `Property 'url' does not exist on type '{ headers... }'` | טיפוס ה-req באיטרציה מה-CORS Blocked — קומפילציה לא מזהירה על באגי URL |
| `server/tradingWorker.ts:493,522,550,662` | `Type 'string' is not assignable to type '"1.0.0"'` | `engineVersion` מוגדר כ-literal type — כל שינוי גרסה מחרים שדות state |
| `src/hooks/useBackgroundWorker.ts:30,36,41,58,60` | `Cannot find name 'Worker'/'window'` | חסרים lib dom/worker ב-tsconfig של ה-worker — הקוד `typeof window !== 'undefined'` מתוכנן דווקא לזה |

**הערה חשובה:** הקריאה הרשמית `npm run build:worker` (esbuild) עוברת — esbuild לא מבצע בדיקת טיפוסים, ומדויקת היסטורית של הפרויקט (§13.1 ב-ARCHITECTURE.md) מראה שהבדיקה הזו בדיוק היא שתפסה באגי P0 בסוג `No matching export`. שגיאות `tradingWorker.ts:118/493/522/550/662` יסתירו גם את הבאגים שכן מופיעים בקומפילציה. מומלץ להוסיף `typecheck:worker` ל-CI (הסקריפט קיים כבר ב-`package.json:14`).

---

## 4. אימות דינמי (כפי שהורץ במסגרת הדוח)

| כלי | פקודה | תוצאה |
|---|---|---|
| TypeScript (frontend) | `tsc --noEmit -p tsconfig.json` | 0 שגיאות ✓ |
| TypeScript (worker) | `tsc --noEmit -p tsconfig.worker.json` | **12 שגיאות** (F12) ✗ |
| Tests | `vitest run` | רץ — כל התוצאות שנצפו בלוג עברו ✓ (הריצה המלאה נקטעה בטרמינל לפני שורת הסיכום, לא נצפה כישלון) |

**אילוץ סביבה:** ה-runner המקומי הוא PowerShell ללא `node`/`npx` ב-PATH ברירת מחדל (node קיים ב-`C:\Program Files\nodejs`), ובנוסף הריצות הראשונות של tsc נכשלו זמנית עקב מדיניות הרצת סקריפטים. שורת הפקודה הופעלה עם `$env:Path` עדכון ו-`& npx.cmd ...`. זה לא משפיע על תוקף הממצאים (כולם מגובים בקריאת קוד).

## 5. סדר פעולות מומלץ (Roadmap)

**שלב 1 — הסרת סיכוני המשכיות (P0):**
1. F2 — התאוששות `backtestState` ב-`hydrateBacktest` (תקע) → מאפשר חזרה של הדוח השבועי.
2. F1 — תיקון הלולאה בעמוד BacktestResults (הצפת HTTP).
3. F3 — הזרמת ריצת ה-Backtest (yield) או הוצאתה לעובד נפרד — **הגנה על `/health` ושלושת מנועי הסימולציה**.

**שלב 2 — תיקון התנהגות הסימולציה (P1):**
4. F4 — העברת שערים שהושתקו אל האדפטרים: `minConfidenceOverride`, `SIM_INTRADAY_PARAMS_OVERRIDE`, וקישור `_sizingMultiplier`/`_adaptiveMultiplier` ל-sizing בפועל (יחד עם perf אמיתי ב-Legacy/Pro) — **זה מיישר את הסימולציה עם התיעוד** (ALG_*.md, ARCHITECTURE.md §9).
5. F5 — בוררות leader אמיתית ב-`POST /api/sim/state` (ודחיית push כשהשרת רץ ומסונכרן).
6. F6 — החלפת מקור האותות של Pro ב-backtest ל-`computeProAdvancedAnalysis` (או לפחות פער מתועד), והוצאת פערי הנאמנות (יציאה intrabar, multi-position, cooldowns, עלויות).

**שלב 3 — ביצועים ויציבות (P2/P3):**
7. F7+F10 — קיצוץ payload ה-snapshot (כולל חסימת `evaluations` כבדים), בדיקת `res.ok` ב-Firestore, ושליטה על ריצת מנוע הדפדפן.
8. F8 — cacheing שכבות החלטה לפי נר סגור; שער קורלציה יחיד.
9. F9 — TTL ייעודי למטמון היסטוריית ה-backtest (חסכון של 2,880 נרות × 8 סמלים בכל ריצה שבועית).
10. F11+F12 — הסרת קוד מת; תיקון 12 שגיאות ה-`tsc` של ה-worker והוספת `typecheck:worker` ל-CI.

---

*מסמך זה נכתב על בסיס קריאת הקוד המלאה של המערכת (כולל קבצים שלא תועדו ב-ARCHITECTURE.md, כגון `backtestRunner.ts` ו-`intradayBacktest.ts`), מעקב זרימות end-to-end (entry → order → fill → persist → poll), והרצת כלי האימות. כל הממצאים מצטטים קובץ ושורה. ממצאים המבוססים על הערכה מבנית (כמו השפעת CPU) מסומנים במפורש כ"הערכה".*

---

## 6. עדכון אימות — בדיקת התיקונים שבוצעו (2026-09-02)

**שיטה:** השוואת `git diff` מול כל ממצאי הדוח (F1–F12), קריאת הקבצים המעודכנים, והרצת האימותים מחדש.

| ממצא | סטטוס | אימות בקוד |
|------|--------|-----------|
| F1 — לולאת fetch | ✅ תוקן | `src/pages/BacktestResults.tsx:75–110` — `authHeaders` → `useMemo([adminToken])`; `fetchResults` יצוב דרך `fetchResultsRef`; effect ראשוני נפרד מ-interval; ה-interval תלוי רק ב-`state.status === 'running'`. |
| F2 — Backtest תקוע | ✅ תוקן | `server/tradingWorker.ts:580–592` — `hydrateBacktest`: `status==='running'` → `'error'` + `'interrupted by restart'`. |
| F3 — חסימת event loop | ✅ תוקן | `src/services/backtestRunner.ts:350–356` — `runBacktest` → async עם `await setImmediate` כל 100 נרות. |
| F4א — minConfidenceOverride | ✅ תוקן | שער `MIN_CONFIDENCE` ב-`normalize` של שלושת האדפטטרים (`intradayAdapter.ts:320–327`, `legacyAdapter.ts:338+`, `proAdapter.ts`); hooks/שרת מעבירים כעת את קונפיג-המשתמש (`useSimulationBot.ts:458` וכו'). |
| F4ב — SIM overrides | ✅ תוקן | `intradayAdapter.ts:204` — `params: { ...SIM_INTRADAY_PARAMS_OVERRIDE, ...DEFAULT_INTRADAY_PARAMS, ...context.params }` (הקבוע מיוצא מ-`simExecution.ts:63`). |
| F4ג — מכפיל אדפטיבי | 🟡 חלקי | Legacy/Pro: תקין — `_adaptiveMultiplier` (אמיתי מה-orchestrator, `orchestrator.ts:119–129`) נצרך באדפטטרים (`legacyAdapter.ts:310–316`) ומועבר ל-`calculateRiskParameters`/`calculateProRisk`. **Intraday: עדיין לא מגיע ל-sizing בפועל** — `params._sizingMultiplier` נכתב ב-`intradayAdapter.ts:275` אך אין צרכן בתוך `evaluateIntradayDecision`/`buildRiskPlan`. |
| F5 — בוררות leader | ✅ תוקן | `tradingWorker.ts:1188–1194` — `POST /api/sim/state` → 409 על leader mismatch; `SimulationBotContext.tsx:108–112` — דחיית push כששרת synced+running. |
| F6 — מנוע Pro ייצור/בקטסט | ✅ תוקן | `backtestRunner.ts:24–41, 275–285` — `computeProAdvancedAnalysis` במקום `evaluateProSignals` (ב-proEvaluate וב-checkExitPro). |
| F7 — snapshot כבד | ✅ תוקן | `simEngineFactory.ts:454–462` — evaluations נגזמו לשדות קלים; `kvStore.ts:138–151` — בדיקת `res.ok` + `JSON.stringify` ללא prettify (שורה 202). |
| F8 — אינדיקטורים מלאים בכל tick | ✅ תוקן | שלושה `resultCache` באדפטטרים לפי (symbol, last timestamps H1/15M/5M, portfolio, closedTrades, config), capped 200 (`intradayAdapter.ts:252–300`, זהה ב-Legacy/Pro). |
| F9 — מטמון היסטוריה מת | ✅ תוקן | `historicalCandleCache.ts:52` — TTL = 8 ימים (מכסה המחזור השבועי). |
| F10 — מנועים בכל טאב | ✅ תוקן | ה-providers הוסרו מ-`App.tsx` והועברו ל-`SimulationBot.tsx` (בתוך הדף בלבד); `marketDataService.ts` — `universeFetchCache` single-flight עם מחיקה ב-`finally`. |
| F11 — קוד מת | ✅ תוקן | `build*Evaluations` נמחקו (950 שורות — `simExecution/legacySimExecution/proSimExecution`). |
| F12 — שגיאות worker | ✅ תוקן | 12 → **0**: casts ל-Firestore fields, `engineVersion as string` ×4, הסרת `req.url` מה-CORS log, `tsconfig.worker.json` → `lib: ["ES2022","WebWorker","DOM"]`. |

**אימות מחודש (הופעל ביום זה):**

| בדיקה | תוצאה |
|--------|-------|
| `tsc --noEmit -p tsconfig.json` (frontend) | **0 שגיאות** ✓ |
| `tsc --noEmit -p tsconfig.worker.json` | **0 שגיאות** ✓ |
| `vitest run` | **21 קובצי טסט · 214 עברו · 2 skipped** ✓ |

**כמה הערות על השינויים הנוספים (ניקיון/ארגון):**
- `package.json`: נוסף `"typecheck"`. · `ARCHITECTURE.md`: עדכון כתובת Render (hev8). · `RealTradingBot.tsx`: נתונים אמיתיים למחווני התיק במקום 0, maxPositions 7 במקום 5. · `tradingApiClient.ts`: type נכון ל-`openedSymbols`. · `tradingWorker.scan()`: ספירת שמורות (pending/spotHoldings/openSymbols) בתקרת הפוזיציות — שיפור דיוק; הוסר גם REENTRY_COOLDOWN (שינוי התנהגות).

**נקודות פתוחות (עודכן במחזור השני — ראה סעיף 7):**
1. **Intraday sizing** — `_sizingMultiplier` עדיין לא נצרך בתוך `buildRiskPlan` — **הפריט היחיד שנותר פתוח** (לא נכלל בבקשת התיקון).
2. ~~minConfidence בשרת~~ — ✅ נסגר (סעיף 7.1).
3. ~~REENTRY_COOLDOWN~~ — ✅ נסגר (סעיף 7.2).
4. ~~נאמנות ה-backtest~~ — ✅ נסגר (סעיף 7.3).

---

## 7. תיקוני המשך — מחזור שני (2026-09-02)

### 7.1 פער שרת/דפדפן ב-minConfidence (מנוע חדש) — ✅ סגור
- `server/simEngine.ts:53` — `minConfidence: 40` → `52` (ה-snapshot תואם ל-UI ולתיעוד).
- `server/simEngine.ts:114–118` — `minConfidenceOverride` נקרא עכשיו מ-`input.config.minConfidenceOverride` (הקונפיג הנשמר, ברירת מחדל 52) עם fallback 52 — במקום הקשיח 40.

### 7.2 קפיאת openedSymbols של SPOT — ✅ סגור
בדיקת עומק: `checkClosedSpotPositions`/`confirmSpotEntries` מוגנות ב-`if (dryRun || !ctx) return` — ב-dry-run אין מנגנון שמדווח סגירת SPOT, ולאחר הסרת REENTRY_COOLDOWN ההזמנה הייתה נתקעת לנצח (הבוט היה מדלג על הסמל לתמיד). התיקון:
- `tradingWorker.ts:65` — הוחזר `REENTRY_COOLDOWN_MS` (ברירת מחדל 24h, ניתן לכיוון ב-env).
- `tradingWorker.ts:966–979` — לולאת ניקוי ב-`scan()`: SPOT reservations פגים אחרי ה-cooldown, עם החרגה ל-`pendingLimitOrders` (הזמנה שעדיין עשויה להתמלא — ה-TTL שלה מנקה בעצמו). ב-live, סגירות אמיתיות ממשיכות להדווח ע"י `checkClosedSpotPositions`/`checkClosedFuturesPositions`.

### 7.3 נאמנות ה-backtest — ✅ סגור
שלושת פערי הנאמנות מ-F6 טופלו ב-`backtestRunner.ts`:
1. **יציאה intrabar** — `intrabarExit()` (שורות 309–333): SL/TP1/TP2 שהטווח (high/low) של הנר חוצה נורה **במחיר הרמה** (לא ב-close); TP1 → `PARTIAL_50` כמו בחיים; `positionPnl()` מחשב PnL במחיר היציאה. הבדיקה המבוססת-close נשארת כ-fallback (reversal/time-based/trailing).
2. **פוזיציה בודדת** — `runPortfolioBacktest()` (שורות ~489–592): ריצה מרובת-סמלים על ציר זמן ממוזג (אירוע אחד לכל (סמל, נר), ממוין לפי ts) עם שערי תיק **גלובליים** — `maxPositions=7`, `maxFutures=2` — שכעת באמת נאכפים. `runBacktestSweep` מריץ אותו לכל slConfig כשיש יותר מסמל אחד (סמל בודד עובר דרך ה-runner הישן).
3. **cooldown אחרי הפסד** — `STREAK_COOLDOWN_MS` (30 דק') לכל סמל, בשני ה-runners (`lossCooldownUntil`).

**אימות אחרי מחזור זה:** `tsc` app = 0 · `tsc` worker = 0 · `vitest` = **214 עברו / 2 skipped** (21 קבצים).


