import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mcapOf, nicheHeatFromMetas, nichesOf, scoreEarly, wordsOf, type ScoreContext } from '../src/early.js';
import { bucketStats, parseEarlyCsv } from '../src/evaluation.js';
import type { JupToken } from '../src/jupiter.js';
import { blockNewPositionReason, decideExit, profileParams } from '../src/risk.js';
import { newState } from '../src/state.js';
import type { TrendTopic } from '../src/trends.js';
import { NOW, cfg, position } from './helpers.js';

const c = cfg();

function token(over: Partial<JupToken> = {}): JupToken {
  return {
    id: 'MINT',
    name: 'Space Cat',
    symbol: 'SCAT',
    holderCount: 200,
    mcap: 150_000,
    liquidity: 25_000,
    organicScore: 40,
    twitter: 'https://x.com/spacecat',
    website: 'https://spacecat.example',
    telegram: null,
    audit: {
      isSus: false,
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      topHoldersPercentage: 18,
      devBalancePercentage: 2,
      devMints: 1,
    },
    stats5m: { numTraders: 80, numNetBuyers: 50, buyVolume: 9000, sellVolume: 4000 },
    stats1h: { numTraders: 150, numNetBuyers: 90, buyVolume: 30_000, sellVolume: 15_000 },
    ...over,
  };
}

function ctx(over: Partial<ScoreContext> = {}): ScoreContext {
  return {
    ageMin: 12,
    firstMcap: 50_000,
    maxMcap: 150_000,
    graduated: false,
    topics: [],
    nicheHeat: new Map([['cat', 12]]),
    ...over,
  };
}

describe('Nischen-Erkennung', () => {
  it('zerlegt Namen in Wörter', () => {
    assert.ok(wordsOf('SpaceCat', 'SCAT').includes('cat'));
    assert.ok(wordsOf('GTA VI', 'GTA6').includes('gtavi'));
  });

  it('ordnet Coins Nischen zu', () => {
    assert.deepEqual(nichesOf('Space Cat', 'SCAT'), ['cat']);
    assert.ok(nichesOf('Shiba Inu Moon', 'SHIBM').includes('dog'));
    assert.ok(nichesOf('Vice City Heat', 'HEAT').includes('gaming'));
    assert.ok(nichesOf('AI Agent', 'AGNT').includes('ai'));
  });

  it('erkennt kurze Begriffe nur als ganzes Wort', () => {
    assert.ok(!nichesOf('Maid', 'MAID').includes('ai'), '"ai" darf nicht in "Maid" gefunden werden');
    assert.deepEqual(nichesOf('Random Token', 'RND'), []);
  });

  it('berechnet die Hitze aus den DexScreener-Metas', () => {
    const heat = nicheHeatFromMetas([
      { name: 'Cat', slug: 'cat', marketCapChange: { h6: 5 } },
      { name: 'Dog', slug: 'dog', marketCapChange: { h6: 3 } },
      { name: 'AI', slug: 'ai', marketCapChange: { h6: 2 } },
      { name: 'Frog', slug: 'frog', marketCapChange: { h6: 1 } },
      { name: 'Trump', slug: 'trump', marketCapChange: { h6: -4 } },
    ]);
    assert.equal(heat.get('cat'), 12);
    assert.equal(heat.get('ai'), 12);
    assert.equal(heat.get('frog'), 6);
    assert.equal(heat.get('trump'), 0);
  });
});

describe('Potenzial-Score', () => {
  it('bewertet einen gesunden, gefragten Coin hoch', () => {
    const s = scoreEarly(token(), ctx(), c);
    assert.deepEqual(s.gates, []);
    assert.deepEqual(s.waits, []);
    assert.ok(s.total >= 60, `Score ${s.total} sollte >= 60 sein`);
    assert.ok(s.reasons.some((r) => r.includes('Nische cat')));
  });

  it('bleibt innerhalb von 0–100', () => {
    const topics: TrendTopic[] = [{ term: 'space cat', source: 'keyword', weight: 5, detail: '' }];
    const s = scoreEarly(token({ organicScore: 100, telegram: 't.me/x' }), ctx({ topics, graduated: true, firstMcap: 1000 }), c);
    assert.ok(s.total <= 100 && s.total >= 0);
    assert.ok(s.narrative <= 35 && s.momentum <= 35 && s.community <= 15 && s.safety <= 15);
  });

  it('gibt Trend-Stichwörtern einen großen Bonus', () => {
    const topics: TrendTopic[] = [{ term: 'gta6', source: 'keyword', weight: 5, detail: '' }];
    const base = scoreEarly(token({ name: 'GTA6 Coin', symbol: 'GTA6' }), ctx({ topics: [] }), c);
    const withKw = scoreEarly(token({ name: 'GTA6 Coin', symbol: 'GTA6' }), ctx({ topics }), c);
    assert.ok(withKw.narrative >= base.narrative + 20);
    assert.ok(withKw.reasons.some((r) => r.includes('gta6')));
  });

  it('schließt Betrugsmuster hart aus', () => {
    const cases: [Partial<JupToken>, RegExp][] = [
      [{ audit: { ...token().audit, isSus: true } }, /verdächtig/],
      [{ audit: { ...token().audit, mintAuthorityDisabled: false } }, /Mint-Authority/],
      [{ audit: { ...token().audit, freezeAuthorityDisabled: null } }, /Freeze-Authority/],
      [{ audit: { ...token().audit, devBalancePercentage: 88 } }, /Entwickler hält/],
      [{ audit: { ...token().audit, devMints: 11038 } }, /Massen-Launcher/],
      [{ audit: { ...token().audit, topHoldersPercentage: 70 } }, /Top-Holder/],
      [{ stats5m: { priceChange: -100 } }, /Kurs 5 min/],
    ];
    for (const [over, re] of cases) {
      const s = scoreEarly(token(over), ctx(), c);
      assert.ok(s.gates.some((g) => re.test(g)), `erwartet ${re}, erhalten: ${s.gates.join(', ')}`);
    }
  });

  it('erkennt einen laufenden Absturz', () => {
    const s = scoreEarly(token({ mcap: 60_000 }), ctx({ maxMcap: 200_000 }), c);
    assert.ok(s.gates.some((g) => g.includes('Absturz')));
  });

  it('wartet bei zu jungen oder zu kleinen Coins', () => {
    const s = scoreEarly(token({ holderCount: 10, liquidity: 2000 }), ctx({ ageMin: 2 }), c);
    assert.ok(s.waits.some((w) => w.includes('min alt')));
    assert.ok(s.waits.some((w) => w.includes('Liquidität')));
    assert.ok(s.waits.some((w) => w.includes('Holder')));
    assert.equal(s.gates.length, 0);
  });

  it('nutzt fdv, wenn mcap fehlt', () => {
    assert.equal(mcapOf(token({ mcap: null, fdv: 5000 })), 5000);
    assert.equal(mcapOf(token({ mcap: null, fdv: null })), 0);
  });
});

describe('Frühphasen-Risikoprofil', () => {
  it('nutzt eigene Ausstiegsregeln (Stop-Loss -30 % statt -20 %)', () => {
    const p = position({ profile: 'early' });
    assert.equal(decideExit(p, 75_000_000n, c, NOW).action, 'hold'); // -25 %
    assert.equal(decideExit(position(), 75_000_000n, c, NOW).action, 'sell'); // normal: -20 % greift
    assert.equal(decideExit(p, 69_000_000n, c, NOW).action, 'sell');
  });

  it('Take-Profit erst bei +100 %', () => {
    const p = position({ profile: 'early' });
    assert.equal(decideExit(p, 160_000_000n, c, NOW).action, 'hold');
    const d = decideExit(p, 201_000_000n, c, NOW);
    assert.equal(d.action === 'sell' && d.fraction, 0.5);
  });

  it('zählt Frühphasen-Positionen getrennt und nutzt den kleineren Kaufbetrag', () => {
    const s = newState('paper', 1_000_000_000n);
    s.positions = [position({ mint: 'A', profile: 'early' }), position({ mint: 'B', profile: 'early' })];
    assert.match(blockNewPositionReason(s, 1_000_000_000n, c, 'early') ?? '', /Frühphasen/);
    assert.equal(blockNewPositionReason(s, 1_000_000_000n, c, 'normal'), null);
    assert.equal(profileParams(c, 'early').buyAmountSol, 0.02);
    // 0,02 + 0,05 Reserve = 0,07 SOL reichen für Frühphase, aber nicht für normal (0,1)
    const empty = newState('paper', 0n);
    assert.equal(blockNewPositionReason(empty, 80_000_000n, c, 'early'), null);
    assert.match(blockNewPositionReason(empty, 80_000_000n, c, 'normal') ?? '', /zu wenig SOL/);
  });
});

describe('Erfolgsmessung', () => {
  const header = 'zeit_utc;typ;mint;symbol;alter_min;score;narrativ;momentum;community;sicherheit;ausschluss;mcap_usd;holder;aenderung_pct;gruende\n';
  const row = (typ: string, mint: string, score: number, gates: string, change: string) =>
    `2026-11-10T10:00:00.000Z;${typ};${mint};SYM;5.0;${score};0;0;0;0;${gates};1000;10;${change};\n`;

  it('liest Bewertungen und Messpunkte', () => {
    const csv =
      header +
      row('BEWERTUNG', 'A', 85, '', '') +
      row('NACH15', 'A', 85, '', '50.0') +
      row('NACH60', 'A', 85, '', '150.0') +
      row('BEWERTUNG', 'B', 20, 'Entwickler hält 88%', '') +
      row('NACH60_VERSCHWUNDEN', 'B', 20, 'Entwickler hält 88%', '-100.0');
    const rows = parseEarlyCsv(csv);
    assert.equal(rows.length, 2);
    const a = rows.find((r) => r.mint === 'A')!;
    assert.equal(a.change15, 50);
    assert.equal(a.change60, 150);
    const b = rows.find((r) => r.mint === 'B')!;
    assert.equal(b.gated, true);
    assert.equal(b.vanished60, true);
  });

  it('fasst nach Score-Gruppen zusammen', () => {
    let csv = header;
    for (let i = 0; i < 4; i++) csv += row('BEWERTUNG', `H${i}`, 85, '', '') + row('NACH60', `H${i}`, 85, '', String(i < 2 ? 150 : 10));
    for (let i = 0; i < 4; i++) csv += row('BEWERTUNG', `L${i}`, 10, '', '') + row('NACH60', `L${i}`, 10, '', String(i < 3 ? -80 : 5));
    const stats = bucketStats(parseEarlyCsv(csv));
    const top = stats.find((s) => s.label === 'Score 80–100')!;
    const low = stats.find((s) => s.label === 'Score 0–39')!;
    assert.equal(top.count, 4);
    assert.equal(top.doubled60Pct, 50);
    assert.equal(low.crashed60Pct, 75);
    assert.equal(top.median60, 80);
  });
});
