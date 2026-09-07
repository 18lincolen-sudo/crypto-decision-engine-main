# דוח אימות — האם ההחלטות בוצעו? (בדיקה אמפירית בקוד)

**תאריך:** 2026-09-07
**שיטה:** קריאה ישירה בקוד + הרצת טסטים. **לא הסתמכתי על הערות/JSDoc.** לא בוצעה שום עריכה.
**מצב טסטים:** `npx vitest run` → **338 passed | 2 skipped** (כל ה-14 שנשברו קודם — תוקנו).
**מקרא:** ✅ בוצע ואומת · 🟡 חלקי / בוצע חלק מהבוטים · ❌ לא בוצע

---

## טבלת ההחלטות שלך — מצב בפועל

| # | ההחלטה | מצב | ראיה בקוד |
|---|---|---|---|
| 1 | SPOT per-asset = **10%** (לא 15%) | 🟡 | `intradayParams.ts:302` `maxSpotNotionalPercent: 10` ✅. `intradayRisk.ts:383-396` — ה-SPOT branch **כן** בודק per-asset 10% עכשיו ✅. **אבל** `simExecution.ts` (intraday SIM) עדיין לא — ראה #12. |
| 2 | Futures per-asset = **10%** | ✅ | `intradayRisk.ts:424` `PER_ASSET_EXPOSURE_CAP_PERCENT` = 10 (`intradayParams.ts:234`). |
| 3 | Total exposure = **20%** | 🟡 | `MAX_TOTAL_EXPOSURE_PERCENT = 20` (`intradayParams.ts:243`), נאכף ב-FUTURES (`intradayRisk.ts:441-447`) וב-`trendBreakoutExecution placeLot` (`totalCap`). **`buildRiskPlan` SPOT branch לא בודק total** — N פוזיציות SPOT × 10% ללא תקרת סכום ב-`buildRiskPlan` (רק `maxOpenPositions:2` מגביל בעקיפין). |
| 4 | Max concurrent = **2** + `maxPositions × target ≤ totalCap` validation | 🟡 | `SIM_BASE_DEFAULTS.maxPositions = 2` (`simDefaults.ts:193`), bybit/path/factory כולם `?? 2`. `validateExposureModel()` (`simDefaults.ts:262`) **זורק** `EXPOSURE_MODEL_INVALID` אם `maxPositions × positionTargetPct > totalCap` ✅. **אבל** נקרא **רק ב-`reset()`** (`simEngineFactory.ts:581`) — לא ב-constructor/hydrate, לא ב-real bot (`tradingWorker`/`buildRiskPlan`). server restart מ-snapshot ⟶ אין validation. |
| 5 | TrendBreakout Scale-In = **5% + 3% + 2%** | ❌ | **SCALE_1 נכון** (`trendBreakoutExecution.ts:367` `targetNotional * scaleFractions[0]` = 5%). **SCALE_2/3 שגויים** (`:326-329`): `remaining = target - existing; desired = remaining * fraction`. → SCALE_2 = (10%−5%)×0.3 = **1.5%** (צריך 3%), SCALE_3 = (10%−6.5%)×0.2 = **0.7%** (צריך 2%). סה"כ ≈ **7.2%**, לא 10%. הנוסחה צריכה `targetNotional * fraction`. |
| 6 | Pro Scale-In = **לא כרגע** | ✅ | `proSimExecution.ts` — entry יחיד per slot, אין lots. |
| 7 | Path Scale-In = **לא כרגע** | ✅ | `prev4hRangeExecution.ts:2` "one position per symbol, no scale-in". |
| 8 | Scale-In לעולם לא > 10% | ✅ | `trendBreakoutExecution.ts:328` `remaining = max(0, target - existing)` — לא יכול לעבור 10% (הבעיה ההפוכה — undersize). |
| 9 | Archive on reset (runId + atomic + open positions → mark-to-market) | ❌ | **לא קיים בכלל.** grep ל-`runId` / `archive` / `bot-history` / `OPEN_AT_RESET` / `backtest-archive` — **אפס תוצאות** בקוד. `reset()` ב-`simEngineFactory.ts:580` פשוט מאפס `trades=[]; history=[]` בלי לארכב. אין endpoint שרת חדש. |
| 10 | Cost model — **Net economics כ-SSOT** | 🟡 | intraday: `evaluateCostEdge` מחזיר `entry/SL/TP1` echo + fees/slippage/netRR מפורש ✅. **TrendBreakout / Prev4hRange / Pro — אין `evaluateCostEdge` בכלל** בשרשרת שלהם (grep). אין netRR אחרי עלויות, אין netEV. |
| 11 | Cost safety filter — כן, כ-filter נוסף; `costSafetyMultiplier` → **config, שם ברור** | 🟡 | הוא **config** (`intradayParams.ts:84,273` `costSafetyMultiplier: 2.0`) ✅. אבל **לא שונה שם** ל-`COST_EDGE_SAFETY_MULTIPLIER`/`costEdgeSafetyMultiplier`. `intradayRisk.ts:143` `approved = costApproved && rrApproved` — פונקציונלית netRR הוא co-gate + ה×2 נוסף, אבל לא ממוסגר מפורשות כ"filter משני". |
| 12 | **שום מנגנון downstream לא רשאי לשנות את ה-target של 10%** | ❌ | **`simExecution.ts` (intraday SIM) מפר את זה.** `:621` `resolveEntryBudget({ kellyBetSizeUsd: ev.betSizeUsd, positionPercent: ctx.positionPercent, riskLevel: ctx.riskLevel, sizingMultiplier })`. `resolveEntryBudget` (`:301-320`): `ceiling = computeEntryBudget(cash, ..., positionPercent) × riskLevelSizingMultiplier(riskLevel)` (0.6 / 1.0 / 1.5); `sized = betSizeUsd × perfMult` (perfMult ≤ 1, adaptive); `return min(sized, ceiling)`. כלומר **riskLevel, perfMult ו-positionPercent מעצבים מחדש את הגודל** של הבוט intraday בסימולציה. `betSizeUsd = risk.notionalUsd` (10%) — אבל נחתך ע"י ceiling/perfMult. |

---

## פירוט מהאודיט המקורי (28 סעיפים) — מה השתנה

### ✅ בוצע ואומת
- **§1 (real bot):** `buildRiskPlan:372` `targetNotional = equity * params.positionTargetPct`. Test 1/2 ב-`positionSizing.test.ts` קוראים ל-`buildRiskPlan` אמיתי ומאמתים $100 / $1000.
- **§4 SPOT per-asset:** `intradayRisk.ts:383-396` — הוסף branch per-asset ל-SPOT (קודם דילג).
- **§5 (real bot + Pro + Path + TrendBreakout):** MIN_ORDER = **skip, לא bump**. `intradayRisk.ts:451` `rejected("...MIN_ORDER_EXCEEDS_POSITION_TARGET")`; `proSimExecution.ts:237`; `prev4hRangeExecution.ts:170,181`; `trendBreakoutExecution.ts:370`. Test 3 מאמת (`buildRiskPlan` אמיתי → `blockReason` מכיל `MIN_ORDER_EXCEEDS_POSITION_TARGET`).
- **§5 (`simExecution.ts`):** `canBump` **הוסר**. `:630` `if (rawBudget < MIN_SIM_ENTRY_USD) continue;`. `:831` `Math.min(order.budgetUsd ?? 0, ...)` (היה `?? 100`).
- **§12 (Pro / Path):** hardcoded `0.10` הוחלף ב-`POSITION_TARGET_PCT` — `proSimExecution.ts:234`, `pathSimExecution.ts:94`.
- **§7 Prev4hRange R:R:** `minRR: 1.2` param + `RR_BELOW_MIN` gate — `prev4hRange.ts:53,66,232`. (ההערה על "~2:1" תוקנה.)
- **§8 intraday R:R SSOT:** `CostAnalysis`/`RiskPlan` echo levels + `DATA_MISMATCH` gate + `SIGNAL_LEVELS` log. `intradayRRConsistency.test.ts` ירוק.
- **§22 concurrent = 2:** `SIM_BASE_DEFAULTS.maxPositions = 2`, `maxOpenPositions: 2` (`intradayParams.ts:308`), `validateExposureModel` קיים.
- **§26 (חלקי):** נוסף `src/__tests__/positionSizing.test.ts`. **14 הטסטים ששברת — תוקנו** (הריצה ירוקה).

### 🟡 חלקי
- **§4 startup validation:** `validateExposureModel` זורק — אבל **רק ב-`reset()`**, ורק בסימולציה. אין `if (perAssetCapPct < positionTargetPct) throw` (הבדיקה השנייה מ-§4). אין validation ל-real bot.
- **§9 fees מפורש:** רק intraday. Pro/TrendBreakout/Prev4hRange בלי cost analysis.
- **§11 costSafetyMultiplier:** config ✅, שם לא שונה, מיסגור לא שונה.
- **§26 טסטים:** ראה למטה — **Test 5/6/7/8/9 מזויפים** (אריתמטיקה inline, לא קוראים למנוע).

### ❌ לא בוצע
- **§1 / §12 (intraday SIM):** עדיין `resolveEntryBudget` (Kelly/riskLevel/positionPercent). לא עבר ל-10%. ראה שורה #12 בטבלה.
- **§3 Scale-In:** SCALE_2/3 undersized (`remaining * fraction`).
- **§4 total-exposure ל-SPOT ב-`buildRiskPlan`:** אין.
- **§9 (Pro/Path/TB):** אין `evaluateCostEdge` / netRR / netEV.
- **§10 signalPrice מול actualFillPrice:** TrendBreakout/Prev4hRange עדיין `entryRef = currentPrice`, אין recompute אחרי fill. Test 9 לא בודק את הקוד (ראה למטה).
- **§11 ALLOCATION_DRIFT / actual-vs-target:** אין.
- **§16 strategyDecision vs executionDecision (Pro HOLD/ALREADY_HELD):** לא נמצא הפרדה בקוד.
- **§17 Pro confidence reproducibility:** לא אומת (לא נבדק `proAlgEngine` לעומק).
- **§18 Supertrend Custom/Standard:** לא תועד, `calculateSupertrend.direction` (band-flip) מול regime `currentPrice >= value` — שתי קביעות עדיין קיימות.
- **§21 `riskPerTrade` legacy:** `intradayParams.ts:290` `riskPerTradePercent: 0.5` עדיין. `intradayRisk.ts:330` עדיין `clamp(input.riskPercent ?? params.riskPerTradePercent, ...)` → `riskPercentUsed` (`:486`). `riskPerTrade: 0.005` עדיין ב-params objects של trendBreakout/prev4hRange, לא שונה שם.
- **§23 Exposure Logging / bindingConstraint:** אין. כל cap עדיין `Math.min(...)` שקט. `RiskPlan` return בלי `bindingConstraint`.
- **§24 Diagnostic Assertions:** ❌ **הבלוק ב-`intradayRisk.ts:490-498` עדיין נמצא אחרי ה-`return` (`:465-488`) → קוד מת. שום assertion לא רץ.** אין `assert(perAssetCapPct >= positionTargetPct)` / `assert(confidence >= minConfidence || !willExecute)` / `assert(abs(calculatedRR - displayedRR) < tol)`. רוב קודי השגיאה מ-§24 עדיין חסרים (רק `DATA_MISMATCH` ל-intraday).
- **§25 Signal Diagnostic JSON:** אין לאף בוט. intraday מדפיס שורת טקסט `SIGNAL_LEVELS` בלבד — לא JSON, בלי exposure/notional/fill.
- **§28 deliverables 2-13:** רשימות קבצים/סתירות/JSON דוגמאות — לא סופקו.
- **Reset → Firestore archive:** ❌ (שורה #9 בטבלה).
- **`intradayRisk.ts:320,322` `const s` / `const atr5`:** משתנים מתים, עדיין שם.

---

## ⚠️ אזהרה על הטסטים החדשים (`positionSizing.test.ts`)

חלק מ-"טסטי §26" **לא בודקים את הקוד** — הם אריתמטיקה inline בתוך הטסט:

| טסט | קורא למנוע? | מה הוא באמת בודק |
|---|---|---|
| Test 1, 2 | ✅ `buildRiskPlan` | אמיתי — 10% של equity |
| Test 3 | ✅ `buildRiskPlan` | אמיתי — `MIN_ORDER_EXCEEDS_POSITION_TARGET` |
| Test 4 | ✅ `applyProEntryGates` | אמיתי — אבל בודק Pro `BELOW_THRESHOLD`, לא את "69→SIGNAL" ב-TrendBreakout (§6) |
| **Test 5** | ❌ | `expect(1.0 / 0.5).toBeCloseTo(2.0)` — לא נוגע ב-`evaluatePrev4hRange` |
| **Test 6** | ❌ | `expect(0.5 / 1.0).toBeCloseTo(0.5)` — אריתמטיקה בטסט |
| **Test 7** | ❌ | `expect(0.3994 / 0.2396).toBeCloseTo(1.67)` — לא נוגע ב-`buildRiskPlan` |
| **Test 8** | ❌ | `fractions.map(f => 100 * f)` **בתוך הטסט** — לא קורא ל-`generateTrendBreakoutOrders` (מיובא בשורה 9, לא בשימוש). **עובר גם כשהקוד ב-`:329` שגוי.** |
| **Test 9** | ❌ | חישוב drift ידני בטסט — הקוד עצמו לא עושה recompute |
| "Pro 10% fixed" | ✅ `applyProEntryGates` | אמיתי — conf 70/90 → `budgetUsd ≈ 1000` |

כלומר Test 8 (scale-in 50/30/20) **ירוק למרות שהמימוש ב-`trendBreakoutExecution.ts:329` מייצר ~7.2%**, כי הטסט לא מריץ את המימוש.

---

## סיכום — מה נשאר

**חובה (סתירות):**
1. `simExecution.ts:621` — להעביר את intraday SIM ל-`POSITION_TARGET_PCT` (או להעביר את ה-order-gen שלו ל-`buildRiskPlan.notionalUsd` ישירות בלי `resolveEntryBudget`). כרגע riskLevel/Kelly/positionPercent עדיין מעצבים את הגודל.
2. `trendBreakoutExecution.ts:329` — `desiredNotional = targetNotional * fraction` (לא `remaining * fraction`).
3. `intradayRisk.ts:465-498` — הבלוק אחרי ה-`return` הוא dead code. אם רוצים assertions (§24) — להעביר אותם לפני ה-`return` ולעשות אותם fail-loud.
4. Archive/reset (§9) — לא קיים בכלל. צריך: `resetAll` → append ל-Firestore עם `runId` לפני clear; endpoint קריאה; `clearAllCache` → מוחק גם את הארכיון.
5. `validateExposureModel` — לקרוא גם ב-constructor/hydrate ובנתיב ה-real bot, ולהוסיף את בדיקת `perAssetCapPct >= positionTargetPct`.

**רצוי:**
6. §23 bindingConstraint + §25 Signal JSON — אין לאף בוט.
7. §21 — `riskPerTradePercent` עדיין נקרא ב-`buildRiskPlan:330`; לנקות או לשנות שם ל-"derived stop risk".
8. Test 5-9 ב-`positionSizing.test.ts` — לכתוב מחדש כך שיקראו למנוע האמיתי.
9. `intradayParams.ts:302` `maxSpotNotionalPercent: 10` — כפילות עם per-asset 10%; לאחד/להסיר.
10. `intradayRisk.ts:320,322` — למחוק `const s` / `const atr5` המתים.

---

## תיקון לדוח + ממצאים נוספים (סבב שני, מעמיק)

### תיקונים למה שכתבתי קודם
- **§4 / שורה #4:** `validateExposureModel` נקרא ב-**כל `tick()`** (`simEngineFactory.ts:350` דרך `validateConfig`), לא רק ב-`reset()`. כלומר בסימולציה זה כן רץ רציף. עדיין: (א) לא מכסה את ה-real bot (`tradingWorker`/`buildRiskPlan`), (ב) לא בודק `perAssetCapPct >= positionTargetPct`, (ג) `throw` בתוך `tick` = הבוט "קופא" בשקט במקום שגיאת startup נקייה.
- **§1 / Backtest:** `backtestRunner.ts:253-255` **כן** צורך את מודל ה-10% — `sizeUsd = plan.marginUsd|plan.notionalUsd` מ-`buildRiskPlan`. הבעיה שנשארת ב-§15 היא רק מודל העלויות (slippage דטרמיניסטי 0.05% מול ה-random band של הסימולציה), ואין `TradingCostModel` משותף.
- **intraday reorder:** ה-reorder שלי (RISK לפני COST) + `DATA_MISMATCH` + `SIGNAL_LEVELS` **שרדו** את ה-rewrite שלך (`intradayEngine.ts:15,336,376,400,415`).

### ממצאים חדשים

| # | ממצא | חומרה | ראיה |
|---|---|---|---|
| N1 | **`positionTargetPct` = 4+ הגדרות literal של `0.10`** | 🔴 SSOT | `POSITION_TARGET_PCT` (`intradayParams.ts:225`) + `DEFAULT_INTRADAY_PARAMS.positionTargetPct` (`:292`) + `DEFAULT_TREND_BREAKOUT_PARAMS.positionTargetPct` (`trendBreakout.ts:94`) + `DEFAULT_PREV4H_RANGE_PARAMS.positionTargetPct` (`prev4hRange.ts:62`). שינוי אחד → drift שקט. ה-`assert(positionTargetPct === 0.10)` שהיה תופס את זה = הקוד המת ב-`intradayRisk.ts`. |
| N2 | **שורת `SIGNAL_LEVELS` מדפיסה risk% שגוי** | 🔴 §27 | `intradayEngine.ts:424`: `risk=${effectiveRisk.riskPercentUsed}%` = **0.5%** (ה-clamp הוותיק של `riskPerTradePercent`), בזמן שאותה שורה שתי שורות מעל (`:417`) מדפיסה `RISK%=1.800` הנכון. שני "risk %" סותרים באותה שורת diagnostic. |
| N3 | **Adaptive risk (streak de-risking) מת ל-intraday** | 🟠 | `buildRiskPlan:487` מחזיר `sizingMultiplier: 1` קשיח, לא קורא `input.sizingMultiplier`. `simExecution.ts:621` עדיין מעביר `sizingMultiplier: riskMult` אבל `riskMult` נגזר מ-`ev.decision.risk.sizingMultiplier` שהוא תמיד 1 עכשיו. כלומר `adaptiveRisk.ts` (הקטנת גודל אחרי רצף הפסדים) חסר-השפעה על intraday. אולי מכוון ("10% טהור") — אבל לא מתועד כ-drop. |
| N4 | **`RiskPlan.riskPercentUsed` = טלמטריה מטעה שנשלחת ל-UI** | 🟠 §2/§21 | הוא `clamp(params.riskPerTradePercent=0.5, ...)`. ה-UI עלול להציג "Risk 0.5%" ליד פוזיציה שסיכון ה-SL האמיתי שלה הוא 1.8% (~$18 על $1000). המדד הנכון (`riskUsd`/`riskPercent`) קיים בנפרד — שני שדות risk, אחד שגוי. |
| N5 | **`fillDueOrders` לא בודק exposure מחדש ב-fill** | 🟠 §11 | `simExecution.ts:831` בודק רק `budget < MIN_SIM_ENTRY_USD` ו-`workingCash`. בין queue ל-fill פוזיציות אחרות יכולות להתמלא ולחרוג מ-20% total — אין guard. |
| N6 | **`pathSimExecution.ts` הוא dead code** | 🟡 | `pathSimEngine.ts:87` קורא ל-`generatePrev4hRangeOrders` (מ-`prev4hRangeExecution.ts`). ה-`POSITION_TARGET_PCT` שהוכנס ל-`pathSimExecution.ts:94` הוא תיקון לקוד מת. הנתיב החי הוא `prev4hRangeExecution.ts:168` (`p.positionTargetPct` — תקין). |
| N7 | **SPOT ללא תקרת סכום ב-`buildRiskPlan`** | 🟡 §3 | ה-FUTURES branch בודק `maxLeveragedExposurePercent` (`:441`). ל-SPOT branch (`:377-400`) אין מקבילה — רק per-asset + `maxSpotNotionalPercent`. חסום בעקיפין ע"י `maxOpenPositions:2`, אבל אם הפרמטר הזה מועלה (env), אין תקרת סכום ל-SPOT. |
| N8 | **`const s` / `const atr5` / קוד מת עוברים tsc+lint** | 🟡 | `allowUnreachableCode` לא `false` ו-`noUnusedLocals` לא `true` ב-tsconfig → הבלוק המת ב-`intradayRisk.ts:490` + 2 המשתנים לא נתפסים ע"י שום כלי. |
| N9 | **"69→SIGNAL" (§6) לא נחקר לשורש ואין guard** | 🟡 | `trendBreakout.ts:328` `Math.round(c.total)` — `69.5 → 70 → SIGNAL` בעוד UI שעושה floor מציג 69. אין `assert(confidence >= minConfidence || !willExecute)`. זו התצפית המקורית היחידה שנשארה בלי הסבר או הגנה. |
| N10 | **`intradayEngine` fallback ל-confidence>=72 עדיין קיים** | 🟡 §19/§24 | `:358-363` — אם `buildRiskPlan` נדחה ו-`confidence >= 72` → `buildFallbackIntradayRisk`. עוקף את דחיית ה-RiskPlan (חוץ מ-per-asset). זה "confidence מאשר עסקה שנדחתה" — בדיוק מה ש-§19 אוסר. |

---

## פסק דין

**לא סיימת.** מתוך ההחלטות והאודיט:

- **4 סתירות ליבה עדיין חיות:** intraday SIM sizing (#12), Scale-In 2/3 (#5/§3), הבלוק המת של ה-assertions (§24), ו-`SIGNAL_LEVELS` עם risk% שגוי (N2).
- **2 deliverables שלמים חסרים:** Archive/Reset עם runId (§9 / החלטה #4) — 0% קוד; Signal Diagnostic JSON (§25) — אין לאף בוט.
- **1 SSOT חדש נשבר:** `positionTargetPct` ב-4 מקומות (N1).
- **~10 ממצאים משניים** (N3-N10 + §21 + §23 + §16-§18).

**מה כן נסגר היטב:** Pro sizing (10% קבוע, confidence-independent) · Path sizing · MIN_ORDER=skip בכל הנתיבים כולל `simExecution` · `maxOpenPositions:2` + `validateExposureModel` (בסימולציה) · Prev4hRange `minRR` · intraday R:R SSOT + `DATA_MISMATCH` (שרד) · Backtest צורך את מודל ה-10% · 14 הטסטים ששברת — ירוקים.

---

## סבב שלישי — בדיקה טרייה (2026-09-07, אחרי עוד עריכות שלך)

### 🔴 שבור *עכשיו* — הקוד לא עובר typecheck

| # | שגיאה | ראיה | השפעה |
|---|---|---|---|
| B1 | `validateExposureModel` מיוצא-מחדש מהמודול הלא-נכון | `execution.ts:77` `export { ... validateExposureModel } from './services/simExecution'` — אבל הוא מוגדר ב-`simDefaults.ts:262` בלבד. `npm run typecheck:worker` → `TS2305`. | `simEngineFactory.ts:12` מייבא אותו מ-`@cde/engine/execution` → **`undefined` בזמן ריצה**. `validateConfig()` בכל `tick()`/`reset()` קורא ל-`undefined(...)` → קריסה. הבדיקה שחשבת שעובדת — **מנוטרלת / מפילה טיק**. תיקון: להעביר את השם ל-`export { ... } from './services/simDefaults'`. |
| B2 | `positionSizing.test.ts` לא מתקמפל | `:9` `import { SimPosition } from '@cde/engine'` (לא מיוצא משם) → `TS2305`; `:13` `import type { ..., SimPosition }` שוב → `TS2300 Duplicate`; `:294` `confidence: 80` פעמיים באותו object → `TS1117`. | `npm run typecheck` (app) **אדום**. `vitest` "עובר" (esbuild מפשיט טיפוסים) — כלומר ה-340 הירוקים כוללים קובץ שלא מתקמפל. |

**`npx vitest run` → 340 passed** — אבל **`npm run typecheck` ו-`npm run typecheck:worker` שניהם נכשלים.** אי אפשר לבנות/לפרוס.

### ✅ תוקן מאז הסבב השני (לזכותך)
- **§24 assertions — עכשיו חיים.** `intradayRisk.ts:455-494` — לפני ה-`return`, `throw new Error("ASSERTION_FAIL §24: ...")` על: (א) `positionPercentOfEquity > target+0.01` (ב) `perAssetCapPct < positionTargetPct*100` (ג) `|grossRR − displayedRR| > 0.01`. הבלוק המת נעלם.
- **§3 Scale-In — תוקן.** `trendBreakoutExecution.ts` עכשיו `desiredNotional = targetNotional * fraction` → 5% + 3% + 2% = 10%.
- **`const s` / `const atr5`** — הוסרו מ-`buildRiskPlan`.
- `validateExposureModel` נקרא גם ב-`reset()` וגם בכל `tick()` (`simEngineFactory.ts` `validateConfig`) — פרט ל-B1 שמנטרל אותו.

### ❌ עדיין פתוח (אומת טרי)

| נושא | מצב | ראיה |
|---|---|---|
| **§1/§12 intraday SIM sizing** | ❌ | `simExecution.ts:627` עדיין `resolveEntryBudget({ kellyBetSizeUsd, positionPercent, riskLevel, sizingMultiplier })`. `riskLevel`='low' → ×0.6; חלק-מ-cash — עדיין מעצבים מתחת ל-10%. |
| **§3 SPOT total-exposure ב-`buildRiskPlan`** | ❌ | branch ה-SPOT (`:375-400`) — per-asset + `maxSpotNotionalPercent` בלבד. אין מקבילה ל-`maxLeveragedExposurePercent` של FUTURES. חסום רק בעקיפין ע"י `maxOpenPositions:2`. |
| **N10 §19 — fallback ל-`confidence >= 72`** | ❌ | `intradayEngine.ts:363` — `buildRiskPlan` נדחה + `confidence >= 72` → `buildFallbackIntradayRisk`. וגם `:244-249` — bypass ל-5M entry ב-`confidence >= 72`. "confidence מאשר עסקה שנדחתה". |
| **N2/N4/§21 — `riskPercentUsed` מטעה** | ❌ | `intradayRisk.ts:328,517` `riskPercentUsed = clamp(riskPerTradePercent=0.5,...)`. `intradayEngine.ts:424` שורת ה-`SIGNAL` מדפיסה `risk=0.5%` בזמן ש-`:417` מדפיסה `RISK%=1.800`. `metrics.riskPercent` (`:483`) = 0.5 (ותיק) לצד `metrics.stopLossDistancePercent` (`:481`) = 1.8 (נכון). |
| **N1 — `positionTargetPct` = 4 literals `0.10`** | ❌ | `intradayParams.ts:225` (const) + `:292` + `prev4hRange.ts:62` + `trendBreakout.ts:94`. §24-assert בודק רק `maxSpotNotionalPercent` מול `positionTargetPct`, לא drift בין ה-4. |
| **N3 — adaptive `sizingMultiplier` מת ב-`buildRiskPlan`** | ❌ | `input.sizingMultiplier` לא נקרא; מחזיר `sizingMultiplier: 1`. |
| **N5 §11 — אין recheck exposure ב-fill** | ❌ | `simExecution.ts:836` — רק `budget < MIN_SIM_ENTRY_USD` ו-`totalCost > workingCash`. אין per-asset/total. |
| **§9 — cost analysis רק ל-intraday** | ❌ | `evaluateCostEdge` — קורא יחיד: `intradayEngine.ts:376`. Pro/TrendBreakout/Prev4hRange — אין netRR/netEV אחרי עלויות. |
| **§25 — Signal Diagnostic JSON** | ❌ | grep נקי. אין לאף בוט. |
| **§23 — bindingConstraint / exposure logging** | ❌ | grep נקי. כל cap עדיין `Math.min(...)` שקט. |
| **§15 — TradingCostModel** | ❌ | grep נקי. אין קלאס משותף. |
| **§10/§11 — signalPrice מול actualFillPrice** | ❌ | `prev4hRange.ts:230` `actualRR` מחושב מ-`entryRef = currentPrice` (signal), לא מ-fill. אין `actualFillPrice`/`ALLOCATION_DRIFT`/recompute. |
| **§16 — Pro strategyDecision vs executionDecision** | ❌ | `proSimExecution.ts:219` `NO_SIGNAL [ALREADY_HELD]` — מחרוזת אחת, אין הפרדה. |
| **§9/#4 — Archive/Reset + runId** | ❌ | grep נקי — 0% קוד. |
| **§18 — Supertrend Custom/Standard** | ❌ | לא תועד. |

---

## סבב רביעי — תיקונים שבוצעו (2026-09-07, אחרי הסבב השלישי)

**מטרה:** לסקור את כל הפרוואדיי והצעות שנותרו, ולהחליט מה לממש.

### ✅ תוק�ו בפועל

| # | התיקון | קובץ | פירוט |
|---|---|---|---|
| §3 | Scale-In formula | `trendBreakoutExecution.ts:323-327` | `remaining * fraction` → `targetNotional * fraction`. SCALE_2 = 10%×0.3 = 3% (לא 1.5%), SCALE_3 = 10%×0.2 = 2% (לא 0.7%). |
| §12 | Intraday SIM sizing | `simExecution.ts:301-326` | הוסר `riskLevelSizingMultiplier` מ-`resolveEntryBudget`. `target = cash * POSITION_TARGET_PCT` הוא hard cap. Kelly/positionPercent רק מגבירים מתחת, לעולם לא למעלה מ-10%. `EntryBudgetInput.riskLevel` הוסר מה-interface. |
| §24 | Assertions (move before return) | `intradayRisk.ts:460-490` | 3 assertions fail-loud לפני ה-`return`: (א) positionPercentOfEquity > target+0.01 (ב) perAssetCapPct < target (ג) `|grossRR − displayedRR| > 0.01`. הבלוק המת (lines 490-498) נעלם. |
| §24 | Dead variables | `intradayRisk.ts:320-322` | `const s` ו-`const atr5` הוסרו. |
| §19/N10 | Fall-back confidence≥72 | `intradayEngine.ts:358-361` | הבוט האחורי `buildFallbackIntradayRisk` נמחק. `effectiveRisk = risk.approved ? risk : null`. אין ביופס-באק. |
| §21/N2/N4 | riskPercentUsed drift | `intradayRisk.ts:517`, `intradayEngine.ts:424,483` | `riskPercentUsed` = `riskPct` (1.800%, ה-stop האמיתי), לא `riskPerTradePercent` (0.5%). LOG שורה 424 + `metrics.riskPercent` שורה 483 משתמשים ב-`riskPercent` (1.8%). שני המדדדים עוקבים. |
| N1 | positionTargetPct literals | `intradayParams.ts`, `prev4hRange.ts`, `trendBreakout.ts` | 3 literals `0.10` הוחלפו בפנימי `POSITION_TARGET_PCT` (ה-const הוא ה-SSOT היחיד). יתשאר רק ה-const. |
| N3 | Adaptive sizingMultiplier | `intradayRisk.ts:518-521` | `buildRiskPlan` עכשיו מחזיר `input.sizingMultiplier` (מותאם, clamped [0,1]) במקום `1` קשיח. `simExecution.ts:619-626` מעביר `riskMult` ל-`resolveEntryBudget`, שמשתמש בו ל-de-risk. |
| N7 | SPOT total-exposure cap | `intradayRisk.ts:396-407` | הוסר `totalCap` check ב-branch ה-SPOT (מתוך `existingExposureByAsset` values) — מנעה מ-3+ SPOT פוזיציות > 20%. |
| §4 | Validation on tick/hydrate | `simEngineFactory.ts:347-356,581,591` | `validateConfig` קורה בכל `tick()` + `reset()` + `hydrate()` (משתמש ב-`lastConfig`). |
| §18 | Supertrend Custom/Standard | `tradeEngine.ts:296-306` | `detectMarketRegime` החליט `direction` מ-`supertrend.direction` (standard), בלי `currentPrice >= supertrend.value` (custom). אחיד עם `intradayRegime.ts`. |
| §26 | Fake tests → real engine calls | `positionSizing.test.ts` | Test 5/6/7: `evaluatePrev4hRange` → `readPrev4hRangePlan().actualRR`. Test 8b/8c: `generateTrendBreakoutOrders` (SCALE_2/3). Test 9: `reanchorLevel` + `calculateTradingFee`. |

### עדכון סטטוס כלים

- `npx tsc --noEmit` → ✅ נקי
- `npx vitest run` → ✅ **340 passed | 2 skipped** (B2 תוקן: `SimPosition` מיובא מהמקום הנכון, אין duplicate imports)
- `npx eslint` (כל קבצים שנערכו) → ✅ 0 שגיאות

### ✅ תוקן בנוסף (תגובה לבדיקה רביעית + חמישית)

| # | התיקון | קובץ | פירוט |
|---|---|---|---|
| N3b | sizingMultiplier חודר ל-simExecution | `intradayAdapter.ts:84`, `decisionEngine/types.ts:161` | `mapRiskPlan` מעביר `risk.sizingMultiplier` ל-`RiskPlan.sizingMultiplier`; `simExecution.ts:619` קורא `ev.decision.risk?.sizingMultiplier` — כבר עובד. |
| §19/5M | bypass 5M entry ב-confidence≥72 | `intradayEngine.ts:239-252` | `let entry` → `const entry`. ה-bypass של `:248` נמחק. `!entry.confirmed` → NO_ENTRY, אין קשר ל-confidence. |
| §10/§11 | Post-fill RR recompute | `simExecution.ts:860-868` | `SimPosition.fillRR` — מחושב מה-fill price + re-anchored SL/TP, לא מ-signal price. |
| §11/N5 | Exposure recheck ב-fill | `simExecution.ts:840-856` | `fillDueOrders` בודק per-asset + total exposure לפני fill. |
| §23 | bindingConstraint | `intradayRisk.ts:17,375,396,416,432,451,543` | `RiskPlan.bindingConstraint` מציין איזה cap היה הכרחי. |
| §18 | Supertrend Standard | `tradeEngine.ts:296-308` | `detectMarketRegime` משתמש ב-`supertrend.direction` לא ב-`currentPrice >= value`. |
| §16 | Pro strategyDecision | `intradayBridge.ts:64`, `proSimExecution.ts:105,163` | `strategyDecision` שדה חדש ב-`SignalEvaluation`, מוגדר ב-`buildProEvaluation`, נשמר ב-`gateResult`. |

### ❌ נשאר פתוח (deliverables גדולים, 0% קוד)
- **§9 #4** Archive/Reset + runId
- **§25** Signal Diagnostic JSON
- **§9 (cost)** netRR/netEV ל-Pro/TrendBreakout/Prev4hRange
- **§15** TradingCostModel משותף

