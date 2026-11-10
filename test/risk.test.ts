import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blockNewPositionReason, decideExit, priceRatio } from '../src/risk.js';
import { newState, rollDay } from '../src/state.js';
import { plausibleDiff, portion } from '../src/trader.js';
import { NOW, cfg, position } from './helpers.js';

const SOL = 1_000_000_000n;

describe('Ausstiegs-Logik', () => {
  const c = cfg(); // SL 20 %, TP 50 % (50 % verkaufen), Trailing 20 % ab +25 %, max 180 min

  it('berechnet das Kursverhältnis', () => {
    assert.equal(priceRatio(position(), 100_000_000n), 1);
    assert.equal(priceRatio(position(), 150_000_000n), 1.5);
    // nach Teilverkauf: halbe Menge, gleicher Kurs
    assert.equal(priceRatio(position({ tokenRaw: '500000' }), 75_000_000n), 1.5);
  });

  it('hält bei kleiner Bewegung', () => {
    assert.equal(decideExit(position(), 105_000_000n, c, NOW).action, 'hold');
  });

  it('Stop-Loss bei -20 %', () => {
    const d = decideExit(position(), 80_000_000n, c, NOW);
    assert.equal(d.action, 'sell');
    if (d.action === 'sell') {
      assert.equal(d.fraction, 1);
      assert.match(d.reason, /Stop-Loss/);
    }
  });

  it('Take-Profit verkauft nur einen Teil', () => {
    const d = decideExit(position(), 151_000_000n, c, NOW);
    assert.equal(d.action, 'sell');
    if (d.action === 'sell') {
      assert.equal(d.fraction, 0.5);
      assert.match(d.reason, /Take-Profit/);
    }
  });

  it('kein zweiter Take-Profit nach Teilverkauf', () => {
    const d = decideExit(position({ tookProfit: true, peakRatio: 1.6, tokenRaw: '500000' }), 80_000_000n, c, NOW);
    assert.equal(d.action, 'hold'); // Kurs 1.6 = Hoch, kein Rückgang
  });

  it('Trailing-Stop nach Rückgang vom Hoch', () => {
    // Hoch 2.0x, jetzt 1.55x => 22,5 % unter Hoch
    const d = decideExit(position({ tookProfit: true, peakRatio: 2, tokenRaw: '500000' }), 77_500_000n, c, NOW);
    assert.equal(d.action, 'sell');
    if (d.action === 'sell') assert.match(d.reason, /Trailing/);
  });

  it('Trailing-Stop erst ab Aktivierungsschwelle', () => {
    // Hoch nur +10 %, Rückgang auf -5 %: weder Trailing noch Stop-Loss
    assert.equal(decideExit(position({ peakRatio: 1.1 }), 95_000_000n, c, NOW).action, 'hold');
  });

  it('verkauft nach maximaler Haltedauer', () => {
    const d = decideExit(position({ openedAt: NOW - 181 * 60_000 }), 100_000_000n, c, NOW);
    assert.equal(d.action, 'sell');
  });

  it('Stop-Loss hat Vorrang vor allem anderen', () => {
    const d = decideExit(position({ openedAt: NOW - 500 * 60_000 }), 10_000_000n, c, NOW);
    assert.equal(d.action === 'sell' && d.reason.startsWith('Stop-Loss'), true);
  });

  it('aktualisiert das Hoch', () => {
    const d = decideExit(position({ peakRatio: 1.1 }), 120_000_000n, c, NOW);
    assert.equal(d.peakRatio, 1.2);
  });
});

describe('Risiko-Limits', () => {
  const c = cfg(); // 0,05 SOL pro Kauf, Reserve 0,05, max 3 Positionen, Tagesverlust 0,15

  it('erlaubt Kauf mit genug Guthaben', () => {
    assert.equal(blockNewPositionReason(newState('paper', SOL), SOL, c), null);
  });

  it('blockiert bei zu wenig SOL inkl. Reserve', () => {
    assert.match(blockNewPositionReason(newState('paper', SOL), 90_000_000n, c) ?? '', /zu wenig SOL/);
  });

  it('blockiert bei max. offenen Positionen', () => {
    const s = newState('paper', SOL);
    s.positions = [position(), position({ mint: 'B' }), position({ mint: 'C' })];
    assert.match(blockNewPositionReason(s, SOL, c) ?? '', /offener Positionen/);
  });

  it('blockiert nach Tagesverlust-Limit', () => {
    const s = newState('paper', SOL);
    s.day.realizedPnlLamports = (-150_000_000n).toString();
    assert.match(blockNewPositionReason(s, SOL, c) ?? '', /Tagesverlust/);
  });

  it('blockiert nach max. Käufen pro Tag', () => {
    const s = newState('paper', SOL);
    s.day.buys = 15;
    assert.match(blockNewPositionReason(s, SOL, c) ?? '', /Tageslimit/);
  });

  it('setzt Tageszähler am neuen Tag zurück', () => {
    const s = newState('paper', SOL);
    s.day = { date: '2000-01-01', realizedPnlLamports: '-999', buys: 9 };
    assert.equal(rollDay(s), true);
    assert.equal(s.day.buys, 0);
    assert.equal(s.day.realizedPnlLamports, '0');
    assert.equal(rollDay(s), false);
  });
});

describe('Mengen-Hilfen', () => {
  it('portion rundet ab und deckt Grenzen ab', () => {
    assert.equal(portion(1001n, 0.5), 500n);
    assert.equal(portion(1001n, 1), 1001n);
    assert.equal(portion(1001n, 0), 0n);
  });

  it('plausibleDiff akzeptiert nur kleine Abweichungen', () => {
    assert.equal(plausibleDiff(52_000_000n, 50_000_000n), 52_000_000n);
    assert.equal(plausibleDiff(90_000_000n, 50_000_000n), null);
    assert.equal(plausibleDiff(-1n, 50_000_000n), null);
  });
});
