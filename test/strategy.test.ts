import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { holderStats, marketRejections, roundtripLossPct, roundtripRejections, safetyRejections } from '../src/strategy.js';
import { NOW, cfg, goodPair, goodReport } from './helpers.js';

describe('Markt-Filter', () => {
  const c = cfg();

  it('lässt ein gesundes Paar durch', () => {
    assert.deepEqual(marketRejections(goodPair(), c, NOW), []);
  });

  it('lehnt zu wenig Liquidität ab', () => {
    const r = marketRejections(goodPair({ liquidity: { usd: 1000 } }), c, NOW);
    assert.ok(r.some((x) => x.includes('Liquidität')));
  });

  it('lehnt zu junge Paare ab (Rug-Gefahr)', () => {
    const r = marketRejections(goodPair({ pairCreatedAt: NOW - 5 * 60_000 }), c, NOW);
    assert.ok(r.some((x) => x.includes('zu jung')));
  });

  it('lehnt Paare ohne Erstellungsdatum ab', () => {
    const r = marketRejections(goodPair({ pairCreatedAt: null }), c, NOW);
    assert.ok(r.some((x) => x.includes('unbekannt')));
  });

  it('lehnt überhitzte Token ab (kein FOMO)', () => {
    const r = marketRejections(goodPair({ priceChange: { m5: 2, h1: 400 } }), c, NOW);
    assert.ok(r.some((x) => x.includes('FOMO')));
  });

  it('lehnt mehr Verkäufe als Käufe ab', () => {
    const r = marketRejections(goodPair({ txns: { h1: { buys: 100, sells: 300 } } }), c, NOW);
    assert.ok(r.some((x) => x.includes('Verhältnis')));
  });

  it('lehnt fallende Kurse ab', () => {
    const r = marketRejections(goodPair({ priceChange: { m5: -10, h1: 10 } }), c, NOW);
    assert.ok(r.some((x) => x.includes('fällt')));
  });

  it('verlangt Social-Links wenn konfiguriert', () => {
    const r = marketRejections(goodPair({ info: null }), c, NOW);
    assert.ok(r.some((x) => x.includes('Social')));
    assert.deepEqual(marketRejections(goodPair({ info: null }), cfg({ REQUIRE_SOCIALS: 'false' }), NOW), []);
  });
});

describe('Sicherheits-Filter (RugCheck)', () => {
  const c = cfg();

  it('lässt einen sauberen Token durch', () => {
    assert.deepEqual(safetyRejections(goodReport(), c), []);
  });

  it('lehnt aktive Mint-Authority ab', () => {
    assert.ok(safetyRejections(goodReport({ mintAuthority: 'abc' }), c).some((x) => x.includes('Mint-Authority')));
  });

  it('lehnt aktive Freeze-Authority ab (Honeypot)', () => {
    assert.ok(safetyRejections(goodReport({ freezeAuthority: 'abc' }), c).some((x) => x.includes('Freeze-Authority')));
  });

  it('erkennt Authorities auch nur im token-Objekt', () => {
    const rep = goodReport({ mintAuthority: undefined as unknown as null, token: { supply: 1, mintAuthority: 'x', freezeAuthority: null } });
    assert.ok(safetyRejections(rep, c).some((x) => x.includes('Mint-Authority')));
  });

  it('lehnt "rugged" Token und Danger-Risiken ab', () => {
    assert.ok(safetyRejections(goodReport({ rugged: true }), c).some((x) => x.includes('rugged')));
    const rep = goodReport({ risks: [{ name: 'Creator history of rugged tokens', value: '', description: '', score: 1, level: 'danger' }] });
    assert.ok(safetyRejections(rep, c).some((x) => x.includes('Creator history')));
  });

  it('lehnt Transfer-Gebühren ab', () => {
    assert.ok(safetyRejections(goodReport({ transferFee: { pct: 5 } }), c).some((x) => x.includes('Transfer-Gebühr')));
  });

  it('lehnt hohen RugCheck-Score ab', () => {
    assert.ok(safetyRejections(goodReport({ score_normalised: 80 }), c).some((x) => x.includes('Score')));
  });

  it('zählt Liquiditätspools nicht als Wal', () => {
    const s = holderStats(goodReport());
    assert.equal(s.maxSinglePct, 2);
    assert.equal(s.top10Pct, 20);
  });

  it('lehnt Holder-Konzentration ab', () => {
    const rep = goodReport({ topHolders: [{ address: 'W', owner: 'W', pct: 25 }] });
    const r = safetyRejections(rep, c);
    assert.ok(r.some((x) => x.includes('größter Holder')));
  });

  it('lehnt große Insider-Netzwerke ab', () => {
    const rep = goodReport({ insiderNetworks: [{ id: 'x', size: 6, type: 'transfer', currentHolding: 400_000 }] });
    const s = holderStats(rep);
    assert.equal(s.insiderPct, 40);
    assert.ok(safetyRejections(rep, c).some((x) => x.includes('Insider')));
  });

  it('lehnt fehlende Holder-Daten ab', () => {
    assert.ok(safetyRejections(goodReport({ topHolders: null }), c).some((x) => x.includes('Holder-Daten')));
  });
});

describe('Honeypot-/Handelbarkeits-Test', () => {
  const c = cfg();

  it('berechnet den Roundtrip-Verlust', () => {
    assert.ok(Math.abs(roundtripLossPct(100n, 95n) - 5) < 1e-9);
    assert.equal(roundtripLossPct(0n, 95n), 100);
  });

  it('akzeptiert normale Kosten', () => {
    assert.deepEqual(roundtripRejections(100_000_000n, 97_000_000n, 0.5, c), []);
  });

  it('lehnt Honeypots/Steuer-Token ab', () => {
    assert.ok(roundtripRejections(100_000_000n, 50_000_000n, 0.5, c).some((x) => x.includes('Honeypot')));
  });

  it('lehnt hohen oder unbekannten Preiseinfluss ab', () => {
    assert.ok(roundtripRejections(100n, 99n, 10, c).some((x) => x.includes('Preiseinfluss')));
    assert.ok(roundtripRejections(100n, 99n, null, c).some((x) => x.includes('unbekannt')));
  });
});
