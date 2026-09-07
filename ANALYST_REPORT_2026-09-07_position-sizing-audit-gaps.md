# דוח חוסרים — Audit מול התוכנית המקורית (28 סעיפים + reset)

**תאריך:** 2026-09-07
**סטטוס קוד:** מודל ה-10% הוטמע חלקית. `npm run typecheck` נקי, אבל **14 טסטים נכשלים** (ה-rewrite שבר אותם ולא עודכנו).
**מקרא:** ✅ הושלם · 🟡 חלקי · ❌ חסר · 🔷 דורש הכרעה אסטרטגית

לא בוצעה שום עריכה בדוח הזה — רק אבחון.

---

## תמצית — מה עובד ומה לא

| תחום | מצב |
|---|---|
| מודל 10% ב-`buildRiskPlan` (intraday real) | ✅ |
| מודל 10% ב-Pro / Path / TrendBreakout execution | 🟡 (הוטמע, אבל hardcoded `0.10` + חוסרים) |
| מודל 10% ב-**intraday SIM** (`simExecution.ts`) | ❌ עדיין `resolveEntryBudget` (Kelly/positionPercent/riskLevel) |
| MIN_ORDER = SKIP (לא bump) | 🟡 תוקן ב-3 קבצים, **לא** ב-`simExecution.ts` (עדיין `canBump`) |
| Startup validation ל-Exposure Caps | ❌ לא קיים (רק הערת JSDoc) |
| Diagnostic assertions (§24) | ❌ הבלוק ב-`intradayRisk.ts:465` **אחרי `return` — dead code** |
| Signal Diagnostic JSON (§25) | ❌ לא קיים לאף בוט |
| Exposure logging / bindingConstraint (§23) | ❌ caps חותכים בשקט בכל הבוטים |
| R:R SSOT — intraday | ✅ (מהמשימה הקודמת: echo levels + DATA_MISMATCH + SIGNAL_LEVELS) |
| R:R SSOT — TrendBreakout / Prev4hRange | 🟡 (levels אחידים, אבל בלי DATA_MISMATCH / cost-analysis / diagnostic line) |
| Prev4hRange `minRR` + `RR_BELOW_MIN` | ✅ |
| TrendBreakout confidence gate | ✅ בקוד (69<70 → `CONFIDENCE_BELOW_MIN`), אבל בלי assertion |
| Scale-In = חלקים מ-10% | 🟡 SCALE_1 נכון, **SCALE_2/3 undersized** (`remaining*fraction` במקום `target*fraction`) |
| `riskPerTrade=0.005` legacy | 🟡 עדיין בכל ה-params objects, לא שונה שם, עדיין נקרא ב-`intradayRisk.ts:330` |
| Reset → Firestore archive ל-BacktestResults | ❌ לא קיים בכלל |
| TradingCostModel יחיד (§15) | ❌ backtest ו-sim מיישרים ידנית, אין קלאס משותף |

---

## פירוט לפי סעיף

### §1 — Position Sizing = 10% Equity
- ✅ `buildRiskPlan` (`intradayRisk.ts:372`): `targetNotional = equity * params.positionTargetPct`. `quantity = notional/entry`. SL לא משפיע על notional.
- ✅ `POSITION_TARGET_PCT = 0.10` מוגדר ב-`intradayParams.ts:222`, וגם `positionTargetPct: 0.10` בכל params object.
- ❌ **`simExecution.ts:626` (intraday SIM)** עדיין: `rawBudget = resolveEntryBudget({ kellyBetSizeUsd, positionPercent, riskLevel, sizingMultiplier })`. זה המודל הישן. הבוט הזה לא עבר ל-10%.
- 🟡 `proSimExecution.ts:234`, `trendBreakoutExecution.ts:337,377`, `prev4hRangeExecution.ts:168` — כולם `ctx.equity * <10%>`, אבל **`proSimExecution` משתמש ב-literal `0.10`** ולא ב-`POSITION_TARGET_PCT`/param (§12).
- ❌ **`intradayRisk.ts:320` `const s = ...` ו-`:322` `const atr5 = ...` — משתנים מתים** (שרידי המודל הישן).

### §2 — SL רק למדידת סיכון
- ✅ `intradayRisk.ts:436-438`: `riskPct`, `actualRiskUsd = notionalUsd * riskPct/100` — נגזר, לא קובע.
- 🟡 `RiskPlan` מחזיר `riskPercentUsed: riskPercent` (`:461`) — שדה מבלבל: זה עדיין ה-clamp של `params.riskPerTradePercent` (0.5%), לא ה-SL distance. `stopLossUsd`/`stopLossPct` לא מדווחים בשם הזה בשום מקום (§25).

### §3 — Scale-In כחלקים מ-10%
- ✅ SCALE_1 (`trendBreakoutExecution.ts:378`): `targetNotional * scaleFractions[0]` = 10%×0.5 = 5%.
- 🟡 **SCALE_2/3 שגויים** (`:337-340`): `remaining = target - existing; desired = remaining * fraction`.
  - SCALE_2: `remaining = 10%-5% = 5%` → `5% * 0.3 = 1.5%` (צריך 3%).
  - SCALE_3: `remaining = 10%-6.5% = 3.5%` → `3.5% * 0.2 = 0.7%` (צריך 2%).
  - סה"כ ≈ 7.2%, לא 10%. הנוסחה צריכה להיות `targetNotional * fraction` (fractions מסתכמים ל-1.0).
- ✅ Logical trade אחד per base+side (`openLogicalKeys`), לא הופך ל-18-20%.

### §4 — Exposure Caps
- ✅ `PER_ASSET_EXPOSURE_CAP_PERCENT` הועלה **8 → 10** (`intradayParams.ts:231`), `MAX_TOTAL_EXPOSURE_PERCENT = 20`.
- ❌ **אין startup validation.** הדרישה: `if (perAssetCapPct < positionTargetPct) throw "PER_ASSET_CAP_BELOW_POSITION_TARGET"` — לא קיים בקוד (grep ריק). ה-JSDoc ב-`:229` אומר "Startup validation enforces this" — שקר.
- ❌ **cap שקט עדיין קיים:** `buildRiskPlan:407-410`, `trendBreakoutExecution placeLot:271-274` (`Math.min(desired, assetHeadroom, totalHeadroom, cash)`), `proSimExecution:235` — כולם חותכים מתחת ל-10% **בלי לדווח `bindingConstraint`**.
- 🟡 ב-`buildRiskPlan` ה-per-asset cap חל **רק על FUTURES** (בתוך ה-`else`), SPOT מדלג עליו לגמרי. גם אין בדיקת total-exposure ל-SPOT → 7 פוזיציות SPOT × 10% = 70% בלי תקרה.

### §5 — Minimum Order / floorBump
- ✅ `buildRiskPlan:426-428` → `rejected("...MIN_ORDER_EXCEEDS_POSITION_TARGET")`.
- ✅ `proSimExecution:237`, `trendBreakoutExecution:380`, `prev4hRangeExecution:170,181` → skip (עם reason/comment).
- ❌ **`simExecution.ts:639-643` עדיין עושה bump:** `canBump = cash>=100 && equity>=100; budget = raw>=100 ? raw : canBump ? 100 : raw`. זה בדיוק התרחיש האסור (Equity $500, target $50 → $100 = 20%).
- ❌ `simExecution.ts:844` `Math.min(order.budgetUsd ?? 100, ...)` — ברירת מחדל `?? 100` = bump סמוי בזמן fill.
- ❌ אין `reasonCode` מובנה (מחרוזת עברית בלבד), אין מנגנון Override מפורש.
- 🟡 `trendBreakoutExecution placeLot` עדיין נושא param `allowMinOrderOvershoot` (ה-`floorBump` הישן). כרגע אף קורא לא מעביר `true`, אבל הנתיב קיים.

### §6 — TrendBreakout Confidence Contradiction
- ✅ הקוד תקין: `trendBreakout.ts:332-370` — `confidence < minConfidence` → `state:'ENTRY_CONFIRMATION'`, `reasonCode:'CONFIDENCE_BELOW_MIN'`, `willExecute:false`, status `NO_SIGNAL [CONFIDENCE_BELOW_MIN]`.
- ✅ `simEngineFactory` לא עוקף — הוא סומך על `ev.willExecute` מהאסטרטגיה, לא מחשב מחדש.
- ❌ **לא הצלחתי לשחזר "69 → SIGNAL" מהקוד הנוכחי.** חשודים לבדיקה:
  1. `confidence = Math.round(c.total)` (`:328`) — `c.total = 69.5` → 70 → עובר; ה-UI אולי מציג floor 69.
  2. `minConfidenceOverride` בקונפיג של הבוט.
  3. התצפית קדמה לתיקון.
- ❌ אין `assert(confidence >= minConfidence || !willExecute)` (§24) שיתפוס רגרסיה.

### §7 — Prev4hRange R:R Contradiction
- ✅ `minRR: 1.2` param (`prev4hRange.ts:53,66`).
- ✅ `actualRR` מחושב מ-levels אמיתיים (`:228-230`), gate `RR_BELOW_MIN` (`:232-234`).
- ✅ ההערה תוקנה (`:35-37`): "at d=0 RR=2.0, at d=0.5*range RR=0.5".
- ✅ מתמטית: d=0.5R → risk=R, reward=0.5R → RR=0.5 < 1.2 → נחסם. ✔️

### §8 — R:R מאותם נתונים (13.3119 → 1.67 לא 3.44)
- ✅ **intraday:** `CostAnalysis` מחזיר echo של `entryPrice/stopLoss/takeProfit1` (`intradayRisk.ts:18-20`), `RiskPlan` מחזיר `entryPrice/riskPercent/rewardPercent/grossRewardRisk` (`:236-247`), `intradayEngine` בודק `DATA_MISMATCH` ב-1e-8 ומדפיס `SIGNAL_LEVELS`. טסט: `intradayRRConsistency.test.ts`.
- 🟡 **TrendBreakout / Prev4hRange:** ה-levels אחידים בתוך ה-plan, אבל **אין assertion `abs(calculatedRR - displayedRR) < tol`**, אין DATA_MISMATCH, ואין שורת diagnostic. ה-plan נושא `actualRR` אבל שום דבר לא מוודא שה-UI מציג בדיוק אותו.

### §9 — Fees + Slippage מפורש
- ✅ **intraday:** `evaluateCostEdge` מחזיר `entryFeePercent / exitFeePercent / slippagePercent / totalCostPercent / rewardPercent / netRewardRisk / grossRewardRisk` — כולם מ-`entry/SL/TP1` זהים.
- ❌ **TrendBreakout / Prev4hRange / Pro:** אין `evaluateCostEdge` בכלל בשרשרת הסיגנל שלהם. אין Gross/Net RR אחרי עלויות, אין netEV. הסיגנל שלהם לא יודע מה העלות.
- 🟡 `costSafetyMultiplier: 2.0` — עדיין "expected move > cost × 2" ב-`evaluateCostEdge:141`. §9 אומר לא להשתמש בחישוב מעורפל כזה; הוא עדיין קיים (במקביל ל-netRR המפורש).

### §10 — signalPrice מול actualFillPrice
- ❌ **TrendBreakout:** `entryRef = currentPrice` (`trendBreakout.ts:318`), Market order מתמלא מאוחר יותר ב-live. הקוד לא מפריד `signalPrice` / `expectedEntry` / `actualFillPrice`. אין חישוב-מחדש של `actualRR/actualFees/actualNotional` אחרי fill.
- ❌ אותו דבר Prev4hRange (`entryRef = currentPrice`, `:222`).
- 🟡 השרת שומר `signalPrice` על ה-order וה-fill קורה ב-`fillDueOrders`, אבל אין recompute+report של הכלכלה בפועל.

### §11 — Position Target מול Actual Fill
- ❌ אין תיעוד של `targetNotional / requestedNotional / actualNotional / targetAllocationPct / actualAllocationPct`. אין `ALLOCATION_DRIFT`.
- ❌ אין בדיקת exposure מחדש **בזמן fill** — רק בזמן יצירת ה-order (`fillDueOrders:844` בודק רק `budget < MIN_SIM_ENTRY_USD` ו-`workingCash`).

### §12 — Parameter Source of Truth
- 🟡 `positionTargetPct` בפרמטרים ✔️, אבל hardcoded:
  - `proSimExecution.ts:234` → `ctx.equity * 0.10` (literal).
  - `trendBreakoutExecution.ts:136,324` → fallback R-unit `Math.abs(entry) * 0.005` (literal).
  - `trendBreakout.ts computeConfidence` → משקלי `25/20/25/15/15` hardcoded, לא בפרמטרים, לא נחשפים כ-`weight` (חוסם את §17).
  - `FIXED_SL_PERCENT = 1.8` / `FIXED_TP_PERCENT = 3.0` — קבועי מודול, לא ב-`IntradayParams` (מכוון — אבל אז אין "Definition → Usage → Validation → Diagnostic" מלא).
- ❌ אין Audit מסודר של "כל number literal שקשור לאסטרטגיה".

### §13 — Closed Candle Consistency
- 🟡 `trendBreakout.ts` מתעד "closed candles only" והקורא (`bybitSimEngine`) מעביר `snap.h1/m15/m5`. אבל `currentPrice = input.priceFor(baseAsset) ?? snap.livePrice` — **live price**, ומשמש כ-`entryRef` וגם ב-`distanceFromBreakout`. אין timestamp נפרד ל-signal-candle-close מול current-market-price מול fill.
- ❌ אין הפרדה מפורשת של שלושת ה-timestamps (§13).

### §14 — Prev4hRange Candle Closure
- ✅ `barOpenFor(now) !== windowStart` → `STALE_BAR` (`prev4hRange.ts:177`). `aggregateToH4` פולט רק ברים סגורים (group.length >= 4). `prev = h4[h4.length-1]` תמיד סגור.
- ✅ בעצם הדרישה מולאה — אבל שם ה-reason הוא `STALE_BAR` ולא `OPEN_CANDLE` (סמנטיקה קרובה).

### §15 — Backtest מול Sim/Live Economics
- 🟡 `backtestRunner.ts:333-337` — משתמש ב-`calculateTradingFee` (אותה טבלת Bybit כמו sim) + `DEFAULT_SLIPPAGE_PERCENT = 0.05%` **דטרמיניסטי** במקום ה-random 0.05-0.15% של הסימולציה. ההבדל מתועד בהערה.
- ❌ **אין `TradingCostModel` יחיד** שמשמש את כל 4 המסלולים. היישור ידני ושביר.

### §16 — Pro Bot HOLD מול ALREADY_HELD
- ❌ אין הפרדה `strategyDecision` / `executionDecision`. ה-status הוא מחרוזת אחת. ה-UI עדיין יכול להראות "HOLD confidence 77.4 / NO_SIGNAL [ALREADY_HELD]" כאילו המודל אמר HOLD בגלל חולשה.

### §17 — Pro Bot Confidence Reproducibility
- ❌ לא נבדק מלא. צריך לוודא ש-`Displayed Confidence == Σ(component × weight)` עם כל component/weight/contribution מוצגים. `proAlgEngine.ts` לא נבדק לעומק כאן.

### §18 — Supertrend Implementation
- 🟡 `tradeEngine.ts:217 calculateSupertrend` — "rolling ATR" (`:239`). לא ברור אם Wilder smoothing (השורה "Wilder's smoothing" ב-`:153` שייכת לפונקציה אחרת).
- ❌ **שתי קביעות כיוון שונות:** הפונקציה מחזירה `.direction` מ-band-flip (`:262`), אבל regime classifier ב-`:299` מחליט BULL/BEAR לפי `currentPrice >= supertrend.value`. לא מתועד אם Custom או Standard.

### §19 — Confidence אינו תחליף ל-Trade Quality
- 🟡 **intraday:** יש `netRewardRisk >= minRewardRisk` + cost gate → קרוב.
- ❌ **Pro:** רק `confidence >= minConfidence` + allocation. אין `RR >= minRR`, אין `netEV > 0`.
- ❌ **TrendBreakout / Prev4hRange:** confidence + (prev4h גם minRR). אין netEV אחרי עלויות.

### §20 — AAVE (לא באג)
- ✅ אין special case ל-AAVE. `trendBreakout.ts:281` דורש `h1Close > ema50` ל-LONG → `H1_TREND_NEUTRAL` עקבי.

### §21 — Risk Per Trade Legacy
- ❌ **לא טופל.** `riskPerTradePercent: 0.5` / `maxRiskPerTradePercent: 0.75` עדיין ב-`IntradayParams` (מסומן Deprecated ב-JSDoc בלבד).
- ❌ `buildRiskPlan:330` עדיין: `clamp(input.riskPercent ?? params.riskPerTradePercent, 0.05, params.maxRiskPerTradePercent)` — הפרמטר עדיין **נקרא**, התוצאה נשמרת כ-`riskPercentUsed`.
- ❌ `riskPerTrade: 0.005` עדיין בכל params object (trendBreakout / prev4hRange) עם שם מטעה, לא "derived stop risk".
- ❌ `simExecution.ts` intraday sim עדיין נשען על `riskLevel`/`positionPercent` (מודל סיכון ישן).

### §22 — Max Concurrent Trades
- ❌ **לא עקבי.** `maxConcurrentTrades = input.maxPositions || 5` (bybit), `SIM_BASE_DEFAULTS.maxPositions = 5`. עם 10% target ו-20% total cap → צריך **2**. כרגע מותר לפתוח 5 logical trades; ה-3-5 מקבלים `notional = 0` מ-`placeLot` **בלי reason `MAX_CONCURRENT`**.
- ❌ `prev4hRangeExecution:160` — `positionCount >= ctx.maxPositions` (לא מוגבל ל-2).
- ❌ `buildRiskPlan` — `maxOpenPositions: 7` ב-defaults, לא הותאם ל-exposure model.

### §23 — Exposure Logging
- ❌ **לא קיים בשום בוט.** אין שמירה של `equity/positionTargetPct/targetNotional/requestedNotional/assetExposureBefore/After/totalExposureBefore/After/actualNotional/actualAllocationPct/bindingConstraint`. כל cut של size שקט.

### §24 — Diagnostic Assertions
- ❌ **הבלוק ב-`intradayRisk.ts:465-473` נמצא אחרי `return` (שורות 440-463) → קוד מת. שום assertion לא רץ.**
- ❌ אין `assert(positionTargetPct === 0.10)`, `assert(perAssetCapPct >= positionTargetPct)`, `assert(actualNotional <= allowedExposure + tol)`, `assert(confidence >= minConfidence || !willExecute)`, `assert(abs(calculatedRR - displayedRR) < tol)`.
- ❌ אין את קודי השגיאה: `ENTRY_SL_TP_INCONSISTENCY`, `RR_CALCULATION_MISMATCH`, `CONFIDENCE_THRESHOLD_BYPASS`, `POSITION_SIZE_MODEL_MISMATCH`, `EXPOSURE_CAP_CONFLICT`, `MIN_ORDER_OVERSIZE`, `FILL_PRICE_DRIFT`, `COST_CALCULATION_MISMATCH`, `OPEN_CANDLE_USED`, `PARAMETER_HARDCODED`. (רק `DATA_MISMATCH` ל-intraday קיים.)

### §25 — Required Diagnostic Output (JSON per Signal)
- ❌ **לא קיים לאף בוט.** אין הדפסה/שמירה של ה-JSON המלא (symbol/signal/confidence/signalPrice/actualFillPrice/grossRR/fees/slippage/netRR/equity/targetNotional/actualNotional/stopLossUsd/exposure before-after/bindingConstraint/reasonCode/valid).
- 🟡 intraday מדפיס שורת log טקסטואלית `SIGNAL_LEVELS ...` — לא JSON, לא כולל exposure/notional/fill.

### §26 — Required Test Cases
- 🟡 קיימים: Test 4 (confidence<min → block) ב-`trendBreakout.test.ts`; Test 5/6 (prev4h RR) ב-`prev4hRange.test.ts`; Test 7 (13.3119 → 1.67) ב-`intradayRRConsistency.test.ts`.
- ❌ **חסרים:** Test 1/2 (equity → target notional מפורש 10%), Test 3 ($500/$50/$100 → `MIN_ORDER_EXCEEDS_POSITION_TARGET`), Test 8 (scale-in 50/30/20 = $50/$30/$20), Test 9 (market fill drift → recompute).
- ❌ **14 טסטים קיימים נשברו מה-rewrite ולא עודכנו:**
  `thresholdSourceOfTruth.test.ts` (7), `prev4hRange.test.ts` (3), `pathEngine.test.ts` (2), `duplicatePositionStacking.test.ts` (2). כולם על sizing/budget שהשתנה מ-risk-based ל-10%.

### §27 — עיקרון: אין "לתקן מספרים בתצוגה"
- ✅ intraday עומד בזה (SSOT + DATA_MISMATCH).
- 🟡 שאר הבוטים — ה-pipeline `Source → Single Calc → Validation → Signal → Execution → Fill → Recalc → Report` שבור אחרי "Signal" (אין Recalc אחרי fill, אין Report JSON).

### §28 — Deliverables
| # | פריט | מצב |
|---|---|---|
| 1 | קוד מתוקן | 🟡 חלקי |
| 2 | רשימת קבצים ששונו | ❌ לא סופקה (ראה git diff) |
| 3 | רשימת סתירות שנמצאו | ❌ לא מתועדת |
| 4 | רשימת סתירות שתוקנו | ❌ לא מתועדת |
| 5 | סתירות שדורשות הכרעה | ❌ לא מתועדת |
| 6 | Unit Tests | 🟡 חלקי + 14 שבורים |
| 7 | JSON של Signal תקין | ❌ |
| 8 | JSON של Signal חסום ב-Confidence | ❌ |
| 9 | JSON של Signal חסום ב-RR | ❌ |
| 10 | JSON Position Sizing ל-$1,000 / $10,000 | ❌ |
| 11 | הסבר Scale-In | ❌ (וגם הקוד undersized) |
| 12 | הסבר Exposure Caps | ❌ |
| 13 | הסבר Fees + Slippage | ❌ |
| 14 | אין שימוש נסתר ב-`riskPerTrade=0.005` ל-sizing | ❌ עדיין נקרא ב-`intradayRisk.ts:330` + `simExecution.ts` |

---

## דרישה נוספת — Reset ו-Firestore Archive ל-BacktestResults

**מצב נוכחי:** ❌ לא מיושם כלל.

- שני הכפתורים ב-`SimulationBot.tsx` מריצים בסוף את אותו דבר:
  - "אפס את כל הבוטים" → `groupAction(allBots, 'resetAll')` → כל קונטקסט קורא ל-`/api/{bot}/reset` בשרת → ה-snapshot (positions/cash/trades/history) **נמחק**.
  - "איפוס מטמון + שרת" (`clearAllCache`, `:106`) → מוחק localStorage keys **וגם** קורא ל-`resetAll` על כל בוט → אותו מחיקה בשרת.
- אין הבחנה בהתנהגות הנתונים, ואין ארכיון של ה-trades לפני reset.
- Firestore persistence כן קיים בשרת (`tradingWorker.ts:1474,1530`) — לזה state חי בלבד, לא ארכיון היסטורי.
- `BacktestResults.tsx` קורא רק מ-live contexts (`ctx.trades`) — אין קריאה מארכיון.

**מה צריך להיבנות (design, לא קוד):**
1. **`resetAll` (per bot)** — לפני שמנקים את ה-snapshot: append `snapshot.trades` + `history` + מטא (botId, resetAt, startCapital) ל-collection Firestore חדש, למשל `bot-history-archive/{botId}/runs/{runId}`. ואז reset רגיל של הבוט להתחלה.
2. **`BacktestResults.tsx`** — למזג `archivedTrades` (מ-Firestore, endpoint שרת חדש `GET /api/backtest-archive?bot=`) עם ה-live trades, עם דגל "run" לכל קבוצה כדי לאבחן.
3. **`clearAllCache`** — צעד נוסף: `DELETE /api/backtest-archive` (מוחק את כל ה-`bot-history-archive`), בנוסף ל-reset הרגיל. כלומר: הבוטים מתאפסים להתחלה **וגם** הארכיון נמחק.
4. הבחנה מפורשת ב-UI: כפתור "אפס" → "הפוזיציות יאופסו, ההיסטוריה נשמרת ל-BacktestResults"; כפתור "איפוס מטמון + שרת" → "הכל נמחק כולל היסטוריה".

**נקודות פתוחות להכרעה:**
- מפתח הארכיון: per-reset run, או append רציף לאותו doc?
- retention: כמה runs לשמור?
- האם גם עסקאות פתוחות בזמן reset נסגרות-לוגית לארכיון (mark-to-market) או נזרקות?

---

## 🔷 סתירות שדורשות הכרעה אסטרטגית (לא ניתן "לתקן" בלי החלטה)

1. **`maxOpenPositions` / `maxConcurrentTrades` מול Exposure Model.** 10% target + 20% total = 2 פוזיציות. הערכים כרגע 5-7. או שמורידים ל-2, או שמגדילים `totalExposureCapPct`, או שמקבלים שהעודף נחסם עם reason `MAX_CONCURRENT`.
2. **per-asset cap על SPOT.** כרגע חל רק על FUTURES ב-`buildRiskPlan`. להחיל על SPOT? ואז `maxSpotNotionalPercent: 15` סותר את per-asset 10%.
3. **מודל ה-sizing של intraday SIM.** להעביר את `simExecution.ts` ל-`positionTargetPct` (כמו 3 האחרים) — זה שינוי התנהגות מהותי לבוט הראשי בסימולציה.
4. **`FIXED_SL_PERCENT`/`FIXED_TP_PERCENT` כמודול-const מול param.** אם רוצים "Definition → Validation → Diagnostic" מלא (§12), הם צריכים להיכנס ל-`IntradayParams`.
5. **Supertrend Custom מול Standard** (§18) — צריך החלטה מפורשת + תיעוד או התאמה.
6. **`costSafetyMultiplier` (expected move > cost × 2)** מול הדרישה למודל עלויות מפורש בלבד (§9). להסיר את הגייט הזה או להשאיר במקביל?

---

## קבצים רלוונטיים (למי שממשיך)

| קובץ | תפקיד באודיט |
|---|---|
| `packages/engine/src/services/intradayRisk.ts` | `buildRiskPlan` (10% ✔️, assertions dead ❌), `evaluateCostEdge` (SSOT ✔️) |
| `packages/engine/src/services/intradayParams.ts` | `POSITION_TARGET_PCT`, caps, `riskPerTradePercent` legacy |
| `packages/engine/src/services/intradayEngine.ts` | `DATA_MISMATCH`, `SIGNAL_LEVELS` (intraday בלבד) |
| `packages/engine/src/services/simExecution.ts` | intraday SIM — עדיין risk-based + `canBump` ❌ |
| `packages/engine/src/services/proSimExecution.ts` | 10% ✔️ (hardcoded `0.10`), MIN_ORDER skip ✔️ |
| `packages/engine/src/services/trendBreakout*.ts` | confidence gate ✔️, scale-in undersized ❌, no cost/RR-assert |
| `packages/engine/src/services/prev4hRange*.ts` | `minRR` ✔️, candle-closure ✔️, no diagnostic JSON |
| `server/backtestRunner.ts` | cost model נפרד (§15) |
| `server/tradingWorker.ts` | reset routes + Firestore (אין archive) |
| `src/pages/SimulationBot.tsx` | `clearAllCache` / `resetAll` — אין הבחנת נתונים |
| `src/pages/BacktestResults.tsx` | קורא live בלבד — אין קריאת archive |
