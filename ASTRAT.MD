# ASTRAT.MD — מנועי אסטרטגיה מלאים + חיבור ל־execution + backtest

> קבצי מקור: `packages/engine/src/services/` ו-`server/backtestRunner.ts`  
> נכון לתאריך: 2026-09-07

---

## 1. מנוע TrendBreakout המלא (`trendBreakout.ts` + `trendBreakoutExecution.ts`)

### 1.1 פרמטרים (spec §23)

```ts
export interface TrendBreakoutParams {
  supertrendAtrPeriod: number;      // 10
  supertrendMultiplier: number;     // 3.0
  donchianPeriod: number;           // 20
  atrPeriod: number;                // 14
  volumeMultiplier: number;         // 1.2
  minConfidence: number;            // 70
  slAtrMultiplier: number;          // 1.5
  tpRMultiplier: number;            // 2.0
  riskPerTrade: number;             // 0.005 (0.5% מהקרן)
  breakEvenR: number;               // 1.0
  trailingStartR: number;           // 1.5
  trailingAtrMultiplier: number;    // 1.0
  maxHoldHours: number;             // 24
  scaleFractions: number[];         // [0.5, 0.3, 0.2]
  scale2MinR: number;               // 0.5
  scale3MinR: number;               // 1.0
  h1EmaFast: number;                // 50
  h1EmaSlow: number;                // 200
  m15EmaFast: number;               // 20
  m15EmaSlow: number;               // 50
  m5EmaFast: number;                // 9
  m5EmaSlow: number;                // 21
  minH1: number;                    // 200
  minM15: number;                   // 300
  minM5: number;                    // 30
  emaTrendFullSpread: number;       // 0.02
  breakoutFullAtr: number;          // 1.0
  volumeFullMultiplier: number;     // 1.5
  m5MaxAtrDistance: number;         // 1.0
}
```

### 1.2 זרימה (state machine — spec §6)

```
NO_DATA → NO_SIGNAL → TREND_DETECTED → SETUP → ENTRY_CONFIRMATION → SIGNAL
```

סיבות no-trade (`TrendBreakoutReason`):
- `NO_DATA` — אין מספיק נרות סגורים (H1<200, M15<300, M5<30)
- `H1_TREND_NEUTRAL` —Supertrend/EMA לא מסכימים לכיוון
- `BREAKOUT_NOT_CONFIRMED` — המחיר לא פרץ את Donchian
- `VOLUME_TOO_LOW` — ווליום < SMA20 × 1.2
- `M5_CONFIRMATION_FAILED` — EMA9/EMA21 לא מיושרים או מחיר רחוק מדי
- `ENTRY_TOO_EXTENDED` — המחיר כבר רץ מעל/מתחת ל-level ב-1×ATR(M5)
- `CONFIDENCE_BELOW_MIN` —ציון < 70

### 1.3 אינדיקטורים (סעיף 2 — closed candles only)

```ts
// H1 trend
const st = calculateSupertrend(h1, 10, 3);
const ema50 = emaLast(h1Closes, 50);
const ema200 = emaLast(h1Closes, 200);
const h1Close = h1Closes[h1Closes.length - 1];

// M15 breakout
const donch = donchian(m15.slice(0, -1), 20); // exclude breakout candle
const volSma = volumeSMA(m15.slice(0, -1), 20);
const volRatio = (m15Last.volume || 0) / volSma;

// M5 confirmation
const ema9 = emaLast(m5Closes, 9);
const ema21 = emaLast(m5Closes, 21);
const atrM5 = calculateATR(m5, 14).atr;
```

### 1.4 חישוב Score (סעיף 7)

```ts
function computeConfidence(direction, i) {
  // H1 Supertrend (25 נקודות)
  const stAligned = isLong ? i.st.direction === 'BULL' : i.st.direction === 'BEAR';
  const supertrend = (stAligned ? 1 : 0) * 25;

  // H1 EMA trend (20 נקודות) — scaled by spread
  const emaAligned = isLong ? i.ema50 > i.ema200 : i.ema50 < i.ema200;
  const spread = i.ema200 > 0 ? Math.abs(i.ema50 - i.ema200) / i.ema200 : 0;
  const emaTrend = (emaAligned ? 1 : 0) * clamp01(spread / 0.02) * 20;

  // M15 Donchian breakout (25 נקודות)
  const breakoutDist = Math.abs(i.breakoutPrice - i.brokeLevel);
  const breakout = clamp01(breakoutDist / (1.0 * (i.atrM15 || 1))) * 25;

  // Volume confirmation (15 נקודות)
  const volume = clamp01(i.volRatio / (1.2 * 1.5)) * 15;

  // M5 entry confirmation (15 נקודות)
  const m5 = clamp01(1 - i.distanceFromBreakout / (1.0 * (i.atrM5 || 1))) * 15;

  return {
    total: supertrend + emaTrend + breakout + volume + m5,
    components: { supertrend, emaTrend, breakout, volume, m5 }
  };
}
```

### 1.5 Entry / SL / TP (סעיפים 9/10)

```ts
const entryRef = currentPrice;                    // display price (M5 confirmation close)
const rUnit = slAtrMultiplier * atrM15;           // = 1.5 × ATR(M15)
const stopLoss = isLong ? entryRef - rUnit : entryRef + rUnit;
const takeProfit = isLong ? entryRef + rUnit * 2.0 : entryRef - rUnit * 2.0; // 2R
const riskPerUnit = Math.abs(entryRef - stopLoss); // = R
```

### 1.6 Stop management (סעיף 12)

```ts
export function effectiveStop(lt, livePrice, atrM15Now, p) {
  const first = lt.lots[0];
  const stop0 = first.stopLoss;
  const rUnit = Math.abs(first.entryPrice - stop0) || (Math.abs(first.entryPrice) * 0.005);
  const extreme = isLong
    ? Math.max(...lt.lots.map(l => l.highestPrice ?? l.entryPrice), livePrice)
    : Math.min(...lt.lots.map(l => l.lowestPrice ?? l.entryPrice), livePrice);
  const progressR = ((extreme - entry0) * (isLong ? 1 : -1)) / rUnit;

  let stop = stop0;
  if (progressR >= 1.0) stop = isLong ? Math.max(stop, entry0) : Math.min(stop, entry0); // break-even
  if (progressR >= 1.5 && atrM15Now) {
    const trail = isLong ? extreme - 1.0 * atrM15Now : extreme + 1.0 * atrM15Now;
    stop = isLong ? Math.max(stop, trail) : Math.min(stop, trail); // ATR trailing
  }
  stop = isLong ? Math.max(stop, stop0) : Math.min(stop, stop0); // never loosen
  return { stop, progressR };
}
```

### 1.7 Exits (סעיף 13)

```ts
// Per logical trade, closes every lot together:
if (live <= stop) reason = `Stop Loss ב-${stop}`;
else if (live >= tp) reason = `Take Profit ב-${tp} (2R)`;
else if (H1 Supertrend flipped against position) reason = `היפוך מגמה — H1 Supertrend התהפך`;
else if (now - openTimestamp >= 24 * 60 * 60 * 1000) reason = `Time Stop — 24 נרות H1`;
```

---

## 2. מנוע ה־4H המלא (`prev4hRange.ts` + `prev4hRangeExecution.ts`)

### 2.1 פרמטרים

```ts
export interface Prev4hRangeParams {
  emaPeriod: number;                // 20
  minRangePct: number;              // 0.005 (0.5%)
  maxRangePct: number;              // 0.08 (8%)
  tpRangeMult: number;              // 1.0 (~2:1 RR כי SL = mid)
  riskPerTrade: number;             // 0.005
  minConfidence: number;            // 55
  minH4Bars: number;                // 24
  maxExtensionRangeMult: number;    // 0.5
}
```

### 2.2 זרימה (Prev4hRangeState)

```
NO_DATA → NO_SIGNAL [STALE_BAR|AGAINST_TREND|RANGE_TOO_TIGHT|RANGE_TOO_WIDE|NO_BREAKOUT|ENTRY_TOO_EXTENDED]
       → ARMED → SIGNAL
```

### 2.3 חישוב מלא: נר קודם → פריצה → SL → TP → confidence → exit

```ts
// 1. בחר נר 4H סגור מלא אחרון
const prev = h4[h4.length - 1]; // last FULLY-CLOSED 4H bar
const windowStart = prev.timestamp + BAR_MS;        // תחילת החלון הבא
const windowEnd = windowStart + BAR_MS;             // סוף החלון = time stop

// 2. חפש את H, L, mid, range
const H = prev.high;
const L = prev.low;
const mid = (H + L) / 2;
const range = H - L;
const rangePct = range / prev.close;

// 3. מגמת EMA20 על 4H
const emaSeries = calculateEMA(h4.map(c => c.close), 20);
const ema = emaSeries[emaSeries.length - 1];
const emaPrev = emaSeries[emaSeries.length - 2];
const trendUp = ema > emaPrev && prev.close > ema;
const trendDown = ema < emaPrev && prev.close < ema;

if (!trendUp && !trendDown) return NO_SIGNAL [AGAINST_TREND];
if (rangePct < 0.005) return NO_SIGNAL [RANGE_TOO_TIGHT];
if (rangePct > 0.08) return NO_SIGNAL [RANGE_TOO_WIDE];

// 4. בדוק פריצה
let direction = null;
if (trendUp && currentPrice > H) direction = 'LONG';
else if (trendDown && currentPrice < L) direction = 'SHORT';

if (!direction) return ARMED [NO_BREAKOUT];

// 5. בדוק שהמחיר לא רץ יותר מדי (ENTRY_TOO_EXTENDED)
const breakoutDist = isLong ? currentPrice - H : L - currentPrice;
if (breakoutDist > range * 0.5) return ARMED [ENTRY_TOO_EXTENDED];

// 6. רמות כניסה / יציאה
const entryRef = currentPrice;
const stopLoss = mid;                               // SL = אמצע הטווח
const riskPerUnit = Math.abs(entryRef - stopLoss);  // = range/2 = R
const takeProfit = isLong ? H + range * 1.0 : L - range * 1.0; // TP = break ± range

// 7. Confidence score (0-100)
const breakout = clamp01(breakoutDist / (range * 0.5)) * 30;
const trendStrength = clamp01(Math.abs(ema - emaPrev) / (emaPrev * 0.01)) * 20;
const bandPos = (rangePct - 0.005) / (0.08 - 0.005);
const rangeScore = (1 - Math.abs(bandPos - 0.4) / 0.6) * 10;
const confidence = Math.round(40 + breakout + trendStrength + Math.max(0, rangeScore));

// 8. יציאות בפקודת prev4hRangeExecution.ts:
//    - SL = mid
//    - TP = break ± range × 1.0
//    - Time stop = סוף החלון (windowEnd)
//    - EMA20 4H trend flip (UP↔DOWN)
```

### 2.4 Sizing (prev4hRangeExecution.ts)

```ts
const rFraction = plan.riskPerUnit / price;
const desiredNotional = (ctx.equity * 0.005) / rFraction; // riskUsd / (R/entry)

// Caps:
// - per-asset: 8% מהקרן
// - total: 20% מהקרן
// - floor: $100 (MIN_SIM_ENTRY_USD) — מעלה/sub-$100 ראשונה למעלה, scale-in מדולג
```

---

## 3. הקוד שמחשב H1 Trend / Supertrend / EMA (`tradeEngine.ts`)

### 3.1 EMA

```ts
export function calculateEMA(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const ema: number[] = [];
  let sum = 0;
  const initialCount = Math.min(period, values.length);
  for (let i = 0; i < initialCount; i++) sum += values[i];
  ema.push(sum / initialCount);
  for (let i = 1; i < values.length; i++) {
    const current = values[i] * k + ema[i - 1] * (1 - k);
    ema.push(current);
  }
  return ema;
}
```

### 3.2 Supertrend (10, 3)

```ts
export function calculateSupertrend(
  candles: Candle[],
  period: number = 10,
  multiplier: number = 3
): { value: number; direction: 'BULL' | 'BEAR' } {
  const { trSeries } = calculateATR(candles, period);
  if (trSeries.every(tr => tr === 0)) {
    return { value: candles[candles.length - 1].close, direction: 'BULL' };
  }

  let upperBand = 0, lowerBand = 0, supertrend = 0;
  let direction: 'BULL' | 'BEAR' = 'BULL';

  for (let i = period - 1; i < candles.length; i++) {
    const currentATR = trSeries.slice(i - period + 1, i + 1).reduce((a,b)=>a+b,0) / period;
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUpper = hl2 + multiplier * currentATR;
    const basicLower = hl2 - multiplier * currentATR;

    if (i === period - 1) {
      upperBand = basicUpper; lowerBand = basicLower; supertrend = basicLower; direction = 'BULL'; continue;
    }
    upperBand = (basicUpper < upperBand || candles[i-1].close > upperBand) ? basicUpper : upperBand;
    lowerBand = (basicLower > lowerBand || candles[i-1].close < lowerBand) ? basicLower : lowerBand;

    if (supertrend === upperBand) direction = candles[i].close > upperBand ? 'BULL' : 'BEAR';
    else direction = candles[i].close < lowerBand ? 'BEAR' : 'BULL';

    supertrend = direction === 'BULL' ? lowerBand : upperBand;
  }
  return { value: Number(supertrend.toFixed(6)), direction };
}
```

### 3.3 הגדרת H1_TREND_NEUTRAL TrendBreakout (`trendBreakout.ts:270-276`)

```ts
let direction: TrendDirection = 'NEUTRAL';
if (st.direction === 'BULL' && ema50 > ema200 && h1Close > ema50) direction = 'LONG';
else if (st.direction === 'BEAR' && ema50 < ema200 && h1Close < ema50) direction = 'SHORT';

if (direction === 'NEUTRAL') {
  return base('NO_SIGNAL', 'H1_TREND_NEUTRAL', {}, debugFactors);
}
```

**לבדיקה על AAVE:**  
הערכים `st.direction`, `ema50`, `ema200`, `h1Close` מחושבים מ-`h1` סגור מלא.  
אם `st.direction === 'BULL'` אך `ema50 <= ema200` או `h1Close <= ema50` → `H1_TREND_NEUTRAL`.  
זאת הגדרת הבוט — אין טיפול מיוחד ב-AAVE.

---

## 4. הקוד שמחבר בין signal ל־execution (`trendBreakoutExecution.ts` + `simExecution.ts`)

### 4.1 נקודת הקישור — קריאת ה-plan מה-evaluation

```ts
// trendBreakoutExecution.ts:361
const plan = readTrendBreakoutPlan(ev);
if (!plan) continue;
const price = plan.entryRef || ev.price;   // ← HERE: entryPrice נקבע
```

`plan.entryRef` הוא `currentPrice` בזמן ה-evaluation (`trendBreakout.ts:309`).  
אם `entryRef` חסר, נופל על `ev.price` (אותו ערך).

### 4.2 בניית פוזיציה (TrendBreakout)

```ts
const riskUsd = ctx.equity * 0.005;                          // 0.5% מהקרן
const rFraction = plan.riskPerUnit / price;                   // R / מחיר
const fullNotional = rFraction > 0 ? riskUsd / rFraction : 0; // גודל מלא

const committed = placeLot({
  base: ev.symbol,
  side: plan.direction,
  desiredNotional: fullNotional * 0.5,  // SCALE_1 = 50% מהמלא
  price,                               // entryPrice בפועל
  stopLoss: plan.stopLoss,
  takeProfit: plan.takeProfit,
  confidence: ev.confidence,
  scaleLabel: `scale 1/${p.scaleFractions.length}`,
  floorBump: true                      // מעלה ל-$100 אם צריך
});
```

### 4.3 לוגיקת Fill (simExecution.ts — משותף לכל הבוטים)

```ts
// PendingOrder.flill = 'market' (TrendBreakout, 4H) או 'limit' (Pro)
// EXIT orders always market-style.

export function selectFillableOrders(pending, now, priceFor) {
  for (const o of pending) {
    if (now < o.executeAt) continue;
    // EXIT orders fire immediately after delay
    // MARKET entries fire immediately after delay
    // LIMIT entries wait for live price to cross signalPrice
    if (EXIT_ORDER_SIDES.has(o.side) || o.fill === 'market') {
      due.push(o);
    } else {
      const live = priceFor(o.symbol) ?? o.signalPrice;
      const isLong = o.side === 'buy' || o.side === 'long';
      const crossed = isLong ? live <= o.signalPrice : live >= o.signalPrice;
      if (crossed) due.push(o);
    }
  }
}
```

### 4.4 fillDueOrders — מחיר מילוי בפועל

```ts
export function fillDueOrders(due, cash, positions, priceFor, formatPrice, costs) {
  for (const o of due) {
    const isEntry = ENTRY_SIDES.has(o.side);
    const isExit = EXIT_ORDER_SIDES.has(o.side);
    const live = priceFor(o.symbol) ?? o.signalPrice;

    // For MARKET fills / exits: use live price at fill time
    // For LIMIT fills: use signalPrice (the resting limit)
    const fillPrice = (o.fill === 'market' || isExit) ? live : o.signalPrice;

    // Slippage on entry
    const slip = isEntry ? Math.abs(fillPrice - o.signalPrice) * o.quantity : 0;
    // Fee
    const fee = calculateTradingFee(notional, o.type, isEntry, costs.feePercent);
  }
}
```

---

## 5. Backtest — כניסה ויציאה (`backtestRunner.ts`)

### 5.1 פוזיציה (Intraday backtest)

```ts
function openPositionIntraday(symbol, candles, idx, decision) {
  const entryPrice = candles[idx].close;  // ← close של נר ה-5M שבו SIGLAN
  const pos: SimPosition = {
    symbol,
    type: decision.tradeType,
    side: decision.direction === 'SHORT' ? 'SHORT' : 'LONG',
    entryPrice,
    stopLoss: plan.stopLoss,
    takeProfit1: plan.takeProfit1,
    takeProfit2: plan.takeProfit2,
    quantity: plan.quantity,
    leverage: plan.leverage,
    openTimestamp: candles[idx].timestamp,
    highestPrice: entryPrice,
    lowestPrice: entryPrice,
    tp1Hit: false,
    sizeUsd: decision.tradeType === 'FUTURES' ? plan.marginUsd : plan.notionalUsd,
    initialRiskUsd: plan.riskUsd,
    maxHoldMs: plan.maxHoldMs,
    timeStopMs: plan.timeStopMs,
    plannedStopDistance: plan.stopDistance,
    setupType: decision.setupType
  };
  return pos;
}
```

### 5.2 יציאה (Intraday backtest — two paths)

```ts
function checkExitIntraday(pos, candle, history, cursors, state, params) {
  // Path 1: intrabar exact fill (SL/TP1/TP2 hit within candle range)
  const intrabar = intrabarExit(pos, candle);
  if (intrabar) {
    const exitPrice = intrabar.price; // level, not close
    const pnl = positionPnl(pos, exitPrice);
    return { shouldExit: true, exitType: ..., pnl };
  }

  // Path 2: engine's exit rules (trailing, time stop, reversal)
  const view = m5.slice(max(0, cursors.m5 - 100), cursors.m5);
  const atr5 = view.length >= 15 ? calculateATR(view, 14).atr : 0;
  const exit = evaluateIntradayExit(posView, {
    price: candle.close,
    now: candle.timestamp,
    atr5,
    params,
    portfolio: { dailyDrawdownPercent, weeklyDrawdownPercent, systemLocked: false }
  });

  if (!exit.shouldExit) return { shouldExit: false };
  const exitPrice = candle.close;
  const pnl = positionPnl(pos, exitPrice);
  return { shouldExit: true, exitType: exit.exitType, pnl, reasonCode: exit.reasonCode };
}
```

### 5.3 PnL לחישוב (Intraday backtest)

```ts
function positionPnl(pos, price) {
  if (pos.type === 'SPOT') return (price - pos.entryPrice) * pos.quantity;
  const dir = pos.side === 'LONG' || pos.side === 'BUY' ? 1 : -1;
  return (price - pos.entryPrice) * pos.quantity * dir * pos.leverage;
}
```

### 5.4 בדיקת潮汐 (Live vs Simulation)

| רכיב | Live/Simulation | Backtest |
|---|---|---|
| Entry price | `plan.entryRef` (display) → fills at live market after delay | `candles[idx].close` (H1/M15/M5 close) |
| SL/TP | `plan.stopLoss`, `plan.takeProfit` → `effectiveStop()` ב-tick | `intrabarExit()` (level fill) + `evaluateIntradayExit()` |
| Sizing | `(equity × riskPerTrade) / R` → capped by 8%/20% → floor $100 | זהה: `plan.quantity`, `plan.marginUsd`, `plan.notionalUsd` |
| Fees | `feePercent + slippagePercent` מ-`simExecution.ts` | `FEE_PERCENT=0.1%` + `SLIPPAGE_PERCENT=0.1%` קבועים |
| Exits | Stop/TP/Time stop/Supertrend flip | אותו לוגיקה דרך `evaluateIntradayExit` |

**פער ידוע:** Backtest משתמש ב-close של נר, Live/Simulation משתמשים ב-live price עם `executionDelaySec` (3 שניות). זהו עיכוב זמני מצומצם — לא פער אלגוריתמי.

---

## הערות לבדיקה

1. **AAVE / H1_TREND_NEUTRAL:**  
   הבוט לא מגדיר AAVE באופן מיוחד. `H1_TREND_NEUTRAL` נקט כאשר:
   - `Supertrend(10,3) = BULL` אך `EMA50 <= EMA200` או `close <= EMA50` → אין LONG
   - `Supertrend(10,3) = BEAR` אך `EMA50 >= EMA200`或 `close >= EMA50` → אין SHORT

2. **entryPrice אמיתי:**  
   `trendBreakout.ts:309` קובע `entryRef = currentPrice`.  
   `trendBreakoutExecution.ts:371` קורא `price = plan.entryRef || ev.price`.  
   `simExecution.ts` ממלא ב-`fillPrice = live` (market) או `signalPrice` (limit).

3. **Backtest זמין רק ל-Intraday:**  
   `backtestRunner.ts` מריץ רק את מנוע ה-Intraday (Multi-Timeframe).  
   ל-TrendBreakout ול-4H אין backtest runner נפרד — הם רצים רק כ-simulation דרך ה-worker (`server/bybitSimEngine.ts`, `server/pathSimEngine.ts`).  
   לבדיקת潮汐: השווה את `trendBreakoutExecution.ts` מול `backtestRunner.ts` סעיף 5.
