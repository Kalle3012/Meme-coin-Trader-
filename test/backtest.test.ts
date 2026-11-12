import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { backtestAllEntries, biggestHourlyJump, simulateTrade, summarize, type Bar, type SimParams } from '../src/backtest.js';

const P: SimParams = {
  stopLossPct: 20,
  takeProfitPct: 50,
  takeProfitSellFraction: 0.5,
  trailingStopPct: 20,
  trailingActivationPct: 25,
  maxHoldMinutes: 180,
  costPct: 0,
};

const bar = (o: number, h: number, l: number, c: number, i = 0): Bar => ({ t: 1_800_000_000 + i * 3600, o, h, l, c, v: 1 });

describe('Backtest', () => {
  it('Stop-Loss greift bei -20 %', () => {
    const r = simulateTrade([bar(1, 1.05, 0.7, 0.75)], 0, P);
    assert.equal(r.reason, 'Stop-Loss');
    assert.ok(Math.abs(r.multiple - 0.8) < 1e-9);
  });

  it('verkauft bei Kurslücke zum (schlechteren) Eröffnungskurs', () => {
    const r = simulateTrade([bar(1, 1, 1, 1, 0), bar(0.5, 0.55, 0.4, 0.45, 1)], 0, P);
    assert.ok(Math.abs(r.multiple - 0.5) < 1e-9, `${r.multiple}`);
  });

  it('nimmt konservativ an, dass das Tief vor dem Hoch kommt', () => {
    // Gleicher Balken: Hoch +100 %, Tief -30 % -> Stop-Loss, kein Gewinn
    const r = simulateTrade([bar(1, 2, 0.7, 1.5)], 0, P);
    assert.equal(r.reason, 'Stop-Loss');
  });

  it('Take-Profit verkauft die Hälfte, der Rest läuft mit Trailing-Stop', () => {
    const bars = [bar(1, 1.6, 1, 1.5, 0), bar(1.5, 2, 1.5, 1.9, 1), bar(1.9, 1.9, 1.5, 1.5, 2)];
    const r = simulateTrade(bars, 0, P);
    // 0,5 × 1,5 (Take-Profit) + 0,5 × 1,6 (Trailing: 2,0 × 0,8)
    assert.equal(r.reason, 'Trailing-Stop');
    assert.ok(Math.abs(r.multiple - (0.75 + 0.8)) < 1e-9, `${r.multiple}`);
  });

  it('verkauft nach der maximalen Haltedauer', () => {
    const bars = [0, 1, 2, 3, 4].map((i) => bar(1, 1.05, 0.95, 1, i));
    const r = simulateTrade(bars, 0, P);
    assert.equal(r.reason, 'maximale Haltedauer');
    assert.equal(r.exitIdx, 3);
  });

  it('zieht Kosten ab', () => {
    const bars = [0, 1, 2, 3, 4].map((i) => bar(1, 1, 1, 1, i));
    const r = simulateTrade(bars, 0, { ...P, costPct: 3 });
    assert.ok(r.multiple < 0.971 && r.multiple > 0.969, `${r.multiple}`);
  });

  it('fasst viele Einstiege zusammen', () => {
    const s = summarize([{ multiple: 1.5, reason: '', exitIdx: 0 }, { multiple: 0.8, reason: '', exitIdx: 0 }, { multiple: 1, reason: '', exitIdx: 0 }])!;
    assert.equal(s.trades, 3);
    assert.ok(Math.abs(s.medianPct) < 1e-9);
    assert.ok(Math.abs(s.winRatePct - 100 / 3) < 1e-9);
    assert.ok(Math.abs(s.bestPct - 50) < 1e-9);
    assert.ok(Math.abs(s.worstPct + 20) < 1e-9);
    assert.equal(summarize([]), null);
  });

  it('findet den größten Stundensprung und testet alle Einstiege', () => {
    const bars = [bar(1, 1.1, 1, 1, 0), bar(1, 27, 1, 20, 1), bar(20, 21, 8, 9, 2), bar(9, 10, 8, 9, 3)];
    assert.deepEqual(biggestHourlyJump(bars), { idx: 1, pct: 2600 });
    assert.equal(backtestAllEntries(bars, P)!.trades, 3);
  });
});
