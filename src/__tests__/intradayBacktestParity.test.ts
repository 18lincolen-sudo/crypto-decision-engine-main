import { describe, it, expect } from 'vitest';
import { runPortfolioBacktest, type SlConfig } from '../../server/backtestRunner';
import type { Candle } from '@cde/engine';

// The A/B harness could not run Intraday at all, so every intraday change
// shipped unmeasured. The engine needs three timeframes and its FIRST gate is a
// hard NO_DATA below 200 H1 / 300 15M / 500 5M bars — which means an H1-only
// snapshot does not produce a thin Intraday result, it produces a zero-trade
// result that is indistinguishable from "this strategy never fires".
//
// That silent zero is the failure mode worth a test.

const SL: SlConfig = { minStop: 1.5, maxStop: 4.0, softTrendBase: 60 };
const T0 = Date.UTC(2025, 0, 1);

function series(n: number, stepMs: number): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  let x = 7;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const open = price;
    price = price * (1 + ((x / 2147483648) - 0.5) * 0.01);
    out.push({
      timestamp: T0 + i * stepMs,
      open, high: Math.max(open, price) * 1.001, low: Math.min(open, price) * 0.999,
      close: price, volume: 1000 + (i % 5) * 50
    });
  }
  return out;
}

describe('intraday backtest parity', () => {
  it('refuses an H1-only snapshot instead of reporting zero trades', async () => {
    const h1Only = [{ symbol: 'BTCUSDT', candles: series(300, 3_600_000) }];
    await expect(runPortfolioBacktest(h1Only, SL, 'intraday')).rejects.toThrow(/15M and 5M/);
  });

  it('names the command that produces the snapshot it needs', async () => {
    const h1Only = [{ symbol: 'BTCUSDT', candles: series(300, 3_600_000) }];
    await expect(runPortfolioBacktest(h1Only, SL, 'intraday')).rejects.toThrow(/snapshot-mtf/);
  });

  it('names every symbol that is missing series, not just the first', async () => {
    const histories = [
      { symbol: 'BTCUSDT', candles: series(300, 3_600_000), m15: series(400, 900_000), m5: series(600, 300_000) },
      { symbol: 'ETHUSDT', candles: series(300, 3_600_000) },
      { symbol: 'SOLUSDT', candles: series(300, 3_600_000) }
    ];
    await expect(runPortfolioBacktest(histories, SL, 'intraday')).rejects.toThrow(/ETHUSDT, SOLUSDT/);
  });

  it('leaves legacy and pro on the H1-only path — their runs stay comparable', async () => {
    const h1Only = [{ symbol: 'BTCUSDT', candles: series(300, 3_600_000) }];
    // No throw: the added series are optional, so every snapshot recorded before
    // intraday existed is still a valid input for these two.
    await expect(runPortfolioBacktest(h1Only, SL, 'legacy')).resolves.toBeTruthy();
    await expect(runPortfolioBacktest(h1Only, SL, 'pro')).resolves.toBeTruthy();
  });

  it('runs intraday when all three series are present', async () => {
    const histories = [{
      symbol: 'BTCUSDT',
      candles: series(300, 3_600_000),
      m15: series(400, 900_000),
      m5: series(700, 300_000)
    }];
    const result = await runPortfolioBacktest(histories, SL, 'intraday');
    // Synthetic random-walk data need not produce trades; what matters is that
    // the run completes and reports, rather than throwing or hanging.
    expect(result.totalTrades).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.maxDrawdown)).toBe(true);
  });
});
