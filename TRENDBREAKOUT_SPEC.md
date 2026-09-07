# מפרט מלא — בוט הסימולציה הרביעי: `TrendBreakout` ("Bybit")

> זהו המפרט שהמשתמש מסר. הבוט מיושם ממנו מילה במילה, ללא אופטימיזציה
> (ראה §24, §27). **סימולציה בלבד — אין שליחת פקודות אמיתיות ל-Bybit ואין
> קידום לכסף אמיתי עד להחלטה נפרדת.**
>
> מימוש: `packages/engine/src/services/trendBreakout.ts` (סיגנל) +
> `packages/engine/src/services/trendBreakoutExecution.ts` (גודל/scale/יציאות)
> + `server/bybitSimEngine.ts` (חיבור לתשתית הסימולציה המשותפת).
> תקציר קצר יותר עם הפניות `file:line`: `BOTS_REFERENCE.md` §4.

---

בנה **בוט סימולציה חדש ועצמאי לחלוטין** בשם `TrendBreakout`. הבוט אינו
Consensus של Intraday / Pro / Path ואינו משתמש בסיגנלים שלהם. הוא משתמש רק
בלוגיקה המוגדרת כאן. יחד עם זאת, הוא משתמש בנתוני ה-OHLCV / market data
הקיימים בפרויקט (אין Data Feed כפול), ובתשתית האחסון / logging / Simulation
הקיימת.

## 1. Market Data
H1 — מגמה והקשר. M15 — פריצה ואישור. M5 — תזמון כניסה. רק נרות **סגורים**.
אין נתונים עתידיים / candle לא סגור.

## 2. אינדיקטורים (כולם configurable)
- H1: ATR(14) · Supertrend(ATR 10, mult 3.0) · EMA50 · EMA200 · Donchian(20)
- M15: ATR(14) · Donchian(20) · EMA20 · EMA50 · Volume SMA(20)
- M5: ATR(14) · EMA9 · EMA21 · Volume SMA(20)

## 3. הגדרת מגמה
LONG רק אם `Supertrend=UP AND EMA50>EMA200 AND Close>EMA50`. SHORT = המראה.
אחרת `TREND=NEUTRAL` → אין עסקה.

## 4. Breakout Signal (M15)
LONG: `Close > previous Donchian High(20)` **וגם** `Volume >= VolumeSMA20 × 1.2`
**וגם** בכיוון מגמת H1. SHORT = המראה מול `Donchian Low(20)`.

## 5. M5 Entry Confirmation
לא נכנסים מיד עם הפריצה. לאחר SETUP ב-M15 מחכים לאישור M5:
LONG: `EMA9 > EMA21 AND Close > EMA9`, ומחיר הכניסה במרחק ≤ `1.0 × ATR(M5)`
ממחיר ה-breakout (אחרת `ENTRY = INVALID`, לא רודפים). SHORT = המראה.

## 6. Signal States
`NO_SIGNAL → TREND_DETECTED → SETUP → ENTRY_CONFIRMATION → SIGNAL → IN_POSITION → EXIT`.
Signal רק כשכל התנאים מתקיימים.

## 7. Confidence Score (0–100, לא הסתברות)
H1 Supertrend 25 · H1 EMA trend 20 · M15 Donchian breakout 25 ·
Volume confirmation 15 · M5 entry confirmation 15. סף כניסה `MIN_CONFIDENCE = 70`.

## 8. Entry
כניסה במחיר ה-M5 הסגור הבא / מחיר ה-execution של הסימולציה. תיעוד: signal ts,
signal candle, breakout price, entry price, confidence, ATR, trend, position
size, SL, TP. **אין כניסה כפולה על אותו breakout.**

## 9. Stop Loss (דינמי, ATR)
LONG: `SL = Entry − ATR(M15) × 1.5` · SHORT: `SL = Entry + ATR(M15) × 1.5`.
`R = |Entry − SL|`.

## 10. Take Profit
`TP = Entry ± R × 2.0` (Risk/Reward 1:2).

## 11. SCALE — Scale-in מדורג (לא פותחים הכול בבת אחת)
ברירת מחדל 50% / 30% / 20%. SCALE_2 (30%) רק אם המחיר ≥ +0.5R **וגם** המגמה
תקפה **וגם** אין ביטול setup. SCALE_3 (20%) רק אם המחיר ≥ +1.0R **וגם**
Supertrend עדיין בכיוון **וגם** אין Exit Signal. סך כל ה-scale-ins ≤ Max
Position Size של Risk Engine. **אין הגדלת פוזיציה בהפסד — NO MARTINGALE,
NO AVERAGING DOWN.**

## 12. Stop Management
ב-+1R → הזז SL ל-Break Even (`SL = Entry`). ב-+1.5R → trailing stop במרחק
`1 × ATR(M15)`, מתקדם רק בכיוון הרווח, לעולם לא מתרחק אחרי שהוקטן.

## 13. Exit Conditions
A. SL נחצה. B. TP נחצה. C. Trend Reversal — LONG נסגרת אם H1 Supertrend → DOWN
(SHORT → UP). D. Time Stop — אחרי 24 נרות H1. E. Invalidated Setup — חוסם
scale נוסף (לא סוגר).

## 14. Risk Management
`riskAmount = equity × 0.5%` ; `positionSize = riskAmount / distance_to_SL`.
לא אחוז שרירותי — ה-SL קובע את הגודל.

## 15. Exposure Limits
`MAX_ASSET_EXPOSURE = 8% equity` · `MAX_TOTAL_EXPOSURE = 20% equity`.
אין מספיק equity/margin → `NO_ENTRY`.

## 16. Drawdown Protection
Daily DD ≥ 8% → BLOCK new entries. Weekly DD ≥ 15% → LOCK new entries.
לא סוגר פוזיציות קיימות אוטומטית בגלל ה-breaker.

## 17. Simulation Execution
מתחשב ב-Trading Fee / Slippage / Spread / Funding כשרלוונטי. `signalPrice ≠
executionPrice`.

## 18. No Lookahead
אסור future candle / high / low / volume / indicator / outcome ליצירת Signal.

## 19. Data Reuse
משתמש בנתוני H1/M15/M5/Ticker/Volume הקיימים. **לא** יוצר API client נוסף,
**לא** משתמש בלוגיקה של Intraday/Pro/Path לייצור הסיגנל.

## 20. Isolation
positions / trades / PnL / state / configuration / statistics משלו. עסקה של
TrendBreakout לא משנה state של Intraday/Pro/Path.

## 21. Backtest + Simulation — אותה פונקציית Strategy
`Market Data → TrendBreakoutStrategy → Signal → Risk Engine → Simulation
Execution`. אין לוגיקה כפולה.

## 22. Output לכל Candle (debug)
timestamp · symbol · H1 trend · Supertrend · EMA50 · EMA200 · M15 Donchian ·
M15 volume ratio · M5 EMA9 · M5 EMA21 · confidence · setup state · entry state ·
signal · reason. סיבות ל-NO_SIGNAL: `H1_TREND_NEUTRAL`,
`BREAKOUT_NOT_CONFIRMED`, `VOLUME_TOO_LOW`, `M5_CONFIRMATION_FAILED`,
`ENTRY_TOO_EXTENDED`, `CONFIDENCE_BELOW_MIN`, `RISK_LIMIT`.

## 23. פרמטרים configurable (ללא אופטימיזציה אוטומטית בשלב ראשון)
`SUPERTREND_ATR_PERIOD=10` · `SUPERTREND_MULTIPLIER=3.0` · `DONCHIAN_PERIOD=20` ·
`ATR_PERIOD=14` · `VOLUME_MULTIPLIER=1.2` · `MIN_CONFIDENCE=70` ·
`SL_ATR_MULTIPLIER=1.5` · `TP_R_MULTIPLIER=2.0` · `RISK_PER_TRADE=0.5%` ·
`BREAK_EVEN_R=1.0` · `TRAILING_START_R=1.5` · `TRAILING_ATR_MULTIPLIER=1.0` ·
`MAX_HOLD_HOURS=24`. ראה `DEFAULT_TREND_BREAKOUT_PARAMS` ב-`trendBreakout.ts`.

## 24. מטרת שלב ראשון
Correctness · Reproducibility · No Lookahead · Correct Execution · Correct Risk ·
Clean Architecture. אופטימיזציה רק אחר כך.

---

## החלטות מודל (התנגשות עם רכיבים קיימים — הוכרעו מול המשתמש)

- **Scale-in:** מנוע המילוי המשותף (`fillDueOrders`) לא יודע להוסיף לפוזיציה,
  לכן כל scale הוא `SimPosition` נפרד; עסקה לוגית = כל ה-lots עם אותו
  בסיס+כיוון, אותו SL/TP, נסגרים יחד.
- **SHORT:** בסימולציה אי-אפשר לשרטט ב-SPOT → SHORT = `FUTURES` מינוף 1x.
  `maxFuturesPositions = 3` ב-registry (בניגוד ל-Pro/Path = 0).
- **Funding:** נוסף למנוע המשותף (`applyFundingAccrual`) ומוחל על **כל ארבעת
  הבוטים** אחיד, כדי לשמור מודל עלויות זהה. בפועל רק ה-futures של Intraday
  והשורטים של Bybit מרגישים אותו.
- **תקרת נכס 8% מול סיזינג לפי סיכון:** ה-SL הדוק גורם לתקרת ה-8% להיות
  לרוב האילוץ הכובל — התוצאה: הסיכון בפועל לעסקה לרוב < 0.5%. זו הקריאה
  הסטנדרטית של "סיזינג לפי סיכון עם תקרות חשיפה" (כמו ב-Path).
