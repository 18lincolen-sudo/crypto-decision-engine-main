import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SIM_CACHE_KEYS,
  toAggregated,
  combineRisk,
  groupAction,
  type AggregatableContext,
  type AggregatedBot
} from '../lib/botAggregation';
import { PATH_SIM_BOT_LAST_KNOWN_RUNNING_KEY } from '../contexts/PathSimulationBotContext';
import { evaluatePathDecision, barOpenFor, slotIndexAt } from '@cde/engine/analysis';
import type { PathBucket, PathRegime, FearGreedBucket } from '@cde/engine/analysis';
import type { Candle } from '@cde/engine';

// The Path bot shipped as a fourth peer in the UI while eight aggregations
// still read `intraday + legacy + pro`. Nothing failed — a risk meter that
// silently omits an engine looks exactly like one that has nothing to report.
// These tests make the omission loud.

function ctx(over: Partial<AggregatableContext> = {}): AggregatableContext {
  return {
    equity: 0,
    positionsValue: 0,
    totalLeveragedExposureUsd: 0,
    positions: [],
    config: {},
    dailyDrawdownPercent: 0,
    weeklyDrawdownPercent: 0,
    start: async () => {},
    pause: async () => {},
    resetAll: async () => {},
    isRunning: false,
    controlError: null,
    ...over
  };
}

function positions(count: number, type = 'SPOT') {
  return Array.from({ length: count }, () => ({ type }));
}

/** The four engines, in the page's order, with per-engine overrides. */
function fourBots(over: {
  intraday?: Partial<AggregatableContext>;
  legacy?: Partial<AggregatableContext>;
  pro?: Partial<AggregatableContext>;
  path?: Partial<AggregatableContext>;
  pathAvailable?: boolean;
} = {}): AggregatedBot[] {
  return [
    toAggregated('חדש', ctx(over.intraday)),
    toAggregated('מקורי', ctx(over.legacy)),
    toAggregated('פרו', ctx(over.pro)),
    toAggregated('נתיב 4H', ctx(over.path), over.pathAvailable ?? true)
  ];
}

describe('Test 1 — risk meter sees Path on its own', () => {
  it('reports leveraged exposure when ONLY Path holds it', () => {
    const risk = combineRisk(fourBots({ path: { totalLeveragedExposureUsd: 1_500, equity: 10_000 } }));
    // The regression: this was 0, because Path was not in the sum.
    expect(risk.totalLeveragedExposureUsd).toBe(1_500);
  });

  it('reports invested capital and equity when ONLY Path has them', () => {
    const risk = combineRisk(fourBots({ path: { equity: 12_000, positionsValue: 4_000 } }));
    expect(risk.portfolioValue).toBe(12_000);
    expect(risk.totalInvestedUsd).toBe(4_000);
  });
});

describe('Test 2 — combined positions count all four engines', () => {
  it('sums 1 + 2 + 3 + 4 to 10, not 6', () => {
    const risk = combineRisk(fourBots({
      intraday: { positions: positions(1) },
      legacy: { positions: positions(2) },
      pro: { positions: positions(3) },
      path: { positions: positions(4) }
    }));
    expect(risk.openPositionsCount).toBe(10);
  });

  it('counts a paused engine’s positions — exposure is not conditional on running', () => {
    const risk = combineRisk(fourBots({
      intraday: { positions: positions(2), isRunning: false },
      path: { positions: positions(3), isRunning: false }
    }));
    expect(risk.openPositionsCount).toBe(5);
  });

  it('counts futures separately across all four', () => {
    const risk = combineRisk(fourBots({
      legacy: { positions: [...positions(1, 'FUTURES'), ...positions(2, 'SPOT')] },
      path: { positions: positions(2, 'FUTURES') }
    }));
    expect(risk.openFuturesCount).toBe(3);
    expect(risk.openPositionsCount).toBe(5);
  });

  it('sums the position and futures capacity of all four', () => {
    const risk = combineRisk(fourBots({
      intraday: { config: { maxPositions: 7, maxFuturesPositions: 2 } },
      legacy: { config: { maxPositions: 7, maxFuturesPositions: 2 } },
      pro: { config: { maxPositions: 7, maxFuturesPositions: 2 } },
      path: { config: { maxPositions: 5, maxFuturesPositions: 0 } }
    }));
    expect(risk.maxPositions).toBe(26);
    expect(risk.maxFutures).toBe(6);
  });
});

describe('combined drawdown', () => {
  it('takes the worst engine, including Path, and does not sum', () => {
    const risk = combineRisk(fourBots({
      intraday: { dailyDrawdownPercent: 2, weeklyDrawdownPercent: 3 },
      path: { dailyDrawdownPercent: 6, weeklyDrawdownPercent: 11 }
    }));
    expect(risk.dailyDrawdownPercent).toBe(6);
    expect(risk.weeklyDrawdownPercent).toBe(11);
  });
});

describe('§23 — no silent zero for a missing engine', () => {
  it('excludes an unavailable engine from every figure and names it', () => {
    // The unreachable-worker snapshot: placeholder equity, zero exposure.
    const risk = combineRisk(fourBots({
      intraday: { equity: 10_000, positionsValue: 5_000 },
      path: { equity: 10_000, positionsValue: 0, positions: [] },
      pathAvailable: false
    }));
    // Folding the placeholder in would report 5000/20000 = 25% exposure for a
    // portfolio that is actually 50% invested in everything we can see.
    expect(risk.portfolioValue).toBe(10_000);
    expect(risk.totalInvestedUsd).toBe(5_000);
    expect(risk.unavailableEngines).toEqual(['נתיב 4H']);
  });

  it('reports an empty exclusion list when all four are readable', () => {
    expect(combineRisk(fourBots()).unavailableEngines).toEqual([]);
  });
});

describe('Tests 3, 4, 5 — group actions reach every engine', () => {
  for (const action of ['start', 'pause', 'resetAll'] as const) {
    it(`${action} produces one call per engine, all four`, async () => {
      const called: string[] = [];
      const spy = (label: string) => async () => { called.push(label); };
      const bots: AggregatedBot[] = [
        toAggregated('חדש', ctx({ [action]: spy('חדש') })),
        toAggregated('מקורי', ctx({ [action]: spy('מקורי') })),
        toAggregated('פרו', ctx({ [action]: spy('פרו') })),
        toAggregated('נתיב 4H', ctx({ [action]: spy('נתיב 4H') }))
      ];
      const actions = groupAction(bots, action);
      expect(actions).toHaveLength(4);
      await Promise.allSettled(actions.map((run) => run()));
      expect(called).toEqual(['חדש', 'מקורי', 'פרו', 'נתיב 4H']);
    });
  }

  it('an engine that throws does not stop the other three', async () => {
    const called: string[] = [];
    const bots: AggregatedBot[] = [
      toAggregated('חדש', ctx({ resetAll: async () => { called.push('חדש'); } })),
      toAggregated('מקורי', ctx({ resetAll: async () => { throw new Error('worker down'); } })),
      toAggregated('פרו', ctx({ resetAll: async () => { called.push('פרו'); } })),
      toAggregated('נתיב 4H', ctx({ resetAll: async () => { called.push('נתיב 4H'); } }))
    ];
    const results = await Promise.allSettled(groupAction(bots, 'resetAll').map((run) => run()));
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(called).toEqual(['חדש', 'פרו', 'נתיב 4H']);
  });

  it('Reset All is not Clear Cache: the group action list touches no storage key', () => {
    // Reset All is `groupAction(bots, 'resetAll')` and nothing else. If it ever
    // grows a localStorage arm, this file is where the two operations get
    // conflated, and the page source is the only place to see it.
    const page = readFileSync(join(process.cwd(), 'src/pages/SimulationBot.tsx'), 'utf8');
    const resetButton = page.slice(page.indexOf("groupAction(allBots, 'resetAll')"));
    const untilCache = resetButton.slice(0, resetButton.indexOf('clearAllCache'));
    expect(untilCache).not.toContain('localStorage');
  });
});

describe('Test 6 — Clear Cache covers Path', () => {
  it('includes the Path running-state key, imported not retyped', () => {
    expect(SIM_CACHE_KEYS).toContain(PATH_SIM_BOT_LAST_KNOWN_RUNNING_KEY);
    expect(PATH_SIM_BOT_LAST_KNOWN_RUNNING_KEY).toBe('path-sim-bot-last-known-running');
  });

  it('holds no duplicate keys', () => {
    expect(new Set(SIM_CACHE_KEYS).size).toBe(SIM_CACHE_KEYS.length);
  });

  it('leaves connection and app settings alone', () => {
    expect(SIM_CACHE_KEYS).not.toContain('workerConfig');
    expect(SIM_CACHE_KEYS).not.toContain('theme');
  });
});

describe('Test 11 — the page does not claim three engines', () => {
  const page = readFileSync(join(process.cwd(), 'src/pages/SimulationBot.tsx'), 'utf8');

  it('says four everywhere it used to say three', () => {
    expect(page).not.toContain('שלושה אלגוריתמים');
    expect(page).not.toContain('שלושת המנועים');
    expect(page).toContain('ארבעה אלגוריתמים');
    expect(page).toContain('ארבעת המנועים');
  });

  it('names the Path engine in the header description', () => {
    expect(page).toContain('Empirical Path');
  });

  it('prints no hand-typed threshold: the numbers come from the engines', () => {
    expect(page).toContain('LEGACY_SPOT_BASE_THRESHOLD');
    expect(page).toContain('LEGACY_FUTURES_BASE_THRESHOLD');
    expect(page).toContain('PRO_SPOT_BASE_THRESHOLD');
    expect(page).toContain('PRO_FUTURES_BASE_THRESHOLD');
    // The literals that used to sit in the subtitles.
    expect(page).not.toContain('Spot 58');
    expect(page).not.toContain('Futures 70%');
    expect(page).not.toContain('Spot 60% / Futures 72%');
  });
});

// ── Path fixtures ────────────────────────────────────────────────────────────
//
// A table carrying one bucket for EVERY bar state, all with the same lower
// bound. Whichever state the engine labels the current bar with, a bucket
// matches — so a NO_BUCKET result can only mean the confidence floor rejected
// it, never that the fixture happened to miss.

const HOUR = 3_600_000;
const PATH_T0 = barOpenFor(1_700_000_000_000);
const PATH_NOW = PATH_T0 + 250 * HOUR;
/** 45% lower bound: comfortably above a 30 floor, comfortably below a 60 one. */
const BUCKET_P_LOW = 0.45;

function pathCandles(n: number, stepMs: number): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  let x = 13;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const open = price;
    price = price * (1 + ((x / 2147483648) - 0.5) * 0.01);
    out.push({
      timestamp: PATH_T0 + i * stepMs,
      open, high: Math.max(open, price) * 1.001, low: Math.min(open, price) * 0.999,
      close: price, volume: 1000 + (i % 5) * 50
    });
  }
  return out;
}

function everyStateTable(): PathBucket[] {
  const regimes: PathRegime[] = ['TRENDING_UP', 'TRENDING_DOWN', 'RANGING'];
  const fngs: FearGreedBucket[] = ['EXTREME_FEAR', 'FEAR', 'NEUTRAL', 'GREED', 'EXTREME_GREED'];
  const armedSlot = slotIndexAt(PATH_NOW, barOpenFor(PATH_NOW));
  return regimes.flatMap((regime) => fngs.map((fng): PathBucket => ({
    state: { regime, fng },
    slot: armedSlot,
    direction: 'LONG',
    n: 400, rawN: 400, tpR: 2, slR: 1,
    pHit: BUCKET_P_LOW + 0.05, pLow: BUCKET_P_LOW,
    costR: 0.06, expectedR: 0.29
  })));
}

function pathInput() {
  return {
    symbol: 'BTC',
    h1: pathCandles(244, HOUR),
    m15: pathCandles(320, 15 * 60_000),
    m5: pathCandles(520, 5 * 60_000),
    livePrice: 100,
    fearGreedIndex: 30,
    now: PATH_NOW,
    table: everyStateTable()
  };
}

// ── The same defect on the fourth bot ────────────────────────────────────────
//
// §13 named Pro's minConfidenceOverride as a configuration that never bites. It
// does bite (ProAdapter.normalize applies it). The bot where it genuinely did
// nothing was Path: the other three route their floor through a DecisionEngine
// adapter, and Path calls evaluatePathDecision directly, so the panel showed a
// control the engine never read.

describe('Path — the confidence floor is a real control', () => {
  it('blocks a bucket whose lower bound is under the floor', () => {
    const decision = evaluatePathDecision({ ...pathInput(), minConfidence: 60 });
    expect(decision.outcome).toBe('NO_SIGNAL');
    expect(decision.reasoning[0]).toContain('60');
  });

  it('omitting the floor reproduces the previous behaviour exactly', () => {
    const withoutFloor = evaluatePathDecision(pathInput());
    const atZero = evaluatePathDecision({ ...pathInput(), minConfidence: 0 });
    expect(withoutFloor.gate).toBe(atZero.gate);
    expect(withoutFloor.confidence).toBe(atZero.confidence);
  });

  it('a floor below the bucket does not block on confidence', () => {
    const decision = evaluatePathDecision({ ...pathInput(), minConfidence: 30 });
    // It may still stop at a later gate (window, trigger) — what it must NOT do
    // is stop at the confidence floor.
    expect(decision.reasoning[0]).not.toContain('רצפה שהוגדרה');
  });
});
