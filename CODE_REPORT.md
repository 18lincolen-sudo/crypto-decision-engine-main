# דוח קוד — crypto-decision-engine-main

נוצר: 2026-08-25 | אימות: typecheck (3 tsconfig), 90 בדיקות vitest, בדיקת דפדפן חיה (agent-browser) על כל הדפים.

## חלק א׳ — אימות תפקוד (בוצע)

נבדקו בדפדפן אמיתי, עם נתונים חיים מ-Bybit/Binance: `/`, `/portfolio`, `/simulation-bot`, `/real-trading`, `/advanced-analysis`, `/alerts`.

| דף | תוצאה |
|---|---|
| בית (Executive Dashboard) | ✅ נתונים אמיתיים (Fear&Greed=73, מחירים חיים), 0 שגיאות |
| תיק השקעות | ✅ **תוקן** (ראה חלק ב׳) — 0 שגיאות אחרי התיקון |
| בוט סימולציה (שני מנועים) | ✅ שני העמודים טוענים, $20,000 הון משולב, Risk Meter תקין |
| בוט מסחר אמיתי | ✅ מציג נכון "Worker לא מחובר" (מקומי, ללא worker רץ) — התנהגות תקינה |
| ניתוח מתקדם | ✅ BTC $78,886.8, RSI 81.35, MACD — נתונים אמיתיים |
| התראות | ✅ נטען ללא שגיאות |

שגיאת קונסול היחידה שנותרה בכל הדפים: `[Worker] fetchWorkerData error: Failed to fetch` — **צפויה** בסביבת פיתוח מקומית ללא worker רץ; מטופלת בחן (באנר שגיאה ברור, לא קריסה).

## חלק ב׳ — באג קריטי שנמצא ותוקן

**"Maximum update depth exceeded" בדף תיק ההשקעות** — שגיאה אמיתית שחזרה על עצמה בעקביות (3-4 פעמים בכל טעינה), לא רק "flaky" כפי שהוערך בטעות קודם לכן בשיחה.

**הסיבה:** גם `useSimulationBot.ts` וגם `useLegacySimulationBot.ts` (שני מנועי הסימולציה) החזיקו תבנית זהה:
```ts
const [activeMarketRegimes, setActiveMarketRegimes] = useState({});
useEffect(() => {
  const regimes = {/* נגזר מ-evaluations */};
  setActiveMarketRegimes(regimes);
}, [evaluations]);
```
כיוון ש-`LegacySimulationBotProvider` ו-`SimulationBotProvider` שניהם עוטפים את **כל האפליקציה** (ב-`App.tsx`), כל טעינת דף מפעילה אותם — ושרשרת `evaluations` (משתנה) → `setState` → render → (לולאה) חצתה את סף האזהרה של React במהלך ה-mount.

**התיקון:** הוחלף `useState`+`useEffect` ב-`useMemo` טהור בשני הקבצים — `activeMarketRegimes` הוא ערך נגזר בלבד, לא היה צריך state נפרד מלכתחילה. זה מבטל שלב שלם בשרשרת ה-render בלי לאבד פונקציונליות (הערך זהה, רק לא "מדולג" דרך state+effect).

קבצים: `src/hooks/useSimulationBot.ts`, `src/hooks/useLegacySimulationBot.ts`.

## חלק ג׳ — קוד מת (ניתן למחוק בבטחה, 0 יבוא בשום מקום)

נבדק ע"י מעקב גרף יבוא מלא — אלה **לא** מיובאים משום עמוד, קומפוננטה, או קובץ אחר:

- `src/components/RiskManagementPanel.tsx`
- `src/components/trading/TradingControlTab.tsx`
- `src/components/TradingAlerts.tsx`
- `src/components/TradingAnalytics.tsx`
- `src/components/trading/FinancialSummaryCard.tsx`
- `src/services/realBybitApi.ts` + `src/services/advancedTradingService.ts` (משמשים **רק** את 4 הקומפוננטות הראשונות — ברגע שאלה יימחקו, גם השניים האלה יהפכו ליתומים לגמרי)

**הערת אבטחה חשובה:** `realBybitApi.ts` מממש חתימת HMAC של הזמנות **בצד לקוח** (עם `apiKey`/`secretKey` בדפדפן) — זה מנוגד ישירות לעיקרון האבטחה שכבר קיים בפרויקט ("הדפדפן אף פעם לא מחזיק את הסוד של Bybit ואף פעם לא חותם על הזמנות" — רק ה-worker בשרת). הקבצים האלה לא מקושרים לשום דף כרגע (בטוחים), אבל **לעולם אל תחברו אותם מחדש** בלי להעביר את החתימה לשרת. מומלץ למחוק, לא רק להשאיר יתום.

## חלק ד׳ — כפילויות אמיתיות לאיחוד (משמרות פונקציונליות מלאה)

### 1. שליפת נרות מ-Bybit/Binance (retry + עימוד) — כפולה פי 4
`marketDataService.ts` (`fetchBybitKlines`/`fetchBinanceKlines`) הוא המימוש ה"רשמי" — כולל retry, עימוד, וסיווג כשל אמיתי. אבל `scripts/backtestCompare.ts`, `scripts/backtestSweep.ts`, ו-`scripts/decisionFunnel.ts` כל אחד מגדיר **מחדש** גרסה דומה משלו.
→ הסקריפטים (כלי פיתוח, לא קוד production) יכולים לייבא מ-`marketDataService.ts` במקום לשכפל. סיכון נמוך (לא קוד לקוח), תועלת: קוד אחיד לתחזוקה.

### 2. שליפת מחזור/ספרד (liquidity) מ-Bybit — כפולה פי 4
`bybitApi.ts` (spot בלבד), `marketDataService.ts::getLiquiditySnapshots` (spot+linear, המנוע החי), `cryptoPriceAggregator.ts`, ו-`symbolUniverse.ts` (spot+linear+inverse) — כל אחד מבצע קריאה דומה ל-`/v5/market/tickers` ומפרסר תוצאה דומה בצורה מעט שונה.
→ ניתן לאחד סביב `getLiquiditySnapshots` כמקור יחיד, ולגזור ממנו את שאר הצרכים (סינון spot-only וכו').

### 3. `SimulationBotContext.tsx` ↔ `LegacySimulationBotContext.tsx`
כמעט זהים במבנה: config state, effect לשליפת Fear&Greed, start/pause/resetAll, בניית value object מה-hook. ה-Legacy הוא גרסה מפושטת (בלי polling לשרת).
→ ניתן לחלץ factory משותף, למשל `createSimBotContextValue(engineHookResult, extras)`, ולצמצם כפילות בלי לשנות התנהגות — **בסיכון בינוני**: שני ה-context-ים בשימוש פעיל בכל האפליקציה, עדיף לבצע בזהירות עם בדיקות מקיפות.

### 4. `useSimulationBot.ts` (902 שורות) ↔ `useLegacySimulationBot.ts` (642 שורות)
אותה תבנית בדיוק למנוע הביצוע (position management, slippage, fees, exit handling) — שונה רק בלוגיקת ה-evaluation (מנוע חדש מול tradeEngine.ts הישן). זו הכפילות **הגדולה ביותר** בקודבייס.
→ ניתן לחלץ hook פנימי משותף לביצוע (execution engine) שמקבל פונקציית evaluation כפרמטר. **סיכון גבוה יחסית** (הליבה של שני מנועי המסחר בפועל) — מומלץ לבצע רק אם באמת יש כוונה להשקיע בתחזוקה ארוכת-טווח, עם בדיקות ריגרסיה מלאות לפני ואחרי.

### 5. `resolveBaseUrl` מ-localStorage — כפולה פי 3
`tradingApiClient.ts`, `liveUniverse.ts` (נוסף השבוע), ו-`WorkerAuthContext.tsx` (נוסף היום) כולם קוראים `localStorage.getItem('workerConfig')` ומפרסרים בנפרד.
→ הכי קל וזול לאיחוד: לייצא פונקציה אחת מ-`WorkerAuthContext.tsx` (או קובץ utility נפרד) ולהשתמש בה בשלושתם. **סיכון נמוך מאוד**.

## חלק ה׳ — טיפוסי `any` (איכות קוד, לא דחוף)

עשרות אזהרות `@typescript-eslint/no-explicit-any` פרוסות על הקודבייס — לא באגים פונקציונליים, לא חוסמות build. נוקו כבר בקבצים שנוצרו/נערכו השבוע (`SimulationEngineColumn.tsx`, `LegacySimulationBotContext.tsx`). שאר הקודבייס (`useSimulationBot.ts`, `SimulationBotContext.tsx`, `AIChatbot.tsx` ועוד) — עדיפות נמוכה, רפקטור נפרד.

## חלק ו׳ — קבצים גדולים (תחזוקתיות בלבד, לא דחוף)

`tradeEngine.ts` (1400 שורות), `tradingWorker.ts` (1072), `marketDataService.ts` (926), `useSimulationBot.ts` (902) — לא בעיה פונקציונלית, אבל פיצול לוגי (למשל `tradeEngine.ts` ל-regime/signals/risk/exit) יקל על תחזוקה עתידית.

## המלצת עדיפויות

1. ✅ **בוצע** — תיקון Maximum update depth (קריטי, פוגע בחוויית משתמש בפועל).
2. ✅ **בוצע** — מחיקת קוד מת (חלק ג׳: 7 קבצים, כולל `realBybitApi.ts` שחתם הזמנות בצד לקוח), איחוד `resolveBaseUrl`→`resolveWorkerBaseUrl` (חלק ד׳.5, קובץ משותף חדש `services/workerConfig.ts`).
3. ⚠️ **בוצע חלקית** — ראו "מה בוצע בפועל מחלק ד׳.1-3" למטה. איחוד שליפת liquidity/klines (ד׳.1-2) **לא בוצע** במכוון: 4 המימושים משרתים צורות נתונים שונות בפועל (מחירים+שינוי% לתצוגה, spread+turnover לשער הנזילות, קטגוריות מרובות לחישוב היקום) — איחוד אמיתי דורש הרחבת טיפוסים משותפת ובדיקות נרחבות בנתיבים שנוגעים בכסף אמיתי; לא בוצע בלי תקציב בדיקות מתאים.
4. 🔴 עדיין ממתין, רק עם זמן/תקציב לבדיקות מקיפות: איחוד מנועי הסימולציה (חלק ד׳.4 — 902+642 שורות), context factory מלא ל-Sim contexts (המבנה הכללי — polling מול לא-polling — עדיין שונה במכוון), פיצול קבצים גדולים (חלק ו׳).

### מה בוצע בפועל מחלק ד׳.1-3

- **`resolveBaseUrl` (ד׳.5):** אוחד לחלוטין ל-`src/services/workerConfig.ts::resolveWorkerBaseUrl` — `tradingApiClient.ts`, `liveUniverse.ts`, ו-`WorkerAuthContext.tsx` כולם קוראים לאותה פונקציה עכשיו. אפס כפילות.
- **Fear&Greed fetch (חלק מ-ד׳.3):** חולץ ל-`src/hooks/useFearGreedIndex.ts` משותף, משמש את שני ה-context-ים. **תוך כדי כך נמצא ותוקן חוסר-סימטריה:** `SimulationBotContext.tsx` (המנוע החדש) שלף Fear&Greed אך **מעולם לא העביר אותו** ל-`useSimulationBot()` — בפועל לא משפיע כרגע כי מנוע ה-Multi-Timeframe לא צורך את הפרמטר הזה בלוגיקת ההחלטה שלו (בניגוד למנוע הישן), אבל תוקן ליצירת סימטריה נכונה בין שני המנועים ולמניעת הפתעה עתידית אם מישהו יוסיף שימוש ב-Fear&Greed למנוע החדש.
- **קוד מת (חלק ג׳):** נמחק במלואו — 5 קומפוננטות + `realBybitApi.ts` + `advancedTradingService.ts`.
- **Context factory מלא (שאר ד׳.3):** **לא בוצע** — `SimulationBotContext.tsx` (עם polling לשרת) ו-`LegacySimulationBotContext.tsx` (client-only) עדיין שונים מבנית בכוונה; חילוץ factory מלא ביניהם נשאר בסיכון בינוני כפי שתועד, לא בוצע בסבב הזה.

כל הבדיקות (typecheck × 3 קונפיגים, 90 vitest, build worker, ובדיקת דפדפן חיה על כל הדפים) עברו נקי אחרי כל שינוי.
