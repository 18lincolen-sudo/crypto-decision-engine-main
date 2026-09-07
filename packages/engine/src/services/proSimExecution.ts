/**
 * "Bot Pro" — order generation for the alg.md engine.
 * ============================================================================
 * Three layers, each owning exactly what alg.md gives it:
 *
 *   buildProEvaluation  — §2's weighted signal for one symbol + §4's gate 4
 *                         (the confidence threshold), as the SignalEvaluation
 *                         shape every bot's UI column reads.
 *   applyProEntryGates  — §4's FULL gate sequence, evaluated once on the
 *                         evaluation itself so it is the single source of truth
 *                         for both the panel and the executor, in the doc's own
 *                         order, over a confidence-descending batch.
 *   generateProOrders   — §5's exits first (fixed % + the confidence-gated
 *                         flip-to-SELL), then the buy orders the evaluations
 *                         already approved. Entries are §6's delayed MARKET
 *                         fills (fill: 'market').
 *
 * Spot only, per §4's explicit "the system does not open shorts": a SELL
 * signal on a symbol with no open position produces no order at all, it only
 * closes a position that already exists.
 */
import {
  computeProSignal,
  evaluateProExit,
  proMinConfidence,
  proTechnicalScore,
  proAllocationPercent,
  calculateOptimalEntryPrice,
  MIN_PRO_CANDLES,
  type ProSignalResult,
  type ProRiskLevel
} from './proAlgEngine';
import { PER_ASSET_EXPOSURE_CAP_PERCENT, POSITION_TARGET_PCT } from './intradayParams';
import type { Candle } from './tradeEngine';
import type { SignalEvaluation, DecisionFactor } from './intradayBridge';
import type { SimPosition, PendingOrder } from './simExecution';
import { MIN_SIM_ENTRY_USD } from './simExecution';

export const uid = (p: string) => `pro-${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export { MIN_PRO_CANDLES };

/**
 * §2/§4 for one symbol: computes the weighted signal and the threshold-only
 * view of §4 (gate 4), as the same SignalEvaluation shape every other bot's
 * UI column reads. §4's STATE gates (queued / held / slots / price / budget)
 * are applied per batch by applyProEntryGates — they need the portfolio,
 * which a per-symbol call does not see.
 */
export function buildProEvaluation(
  symbol: string,
  candles: Candle[],
  currentPrice: number,
  priceChange24h: number,
  riskLevel: ProRiskLevel,
  minConfidenceOverride: number | undefined
): SignalEvaluation {
  if (!candles || candles.length < MIN_PRO_CANDLES) {
    return {
      symbol, action: 'hold', tradeType: 'HOLD', tradeSide: 'NONE', confidence: 0,
      price: currentPrice, priceChange24h, reasoning: `אין מספיק היסטוריה (נדרשים ${MIN_PRO_CANDLES} נרות)`,
      status: 'NO_SIGNAL [NO_DATA]', willExecute: false, factors: [], confidenceGap: 0
    };
  }

  const signal = computeProSignal(candles, priceChange24h);
  const minConfidence = proMinConfidence(riskLevel, minConfidenceOverride);
  const willExecute = signal.action === 'BUY' && signal.confidence >= minConfidence;

  const factors: DecisionFactor[] = signal.signals
    .slice()
    .sort((a, b) => (b.weight * b.confidence) - (a.weight * a.confidence))
    .slice(0, 4)
    .map((s) => ({
      label: s.name,
      value: s.reason,
      impact: s.signal === (signal.action === 'HOLD' ? 'HOLD' : signal.action) ? 'positive' : 'neutral',
      note: `משקל ${s.weight} · ביטחון ${s.confidence}`
    }));

  const reasoning = signal.action === 'HOLD'
    ? `ללא יתרון כיווני מובהק (buy ${signal.buyScore.toFixed(1)} / sell ${signal.sellScore.toFixed(1)} / hold ${signal.holdScore.toFixed(1)}) · ציון טכני ${proTechnicalScore(signal).toFixed(0)}/100`
    : signal.action === 'SELL'
      ? `אות SELL — Spot אינו פותח שורט, נדרשת פוזיציה פתוחה כדי לסגור`
      : willExecute
        ? `אות BUY בביטחון ${signal.confidence.toFixed(1)} >= סף ${minConfidence} — מבצע קנייה`
        : `אות BUY בביטחון ${signal.confidence.toFixed(1)} מתחת לסף ${minConfidence}`;

  const tradeSide: SignalEvaluation['tradeSide'] = signal.action === 'BUY' ? 'BUY' : signal.action === 'SELL' ? 'SELL' : 'NONE';

  // §6: compute optimal entry price from indicator support levels.
  // When limitEntries is on, the bot places a LIMIT at this price and waits.
  const optimalEntryPrice = calculateOptimalEntryPrice(signal, currentPrice);

  return {
    symbol,
    action: signal.action.toLowerCase() as 'buy' | 'sell' | 'hold',
    tradeType: willExecute ? 'SPOT' : 'HOLD',
    tradeSide,
    confidence: signal.confidence,
    price: currentPrice,
    priceChange24h,
    reasoning,
    status: willExecute ? 'SIGNAL SPOT BUY' : `NO_SIGNAL [${signal.action === 'HOLD' ? 'NO_DIRECTION' : signal.action === 'SELL' ? 'SPOT_SELL_UNSUPPORTED' : 'BELOW_THRESHOLD'}]`,
    willExecute,
    strategyDecision: willExecute, // §16: raw signal threshold check, before state gates
    factors,
    confidenceGap: Math.max(0, minConfidence - signal.confidence),
    riskLevel,
    stopLoss: undefined, // fixed % — resolved against the fill price at order time, not the signal price
    takeProfit1: undefined,
    indicators: signal.indicators,
    optimalEntryPrice
  };
}

// ── §4 — the entry gates, evaluated ONCE, on the evaluation itself ──────────
//
// alg.md §4: the SignalEvaluation is the single source of truth — the same
// object feeds the recommendations panel and the executor, "כך שאין פער בין
// מה שמוצג לבין מה שמבוצע". The state gates therefore run HERE, in §4's own
// order, over a batch walked in descending confidence so the slots and the
// cash go to the strongest signals first ("ההמלצות ממוינות לפי ביטחון יורד,
// כך שהסלוטים והמזומן מוקצים קודם לאותות החזקים ביותר").
//
// §4 itself has no per-symbol entry cooldown or drawdown circuit breaker — §9
// originally assigned both to the REAL bot only, and this file matched that.
// The circuit breaker is now applied anyway (in server/proSimEngine.ts, ahead
// of this gate pass): the four bots share one equity-protection floor, and
// simulating past it while the REAL bot would have stopped made Pro's results
// incomparable to the others precisely when the comparison mattered most. The
// entry cooldown remains genuinely absent — §4 gates re-entry on price/slots/
// confidence only, and that difference from the other three bots is by design,
// not an oversight.

export interface ProGateContext {
  positions: SimPosition[];
  pending: PendingOrder[];
  cash: number;
  /** Total portfolio equity = cash + positions value — displayed in the UI so
   *  the operator sees why a healthy-looking portfolio can still be cash-poor.
   *  The budget GATE itself allocates against `cash` (what's actually spendable):
   *  an allocation that equity would allow but cash couldn't cover would create
   *  an order the fill step then refuses — "ready to buy" with no purchase. */
  equity: number;
  initialAmount: number;
  maxPositions: number;
  riskLevel: ProRiskLevel;
  minConfidenceOverride?: number;
}

function gateResult(
  ev: SignalEvaluation,
  status: string,
  reasoning: string,
  willExecute: boolean,
  minConfidence: number,
  budgetUsd?: number
): SignalEvaluation {
  return {
    ...ev,
    tradeType: willExecute ? 'SPOT' : 'HOLD',
    status,
    reasoning,
    willExecute,
    confidenceGap: Math.max(0, minConfidence - ev.confidence),
    ...(budgetUsd !== undefined ? { budgetUsd } : {})
  };
}

export function applyProEntryGates(
  evaluations: SignalEvaluation[],
  ctx: ProGateContext
): SignalEvaluation[] {
  const heldSymbols = new Set(ctx.positions.map((p) => p.symbol));
  const queuedSymbols = new Set(ctx.pending.map((o) => o.symbol));
  const minConfidence = proMinConfidence(ctx.riskLevel, ctx.minConfidenceOverride);

  // §4 gate 5: open positions AND queued buys occupy slots. A slot an exit is
  // about to free stays occupied until that exit FILLS.
  let occupiedSlots = ctx.positions.length + ctx.pending.filter((o) => o.side === 'buy').length;
  // Budget is tracked against CASH (what's actually spendable), not equity —
  // an allocation that equity would allow but cash couldn't cover would create
  // an order the fill step then refuses, producing "ready to buy" with no
  // purchase. projectedCash decreases as we allocate within this batch.
  let projectedCash = ctx.cash;

  return evaluations
    .map((ev, i) => ({ ev, i }))
    .sort((a, b) => (b.ev.confidence - a.ev.confidence) || (a.i - b.i))
    .map(({ ev }) => {
      if (ev.action === 'sell') {
        // §4's sell logic: not held → no action (Spot never shorts). Held → a
        // close order for the WHOLE position goes out this tick, via the exit
        // loop in generateProOrders, which owns §5's fixed percentages and the
        // confidence-gated flip alike.
        if (queuedSymbols.has(ev.symbol)) {
          return gateResult(ev, 'NO_SIGNAL [ORDER_QUEUED]', 'פקודת מכירה כבר בתור ביצוע', false, minConfidence);
        }
        if (!heldSymbols.has(ev.symbol)) return ev;
        if (ev.confidence >= minConfidence) {
          return gateResult(ev, 'SIGNAL SPOT SELL', 'אות SELL מעל הסף — נשלחת פקודת מכירה לכל הפוזיציה', true, minConfidence);
        }
        return gateResult(
          ev,
          'NO_SIGNAL [BELOW_THRESHOLD]',
          `היפוך SELL מתחת לסף (${ev.confidence.toFixed(1)} < ${minConfidence}) — הפוזיציה נשארת פתוחה, SL/TP עדיין פעילים`,
          false,
          minConfidence
        );
      }
      if (ev.action !== 'buy') return ev;

      // §4's buy sequence, in the doc's own order (gate 1, "הבוט פעיל?", is
      // the runtime itself — a stopped engine produces no evaluations):
      if (queuedSymbols.has(ev.symbol)) {                                                                                       // 2
        return gateResult(ev, 'NO_SIGNAL [ORDER_QUEUED]', 'פקודה בתור ביצוע', false, minConfidence);
      }
      if (heldSymbols.has(ev.symbol)) {                                                                                         // 3
        return gateResult(ev, 'NO_SIGNAL [ALREADY_HELD]', 'כבר מוחזק בתיק', false, minConfidence);
      }
      if (ev.confidence < minConfidence) {                                                                                      // 4
        return gateResult(ev, 'NO_SIGNAL [BELOW_THRESHOLD]', `ביטחון נמוך מהסף (${ev.confidence.toFixed(1)} < ${minConfidence})`, false, minConfidence);
      }
      if (occupiedSlots >= ctx.maxPositions) {                                                                                  // 5
        return gateResult(ev, 'NO_SIGNAL [NO_SLOTS]', `אין סלוט פנוי (${occupiedSlots}/${ctx.maxPositions})`, false, minConfidence);
      }
      if (!ev.price || ev.price <= 0) {                                                                                         // 6
        return gateResult(ev, 'NO_SIGNAL [NO_PRICE]', 'אין מחיר תקף', false, minConfidence);
      }
      // Allocation is confidence-independent under the 10% position-target
      // model. Every new position targets 10% of current equity, regardless of
      // confidence score. Confidence is used for entry gating only.
      const perAssetCap = ctx.equity * (PER_ASSET_EXPOSURE_CAP_PERCENT / 100);
      const targetNotional = ctx.equity * POSITION_TARGET_PCT;
      const rawBudget = Math.min(targetNotional, projectedCash, perAssetCap);
      // Skip if target is below exchange minimum — no overshoot.
      if (rawBudget < MIN_SIM_ENTRY_USD) {
        return gateResult(ev, 'NO_SIGNAL [MIN_ORDER_EXCEEDS_POSITION_TARGET]', `יעד ${rawBudget.toFixed(2)}$ מתחת למינימום ${MIN_SIM_ENTRY_USD}$`, false, minConfidence);
      }
      occupiedSlots++;                                                                                                          // 8
      projectedCash -= rawBudget;
      return gateResult(ev, 'SIGNAL SPOT BUY', `אות BUY בביטחון ${ev.confidence.toFixed(1)} >= סף ${minConfidence} — מבצע קנייה`, true, minConfidence, rawBudget);
    });
}

export interface ProOrderGenContext {
  positions: SimPosition[];
  pending: PendingOrder[];
  evaluations: SignalEvaluation[];
  /** Per-symbol current signal, for the exit check (§4's "flip to SELL"). */
  signalsBySymbol: Record<string, ProSignalResult>;
  minConfidence: number;
  executionDelaySec: number;
  priceFor: (symbol: string) => number | undefined;
  /** §6 execution mode. When true, entries rest as LIMIT orders at the signal
   *  price — the bot waits until the market reaches it (or a better price) and
   *  only then buys (Fills are Maker, and slippage is zero). When false
   *  (default, per alg.md §6) entries fire at executeAt as adverse-slippage
   *  MARKET fills. */
  limitEntries?: boolean;
}

export function generateProOrders(ctx: ProOrderGenContext): PendingOrder[] {
  const { positions, pending, evaluations, signalsBySymbol, minConfidence, executionDelaySec, priceFor, limitEntries } = ctx;
  const delayMs = Math.max(0, executionDelaySec) * 1000;
  const newOrders: PendingOrder[] = [];

  // ── §5 fixed exit + §4 flip-to-SELL exit, per open position ───────────────
  for (const pos of positions) {
    const claimed = (o: PendingOrder) => (o.positionId ? o.positionId === pos.id : o.symbol === pos.symbol);
    if (pending.some(claimed) || newOrders.some(claimed)) continue;

    const livePrice = priceFor(pos.symbol) ?? pos.currentPrice;
    const signal = signalsBySymbol[pos.symbol];
    // No fresh signal this tick (e.g. candle history briefly unavailable) —
    // §5's fixed-percentage exit still has to run, so treat it as HOLD rather
    // than skipping the position entirely.
    const effectiveSignal: ProSignalResult = signal ?? {
      action: 'HOLD', buyScore: 0, sellScore: 0, holdScore: 100, totalWeight: 0, confidence: 0, signals: [],
      indicators: { rsi: 50, ma20: livePrice, volumeTrend: 'stable', bollingerBands: { upper: livePrice, middle: livePrice, lower: livePrice, position: 'between' }, volumeProfile: { poc: livePrice, valueAreaHigh: livePrice, valueAreaLow: livePrice, position: 'in_value_area' } }
    };

    const exitCheck = evaluateProExit({ entryPrice: pos.entryPrice }, livePrice, effectiveSignal, minConfidence);
    if (!exitCheck.shouldExit) continue;

    newOrders.push({
      id: uid(`${pos.symbol}-exit`), symbol: pos.symbol, positionId: pos.id, type: 'SPOT',
      side: 'close_long', signalPrice: livePrice, quantity: pos.quantity, reason: exitCheck.reason,
      confidence: pos.confidence ?? 0, executeAt: Date.now() + delayMs, createdAt: Date.now()
    } as PendingOrder);
  }

  // §4's entry gates have ALREADY run — on the evaluations themselves
  // (applyProEntryGates), which is §4's single source of truth. This loop only
  // emits what an evaluation approved. The held/pending re-check is
  // defense-in-depth for runtimes where the evaluation pass and this pass can
  // straddle a state change (the browser fallback recomputes on a 5s
  // heartbeat) — not a second gate.
  for (const ev of evaluations) {
    if (!ev.willExecute || ev.action !== 'buy' || !ev.price) continue;
    const budget = ev.budgetUsd ?? 0; // §4 gate 7, allocated in the gate pass
    if (budget < MIN_SIM_ENTRY_USD) continue;
    if (positions.some((p) => p.symbol === ev.symbol)) continue;
    if (newOrders.some((o) => o.symbol === ev.symbol) || pending.some((o) => o.symbol === ev.symbol)) continue;

    // §6: when limitEntries is on, use the optimal entry price (computed from
    // support levels) instead of the current market price. This is typically
    // LOWER — the bot waits for a dip to enter at a better price.
    const entryPrice = limitEntries && ev.optimalEntryPrice ? ev.optimalEntryPrice : ev.price;

    newOrders.push({
      id: uid(`${ev.symbol}-buy`), symbol: ev.symbol, type: 'SPOT', side: 'buy',
      signalPrice: entryPrice, quantity: budget / entryPrice, budgetUsd: budget, leverage: 1,
      // §6 default: delayed MARKET fills — at executeAt the order fills at the
      // market price of that moment, adverse slippage and a Taker fee included.
      // With `limitEntries` on, the order rests as a LIMIT at the optimal entry
      // price (from support levels): the bot waits until the market reaches that
      // price (or better, i.e. lower for a buy) and only then buys — "יחשב מתי
      // להיכנס, יגיע לשער וירכוש". Fills are Maker (lower fee) and carry no slippage.
      fill: limitEntries ? 'limit' : 'market',
      reason: ev.reasoning, confidence: ev.confidence,
      executeAt: Date.now() + delayMs, createdAt: Date.now()
    } as PendingOrder);
  }

  return newOrders;
}

// Kept for symmetry with the other engines' UI column, which reads it off
// evaluations that carry a `regime` — Pro's alg.md has no regime classifier,
// so this is always empty.
export function activeMarketRegimesFrom(): Record<string, never> {
  return {};
}
