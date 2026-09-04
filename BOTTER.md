# BOTTER — the four simulation bots, traced from code

This document was produced by following the call flow in the repository, not by
reading `ALG_intraday.md` / `ALG_legacy.md` / `ALG_pro.md`. Where those documents
and the code disagree, the code is what is written here, and the disagreement is
noted.

Every claim below cites the file and function it came from. Anything that could
not be verified by reading the code is marked **[unverified]** rather than
filled in.

Generated against the working tree after the risk-hardening pass (Tasks 1–3).

---

## 0. What is shared

The four bots differ **only** in their decision layer. Everything else is one
implementation, which is the entire point of running four of them: a difference
in results is attributable to the decision, not to looser risk rules.

### 0.1 The tick loop

`server/simEngineFactory.ts` → `createGenericSimEngine(strategy)`

Each bot supplies a `SimEngineStrategy` with `buildEvaluations()` and
`generateOrders()`. The factory owns everything else.

| Constant | Value | Line |
|---|---|---|
| `TICK_MS` | 4000 | `simEngineFactory.ts:53` |
| `CRYPTO_REFRESH_MS` | 60_000 | `:54` |
| `CANDLE_REFRESH_MS` | 5 × 60_000 | `:55` |

Order of operations inside one tick (`tick()`, `simEngineFactory.ts:322`):

1. Seed `initialAmount`/`cash` **only if the run is empty** (no positions, no
   trades, cash 0/NaN). Changing the configured capital mid-run does not
   retro-fit the P&L denominator; the config endpoint resets the run instead.
2. `refreshMarketData()` — prices every 60s, candles every 5min (non-blocking).
3. Mark-to-market every open position from `priceFor()`.
4. Compute equity, drawdowns, leveraged exposure, closed-trade history.
5. `strategy.buildEvaluations(input)` → one `SignalEvaluation` per symbol.
6. `strategy.generateOrders(input, evaluations)` → new `PendingOrder[]`.
7. `selectFillableOrders(pending, now, priceFor)`.
8. `fillDueOrders(...)` → applies fills, fees, slippage, cooldowns.
9. Telegram notification on exits only (never on entries).

### 0.2 Data sources — the actual endpoints

| What | Where from | Code |
|---|---|---|
| Prices / 24h change | Bybit `api.bybit.com/v5/market/tickers?category=spot`, fallback Binance `api.binance.com/api/v3/ticker/24hr`, fallback CoinGecko `/coins/markets` | `cryptoPriceAggregator.ts:54-56, 98, 122, 169` |
| Candles 1H / 15M / 5M | Bybit `/v5/market/kline`, fallback Binance `/api/v3/klines` | `marketDataService.ts:22-23` |
| Perpetual funding | Binance futures `fapi.binance.com/fapi/v1` | `marketDataService.ts:207` |
| Fear & Greed | `api.alternative.me/fng/?limit=1` (server), same host in `src/services/fearGreedApi.ts` (browser) | `tradingWorker.ts:830` |
| Persistence | Firestore in production, local JSON file in dev | `server/kvStore.ts` |

Candle hygiene, verified in `marketDataService.ts:136-143`: `dropFormingCandle()`
removes the still-open candle before any indicator sees it. A candle opened at
T is treated as closed only when `now >= T + tfMs`. **There is no look-ahead
bias in the candle feed for any of the four bots.**

`TIMEFRAME_SPECS` (`marketDataService.ts:46-50`) defines exactly three
timeframes — `1h` (min 200 candles), `15m` (min 300), `5m` (min 500). **There is
no 4H fetch**; the fourth bot aggregates 4H from H1 in memory.

### 0.3 Shared execution mechanics

`packages/engine/src/services/simExecution.ts`

- **Entry orders are real resting limits.** `selectFillableOrders()` (`:566`)
  only makes an entry due once live price has crossed the order's own
  `signalPrice`. If it never crosses within `LIMIT_ORDER_TTL_MS` (2h in the sim,
  vs 4h for the live bot — deliberate, documented at `:535`) the order expires
  unfilled.
- **Adverse-selection guard**: an entry limit that would fill on the wrong side
  of its own stop is cancelled, not filled (`:592`).
- **Entry fills are Maker, exits are Taker** (`calculateTradingFee`,
  `tradeEngine.ts:1657`). Bybit rates: spot 0.1%/0.1%, futures 0.02%/0.055%.
- **Slippage** is drawn from `[base, 3×base]`, base = `SimBotConfig.slippagePercent`
  (default 0.05 → the historical 0.05–0.15% band). Entry limits fill at their
  limit or better with zero slippage.
- **One position per symbol per bot** — the entry loop skips a symbol already in
  `positions`, `pending`, or the current batch.
- **Exits are per position, not per symbol** — `PendingOrder.positionId`.
- **30-minute re-entry cooldown after a LOSING exit** (`ENTRY_COOLDOWN_MS`).
- **Losing-streak cooldown** per symbol (`adaptiveRisk.ts:streakCooldownFromHistory`).
- **Correlation gate** (`correlation.ts`) — Pearson on log returns, 72-bar
  lookback, |ρ| ≥ 0.7 counted only when directions agree, max 3 correlated.
  Since the risk-hardening pass the lookback shrinks toward 36 as the
  candidate's ATR percentile rises — **only the intraday bot supplies a
  percentile**, so Legacy and Pro still run the fixed 72.
- **Time stops** (`adaptiveRisk.ts:evaluateTimeStop`) — checkpoint at 48h spot /
  24h futures, cut when progress < 0.3R, one reprieve to 36h for a working
  futures position, hard ceiling 72h spot / 48h futures.

### 0.4 Sizing

`resolveEntryBudget()` (`simExecution.ts:222`): **Kelly decides, the operator
caps.**

```
ceiling = computeEntryBudget(cash, tradeType, positionPercent) × riskLevelMultiplier
sized   = riskPlan.betSizeUsd × performanceMultiplier   (or ceiling if no plan)
budget  = min(sized, ceiling)
```

- `computeEntryBudget`: SPOT = `positionPercent`% of free cash capped at $1000;
  FUTURES = one third of that, capped at $500.
- `riskLevelMultiplier`: low 0.6 / medium 1.0 / high 1.5 — applied to the
  ceiling, not to Kelly's number.
- The performance multiplier only ever de-risks (clamped to [0,1]).

### 0.5 Shared config, and what it is

`SimBotConfig`, all four bots, from `tradingWorker.ts` `DEFAULT_*_SIM_CONFIG`:

| Field | Default | Effect |
|---|---|---|
| `initialAmount` | 10000 | starting capital; changing it resets the run |
| `maxPositions` | `BOT_MAX_OPEN_POSITIONS` (5) | same cap as the live bot |
| `maxFuturesPositions` | 2 (0 for Path) | |
| `feePercent` | 0.1 | scales the whole Bybit fee table by `feePercent / 0.1` |
| `slippagePercent` | 0.05 | floor of the slippage band |
| `executionDelaySec` | 3 | delay before an order becomes eligible |
| `minConfidenceOverride` | 52 / 58 / 58 / 33 | confidence floor actually enforced |
| `positionPercent` | `BOT_POSITION_PERCENT` (10) | ceiling as % of free cash |
| `riskLevel` | `BOT_RISK_LEVEL` (medium) | sizing multiplier |

There is no `stopLoss` / `takeProfit` field — both were removed in the audit
pass; stops come from ATR and targets are derived from the stop.

---

## 1. Bot 1 — Multi-Timeframe Intraday

**Entry point:** `server/simEngine.ts` → `IntradayAdapter` → `intradayEngine.ts:evaluateIntradayDecision`
**Order layer:** `simExecution.ts:generateNewOrders`
**Confidence floor:** 52

Gate order, first failure stops the pipeline (`intradayEngine.ts`):

```
NO_DATA → CIRCUIT_BREAKER → EXPOSURE → 1H REGIME → 15M SETUP → 5M ENTRY
   → TRADE-TYPE ROUTING → LIQUIDITY → SPREAD → EXTREME-vol strict bar → COST → RISK
```

### Layer 0 — regime, on 1H (`intradayRegime.ts:59`)

- `adx = calculateADX(h1, 14)`
- `BULL_TREND` — ADX > 25 **and** EMA20 > EMA50 **and** Supertrend BULL
- `BEAR_TREND` — the mirror
- `RANGING` — ADX < 20
- `SOFT_TREND` — ADX ≥ 22 with Supertrend agreeing and EMA still converging
- `TRANSITIONAL` — everything else
- `futuresAllowed` requires a hard BULL/BEAR trend **and** ATR bucket not
  HIGH/EXTREME (`:115`)
- `atrPercentile` — a true 0-100 rank. **This is the only engine of the four
  that computes one.**

### Layer 1 — setup, on 15M (`intradaySetup.ts:107`)

Three setup types, `setupScoreMin = 46`:

| Setup | Line |
|---|---|
| `TREND_PULLBACK` | `:182` |
| `BREAKOUT_RETEST` | `:247` |
| `MEAN_REVERSION` | `:295` |

### Layer 2 — entry trigger, on 5M (`intradayEntry.ts:97`)

`entryScore = triggerQuality×0.3 + momentum×0.2 + volume×0.2 + vwap×0.15 + candle×0.15 − chasePenalty`

Confirmed when **all** hold (`:310`):
`gatesPassed && entryScore >= 50 && !volumeTooLow && !meanRevVolumeTooLow && chasePenalty === 0`

Triggers: `PULLBACK_HOLD`, `BREAKOUT_RETEST`, `REVERSAL_RECOVERY`.
`volumeTooLow` = relative volume < 0.7 or volume drying (0.5 for mean reversion).
`maxChaseAtr` = 1.2.

> **Changed in the risk-hardening pass.** This function used to compute
> `highConfidence = confidence >= 72` and use it five times: suppress the chase
> blocker, zero the chase penalty out of the score, suppress both volume
> blockers, and short-circuit `confirmed` itself. A 72+ signal therefore produced
> a *confirmed* entry with no trigger, no gates, no volume, at any chase
> distance. All five are removed; the parameter is now `_confidence` and unread.

### Layer 3 — cost / edge (`intradayRisk.ts:41`)

```
entryFee = maker (limit) ; exitFee = taker      // exits always cross the book
volatilityTerm = atrPercentile/100 × 0.03
liquidityTerm  = clamp(1/relativeVolume − 1, 0, 0.05) × 0.4     // added in Task 3
entrySlippage  = 0.005 (resting limit)  |  spread/2 + base + liquidity (market)
exitSlippage   = base + spread/2 + volatilityTerm + liquidityTerm
edgeRatio      = expectedMove / totalCost
netRewardRisk  = (expectedMove − totalCost) / risk
```

`maxSpreadPercent` = 0.12 blocks outright.

> **Changed.** `intradayEngine.ts` used to let `confidence >= 72` bypass a failed
> cost gate and log `COST BYPASS`. A score does not make a negative-expectancy
> trade positive; the bypass is removed.

### Layer 3b — risk plan (`intradayRisk.ts:204`)

- Stop is a **fixed 1.8%** of entry, target 3.0% (`:220`). *(Note: this is the
  one place a flat percentage stop survives; `calculateRiskParameters` for
  Legacy/Pro uses ATR.)*
- `riskUsd = equity × riskPercent/100 × sizingMultiplier`, `riskPerTradePercent`
  = 0.5, clamped to `[0.05, maxRiskPerTradePercent 0.75]`
- SPOT notional cap 15% of equity; FUTURES margin cap 4%, leverage ≤ 5
- Per-asset cap 8% of equity (futures branch)
- Total leveraged exposure cap 20% of equity
- `minOrderUsd` = 5

> **Changed.** All four of those checks plus the stop-direction invariant were
> waived at `confidence >= 72`. They are now unconditional, and the exchange
> minimum floors the order up and re-checks the caps instead of being skipped.

### Exit (`intradayExit.ts`)

Weekly-drawdown flatten → stop loss (close-confirmed for MEAN_REVERSION) →
TP2 / TP1-partial → trailing (`trailingAtrMult` 1.2, activation by setup type)
→ reversal → max-hold → time stop.

---

## 2. Bot 2 — Legacy (single-timeframe H1)

**Entry point:** `server/legacySimEngine.ts` → `LegacyAdapter` → `tradeEngine.ts`
**Order layer:** `legacySimExecution.ts:generateLegacyOrders`
**Confidence floor:** 58
**Minimum candles:** 60 H1

Pipeline stages (`legacyAdapter.ts`): `DetectRegime → EvaluateSignals →
RouteTradeType → EntryTiming → RiskParameters → CorrelationGate → CostEdgeGate`.

### Layer 0 — regime (`tradeEngine.ts:244`)

`detectMarketRegime(candles, price)` → ADX(14), ATR(14) + ATR%, Supertrend(10,3).
ADX > 25 TRENDING, ADX < 20 RANGING, 20–25 TRANSITIONAL.

### Layer 1 — the weighted score (`tradeEngine.ts:evaluateSignals`)

Seven indicators, weights summing to 100 — **read directly off the code**:

| # | Indicator | Weight |
|---|---|---|
| 1 | MACD 12/26/9 | 20 |
| 2 | EMA 20/50 | 18 |
| 3 | RSI 14 | 12 |
| 4 | Bollinger 20/2 | 12 |
| 5 | Volume Surge | 18 |
| 6 | Supertrend 10/3 | 12 |
| 7 | Stochastic 14/3 | 8 |

Then two multiplicative penalties:

- Volume Surge NEUTRAL → `confidence × 0.6`
- Regime RANGING → `confidence × 0.7`

**Fear & Greed does not change the score.** It appends a note to `penalties[]`
below 25 or above 75 and nothing else. The returned `confidence` is
post-penalty; `rawConfidence` is the pre-penalty score.

### Layer 2 — routing (`tradeEngine.ts:routeTradeType`)

- Same-asset hard gate: an existing Spot **or** Futures position on the symbol
  returns `SAME_ASSET_EXPOSURE_BLOCK`.
- **FUTURES** requires: TRENDING with ADX > 25, volatility LOW/NORMAL (or the
  HIGH-vol carve-out when the elevated threshold is met), and
  `routingScore >= dynamicConfidenceThreshold(72, atrPercent)` — flat 72 up to
  ATR 4%, ramping linearly to 87 at ATR 8%.
- **SPOT** threshold is a fixed **58**, raised in a SOFT_TREND TRANSITIONAL case.

> **Not changed, and worth knowing:** `tradeEngine.ts:965` reads
> `if (routingScore < requiredSpotScore && routingScore < 72)` — a score of 72+
> passes even when the required score is higher. That is the same circular
> pattern as the fixed bypasses, but it waives the *signal threshold*, not one
> of the five capital-preservation categories the hardening pass covered.
> Flagged, deliberately left alone, needs a product decision.

### Layer 2.5 — entry timing (`tradeEngine.ts:calculateOptimalEntry`)

Volume gate first (relative volume vs `MIN_ENTRY_RELATIVE_VOLUME = 0.6`), then RSI
extreme, Bollinger extreme, and 1.5×ATR extension from EMA20. Returns a resting
limit at `price ∓ atr × dynamicPullback` (0.5 / 0.35 / 0.2 by volatility).

> **Changed.** The volume gate carried `&& confidence < 72`, contradicting the
> comment directly above it. Removed — Pro's own copy of this gate never had it.

### Layer 3 — risk (`tradeEngine.ts:calculateRiskParameters`)

- Stop is **ATR-based**: `atr × SL_ATR_MULTIPLIER / entry` with
  `SL_ATR_MULTIPLIER = 1.2`, clamped to `[MIN_STOP_PERCENT 1.5%,
  MAX_STOP_PERCENT 6%]`. Target derived at a fixed 1.67 reward:risk
  (`SL_TP_REWARD_RISK = 3.0/1.8`).
- Leverage: LOW 5x, NORMAL 3x, HIGH blocked below score 72; +1x at score ≥ 80,
  max 5x. *(These two are strength-gates — a stronger signal does MORE — and
  were deliberately left in place.)*
- Kelly sizes directly: `betFraction = clamp(kelly × KELLY_MULTIPLIER, 0, 0.10)`
  with `KELLY_MULTIPLIER = 0.25`, defaulting to 6% below `KELLY_MIN_SAMPLE = 30`
  closed trades, then × the adaptive multiplier. Payoff ratio comes from
  R-multiples, not dollars.
- SPOT notional cap 15% of portfolio; FUTURES leveraged exposure cap 20%.

> **Changed.** The 20% cap and the $5 exchange minimum both had a `signalScore
> < 72` escape. The cap is now unconditional; the minimum floors the bet to $5
> **before** the caps run and rejects if the floored order cannot fit under them.
> A zero-size bet still returns null, so flooring cannot manufacture the
> quantity-0 trades that used to pollute the Kelly denominator.

### Exit (`tradeEngine.ts:evaluateExit`)

Weekly drawdown ≥ 15% → stop loss → TP (spot full, futures TP1 50% + TP2) →
trailing (spot 1.3 ATR below peak after TP1; futures 1.0 ATR) → reversal (ADX-
scaled threshold 55/65/70, only once past TP or SL) → shared time stop.

---

## 3. Bot 3 — Pro

**Entry point:** `server/proSimEngine.ts` → `ProAdapter` → `proAlgEngine.ts`
**Order layer:** `proSimExecution.ts:generateProOrders`
**Confidence floor:** 58

Stages: `DetectRegime → AdvancedAnalysis → RouteTradeType → EntryTiming →
RiskParameters → FundingGate → CorrelationGate → CostEdgeGate`.

### The signal source — correcting the documentation

`ALG_pro.md` describes Pro's signal as the website's Advanced Analysis engine
with weights *Advanced Analysis 50 / RSI 15 / MACD 18 / Stochastic 10 /
Williams %R 7*.

**That is not what the code does.** `proAdapter.ts:124-158` calls
`evaluateProSignals` (`proAlgEngine.ts`), whose weights are **identical to
Legacy's**: MACD 20, EMA20/50 18, RSI 12, Bollinger 12, Volume Surge 18,
Supertrend 12, Stochastic 8. The adapter's own comment records the revert from
Advanced Analysis and states plainly that the documented table "doesn't
correspond to any code that exists."

So Pro and Legacy share a signal core. What actually separates them:

| | Legacy | Pro |
|---|---|---|
| Signal fn | `evaluateSignals` | `evaluateProSignals` (same weights, own implementation) |
| RSI bands | 30/70-ish, volatility-adjusted at entry | 25/35/65/75 tiered |
| Funding gate | none | yes |
| Kelly | sizes `betFraction`, then × adaptive | sizes directly, adaptive folds in `computeDrawdownFactor` |
| Futures time stop | shared rule | shared rule + `PRO_FUTURES_TIME_STOP_*` aliases |

### Funding gate (`fundingRate.ts:evaluateFundingGate`)

The one genuinely orthogonal input in the whole system.

- Abstains on missing data or a reading older than 8h (`FUNDING_MAX_AGE_MS`).
- `annualPct = rate × 3 × 365`. `crowdedCost` = that, signed by direction.
- ≥ 50%/yr (`FUNDING_EXTREME_ANNUAL_PCT`) → block.
- ≥ 25%/yr (`FUNDING_CROWDED_ANNUAL_PCT`) → linear size multiplier from 1.0 down
  to 0.5 (`FUNDING_MIN_SIZE_MULTIPLIER`).
- Below that → no effect.

It never *initiates* a trade and never blocks on missing data — a feed outage
costs Pro an opinion, not its ability to trade.

### Risk (`proAlgEngine.ts:calculateProRisk`)

Same ATR-clamped stop and the same 1.67 reward:risk as Legacy. Leverage base 5x
LOW / 3x NORMAL, +1 at confidence ≥ 80.

> **Changed.** The 20% leveraged exposure cap was wrapped in
> `tradeType === 'FUTURES' && confidence < 72`, and the $5 minimum had the same
> escape. Both mirrored the Legacy fixes: the cap is unconditional, the minimum
> floors before the cap runs.

---

## 4. Bot 4 — Empirical Path (4H)

**Entry point:** `server/pathSimEngine.ts` → `PathAdapter` → `pathEngine.ts`
**Order layer:** `pathSimExecution.ts:generatePathOrders`
**Confidence floor:** 33 — because the reported confidence *is* a probability

This bot is on a separate validation track and was **not** touched by the
risk-hardening pass.

### Method

It does not score charts. It carries a lookup table of measured intra-bar
outcomes and trades only the 15-minute slot that table nominates for the state
the current 4H bar opened in.

1. **4H series** is aggregated from H1 in memory (`aggregateToH4`) — four closed
   H1 candles *are* the closed 4H bar. A partial group is dropped.
2. **State label** (`labelBarState`) from bars that closed *before* the current
   one: regime (`TRENDING_UP` / `TRENDING_DOWN` / `RANGING`) × Fear & Greed
   bucket (5 levels).
3. **Table lookup** (`selectBucket`) → best `expectedR` bucket for that state.
4. **Armed window**: hold unless the current 15-minute slot equals the bucket's
   slot.
5. **Live trigger** inside the window: `confirmEntry5M` must still confirm.
6. **Size**: half-Kelly on the bucket's own `pLow`, capped at 5% of equity, then
   capped again by `positionPercent`.
7. **Hold budget**: one 4H bar; time stop at half a bar below 0.3R.

`1R` = `ATR(4H,14) × SL_ATR_MULTIPLIER`, so outcomes pool across symbols in the
same unit.

### Known limitations — stated, not hidden

These are properties of the current implementation, verified in the code:

1. **The Wilson lower bound does not solve multiple comparisons.** It protects
   against a *single* thin bucket looking good by chance. It does not protect
   against picking the best of 480 buckets × 5 TP targets = 2,400 hypotheses.
   Under a true null of no edge anywhere, roughly 5% of buckets (~24) clear a
   95% bound on noise alone — the classic look-elsewhere effect. **This is
   precisely why an out-of-sample script is the blocking item, not a formality:**
   only a period not used to build the table distinguishes a real edge from a
   filter survivor. The live table built by `pathSimEngine.rebuildTable()` is
   **in-sample** and labelled as such at the top of that file.

2. **Look-ahead risk lives in the caller, not in `labelBarState`.** That function
   takes `fearGreedIndex: number` and cannot know where it came from. The live
   rebuild passes *today's* F&G value for every historical bar
   (`pathSimEngine.ts`, noted in-line). Any future historical pipeline must read
   the value that was actually published on that bar's date; feeding the current
   reading backwards is textbook leakage, and the code would look completely
   clean while doing it.

3. **`DEFAULT_COST_R = 0.06` is an assumption, not a measurement.** The comment
   explains why a cost term is needed, not how 0.06 was derived. Because BTC and
   a thin altcoin are pooled under the same R unit, it further assumes cost-as-a-
   share-of-R is roughly constant across assets. That is testable — the same way
   the Task 3 liquidity term is testable — and untested.

4. **The forward window truncates at the edge of history.** `measureBarPaths`
   slices `series.slice(slot+1, slot+1+horizonSlots)` and accepts a short
   window rather than rejecting it, so the "same forward budget for every slot"
   guarantee breaks silently at the end of the available data.

5. **Expectancy charges a full −1R to every non-winner.** An outcome that ended
   flat, touching neither target nor stop, counts as a full loss. The bias is
   conservative — it understates the edge rather than inflating it — but it is
   there.

---

## 5. Correction log — where the code contradicted the docs

| Claim | Source | What the code does |
|---|---|---|
| Pro's signal is Advanced Analysis, weights 50/15/18/10/7 | `ALG_pro.md` | `evaluateProSignals`, weights identical to Legacy (20/18/12/12/18/12/8) |
| High confidence "prevents strong signals being lost to edge-cases" | comments in 5 files | It waived portfolio caps, exchange minimums, market-participation checks and a stop-direction invariant. Removed. |
| `HIGH_CONFIDENCE_BYPASS` / fallback risk plans | `legacySimExecution.ts`, `proSimExecution.ts` | Exported, documented, re-exported — and never called by anything. Removed. |
| Every engine computes an ATR percentile | assumed by the Task 2 spec | Only the intraday engine does. Legacy/Pro expose `atrPercent` (share of price), a different scale, so they pass nothing. |

---

## 6. Measured effect of the risk-hardening pass

`scripts/abBacktest.ts`, snapshot 2025-01-01 → 2025-07-01, 6 symbols, 26,070
bars, one fixed SL config. Baseline = the same tree with the changes stashed.

**Legacy**

| metric | before | after | delta |
|---|---|---|---|
| totalTrades | 48 | 48 | 0 |
| winRate | 43.8% | 43.8% | 0.0 |
| profitFactor | 1.017 | 1.019 | +0.002 |
| maxDrawdown | 0.59% | 0.56% | −0.03 |
| R mean | −0.039 | −0.000 | +0.038 |
| R stdev | 0.589 | 0.514 | −0.074 |

**Pro** — every metric identical (30 trades, PF 0.787, maxDD 0.52%). In this
window no Pro trade ever hit the exposure cap or the $5 floor at confidence ≥ 72,
so the change is a no-op *on this sample*. That is not evidence it is a no-op in
general: the caps it restores are tail protections, and this window's worst
drawdown is 0.52%.

**Not measured.** `abBacktest.ts` only supports `--engine legacy|pro`. The
intraday changes (Task 1B, the entry-trigger cluster, the cost gate, Task 3's
liquidity term) and the Path bot have **no A/B number here**. Trade count did not
collapse and drawdown did not worsen where it could be measured; for intraday
that remains **[unverified]** until the harness grows an intraday engine.
