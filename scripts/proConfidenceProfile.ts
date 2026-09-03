/**
 * Confidence profile for the Pro signal engine.
 *
 * Pro routes Spot at rawConfidence >= dynamicConfidenceThreshold(60, atr%) and
 * Futures at >= dynamicConfidenceThreshold(72, atr%). Neither threshold means
 * anything until you know what the score can actually REACH — the weights sum
 * to 100 only if all seven indicators can fire at full strength at once, which
 * is an assumption, not a fact.
 *
 * This measures the reachable distribution, the share clearing each routing
 * threshold, and per-indicator behaviour: maximum strength ever observed, how
 * often each reaches full strength, and how many reach it simultaneously.
 *
 * Read-only. Fetches its own candles so it can be pointed at any universe or
 * window — the point is to check whether a finding survives outside the window
 * it was found in.
 *
 * Usage:
 *   npx tsx scripts/proConfidenceProfile.ts --from 2025-01-01 --to 2025-07-01 --top 40
 *   npx tsx scripts/proConfidenceProfile.ts --from 2024-07-01 --to 2025-01-01 --symbols BTCUSDT,ETHUSDT
 */

import { detectProRegime, evaluateProSignals, proDynamicConfidenceThreshold as dynamicConfidenceThreshold } from '@cde/engine/analysis';
import type { Candle } from '@cde/engine/execution';

const SPOT = 'https://api.binance.com/api/v3';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

/** Top USDT pairs by 24h quote volume — a broader, differently-chosen universe
 *  than any hand-picked basket, which is the point when testing for selection
 *  artefacts. */
async function topSymbols(n: number): Promise<string[]> {
  const res = await fetch(`${SPOT}/ticker/24hr`);
  const rows = (await res.json()) as { symbol: string; quoteVolume: string }[];
  return rows
    .filter((r) => r.symbol.endsWith('USDT') && !/(UP|DOWN|BULL|BEAR)USDT$/.test(r.symbol))
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, n)
    .map((r) => r.symbol);
}

async function klines(symbol: string, startMs: number, endMs: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = startMs, guard = 0;
  while (cursor < endMs && guard++ < 500) {
    const res = await fetch(`${SPOT}/klines?symbol=${symbol}&interval=1h&startTime=${cursor}&endTime=${endMs}&limit=1000`);
    if (!res.ok) return out;
    const rows = (await res.json()) as unknown[];
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows as unknown[][]) {
      out.push({
        timestamp: Number(r[0]), open: Number(r[1]), high: Number(r[2]),
        low: Number(r[3]), close: Number(r[4]), volume: Number(r[5])
      });
    }
    const last = out[out.length - 1].timestamp;
    if (last <= cursor) break;
    cursor = last + 1;
    await new Promise((r) => setTimeout(r, 120));
  }
  return out;
}

const q = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
};
const share = (a: number[], t: number) => ((a.filter((v) => v >= t).length / Math.max(1, a.length)) * 100).toFixed(2);

async function main() {
  const from = arg('from');
  const to = arg('to');
  const startMs = Date.parse(`${from}T00:00:00Z`);
  const endMs = Date.parse(`${to}T00:00:00Z`);

  const explicit = process.argv.indexOf('--symbols');
  const symbols = explicit >= 0
    ? process.argv[explicit + 1].split(',')
    : await topSymbols(Number(arg('top', '40')));

  const raw: number[] = [];
  // Threshold clearance measured against each bar's OWN dynamic threshold,
  // not the base — the ATR ramp is part of what a signal has to beat.
  let spotOk = 0, futOk = 0, evaluated = 0;
  const topHits = new Map<string, number>();
  const seen = new Map<string, number>();
  const maxStrength = new Map<string, number>();
  const weightOf = new Map<string, number>();
  const simultaneous: number[] = [];

  process.stdout.write(`fetching ${symbols.length} symbols ${from} -> ${to}\n`);
  let done = 0;
  for (const symbol of symbols) {
    const candles = await klines(symbol, startMs, endMs);
    done++;
    if (candles.length < 200) { process.stdout.write(`  ${symbol}: skip (${candles.length})\n`); continue; }
    process.stdout.write(`\r  ${done}/${symbols.length} ${symbol.padEnd(12)}`);

    for (let i = 60; i < candles.length; i += 4) {
      const slice = candles.slice(0, i + 1);
      const price = candles[i].close;
      const regime = detectProRegime(slice, price);
      const ev = evaluateProSignals(slice, price, 0, regime, 50);

      raw.push(ev.rawConfidence);
      evaluated++;
      if (ev.rawConfidence >= dynamicConfidenceThreshold(60, regime.atrPercent)) spotOk++;
      if (ev.rawConfidence >= dynamicConfidenceThreshold(72, regime.atrPercent)) futOk++;

      const winning = ev.action === 'HOLD' ? null : ev.action;
      let n = 0;
      for (const s of ev.signals) {
        seen.set(s.name, (seen.get(s.name) ?? 0) + 1);
        weightOf.set(s.name, s.weight);
        maxStrength.set(s.name, Math.max(maxStrength.get(s.name) ?? 0, s.strength));
        if (winning && s.signal === winning && s.strength >= 0.999) {
          topHits.set(s.name, (topHits.get(s.name) ?? 0) + 1);
          n++;
        }
      }
      if (winning) simultaneous.push(n);
    }
  }

  console.log(`\n\n${from} -> ${to}   ${symbols.length} symbols   n=${raw.length}\n`);
  console.log('rawConfidence:');
  console.log(`  p50 ${q(raw, 0.5).toFixed(1)}   p90 ${q(raw, 0.9).toFixed(1)}   p99 ${q(raw, 0.99).toFixed(1)}   MAX ${Math.max(...raw).toFixed(1)}`);
  console.log(`\n  >= 60 base    : ${share(raw, 60)}%`);
  console.log(`  >= 72 base    : ${share(raw, 72)}%`);
  console.log(`  clears its own DYNAMIC threshold:`);
  console.log(`    Spot    : ${((spotOk / Math.max(1, evaluated)) * 100).toFixed(2)}%`);
  console.log(`    Futures : ${((futOk / Math.max(1, evaluated)) * 100).toFixed(2)}%`);

  console.log('\nper-indicator:');
  for (const name of seen.keys()) {
    const w = weightOf.get(name) ?? 0;
    const ms = maxStrength.get(name) ?? 0;
    const full = ((topHits.get(name) ?? 0) / (seen.get(name) ?? 1)) * 100;
    const flag = ms < 0.999 ? '  <-- CANNOT REACH 1.0' : full > 60 ? '  <-- near-constant' : '';
    console.log(`  ${name.padEnd(22)} w=${String(w).padStart(2)}  maxStrength ${ms.toFixed(2)}  at-full ${full.toFixed(1)}%${flag}`);
  }

  const mean = simultaneous.reduce((a, b) => a + b, 0) / Math.max(1, simultaneous.length);
  console.log(`\nindicators simultaneously at full strength (of 7): mean ${mean.toFixed(2)}  max ${Math.max(...simultaneous)}`);
  console.log('');
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
