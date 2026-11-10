import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { compareCandidates, marketRejections, rankedScore, type Candidate } from '../src/strategy.js';
import {
  collectHits,
  countRecentRssItems,
  keywordWeight,
  normalize,
  parseGoogleTrendsRss,
  parseTraffic,
  parseWikipediaTop,
  topicMatches,
  wikipediaDate,
  type TrendHit,
  type TrendTopic,
} from '../src/trends.js';
import { NOW, cfg, goodPair } from './helpers.js';

const kw = (term: string): TrendTopic => ({ term, source: 'keyword', weight: 3, detail: '' });

describe('Trend-Zuordnung', () => {
  it('normalisiert Schreibweisen', () => {
    assert.equal(normalize('GTA VI!'), 'gtavi');
    assert.equal(normalize('Vice City'), 'vicecity');
    assert.equal(normalize('Léonida'), 'leonida');
  });

  it('erkennt GTA-6-Token über Stichwörter', () => {
    assert.ok(topicMatches(kw('gta 6'), 'GTA 6 Coin', 'GTA6'));
    assert.ok(topicMatches(kw('gta vi'), 'GTA VI', 'GTA6'));
    assert.ok(topicMatches(kw('vice city'), 'Vice City Heat', 'HEAT'));
    assert.ok(!topicMatches(kw('gta6'), 'Doge', 'DOGE'));
  });

  it('prüft allgemeine Trends strenger', () => {
    const google: TrendTopic = { term: 'ss united states', source: 'google', weight: 1, detail: '' };
    assert.ok(topicMatches(google, 'SS United States', 'SSUS'));
    assert.ok(!topicMatches(google, 'United', 'UNI'));
    const short: TrendTopic = { term: 'silo', source: 'google', weight: 1, detail: '' };
    assert.ok(topicMatches(short, 'Whatever', 'SILO'));
    assert.ok(!topicMatches(short, 'Silo Cat', 'SCAT'), 'kurze Begriffe nur über exaktes Symbol');
  });

  it('CoinGecko: Name oder Symbol müssen exakt passen', () => {
    const cg: TrendTopic = { term: 'Dacity Coin', symbol: 'DACITY', source: 'coingecko', weight: 2, detail: '' };
    assert.ok(topicMatches(cg, 'Dacity Coin', 'DCTY'));
    assert.ok(topicMatches(cg, 'Something', 'DACITY'));
    assert.ok(!topicMatches(cg, 'Dacity Coin Killer', 'DCK'));
  });

  it('ignoriert zu kurze Themen', () => {
    assert.ok(!topicMatches(kw('ai'), 'AI Agent', 'AI'));
  });
});

describe('Kopien-Schutz', () => {
  it('nimmt je Thema nur die 3 liquidesten Token und summiert Treffer', () => {
    const pairs = [10, 50, 30, 40, 20].map((liq, i) =>
      goodPair({ baseToken: { address: `M${i}`, name: 'GTA VI', symbol: 'GTA6' }, liquidity: { usd: liq * 1000 } }),
    );
    const hits = new Map<string, TrendHit>();
    collectHits(kw('gta6'), pairs, hits);
    assert.deepEqual([...hits.keys()].sort(), ['M1', 'M2', 'M3']);
    collectHits(kw('gta vi'), pairs, hits);
    assert.equal(hits.get('M1')?.score, 6);
    assert.equal(hits.get('M1')?.reasons.length, 2);
  });

  it('zählt dasselbe Thema nicht doppelt und ignoriert andere Chains', () => {
    const p = goodPair({ baseToken: { address: 'X', name: 'GTA6', symbol: 'GTA6' } });
    const other = goodPair({ chainId: 'base', baseToken: { address: 'Y', name: 'GTA6', symbol: 'GTA6' } });
    const hits = new Map<string, TrendHit>();
    collectHits(kw('gta6'), [p, other], hits);
    collectHits(kw('gta6'), [p], hits);
    assert.equal(hits.size, 1);
    assert.equal(hits.get('X')?.score, 3);
  });

  it('begrenzt den Trend-Score', () => {
    const p = goodPair({ baseToken: { address: 'X', name: 'gta6 gta vi vice city leonida', symbol: 'GTA6' } });
    const hits = new Map<string, TrendHit>();
    for (const t of ['gta6', 'gta vi', 'vice city', 'leonida']) collectHits({ ...kw(t), weight: 5 }, [p], hits);
    assert.equal(hits.get('X')?.score, 10);
  });
});

describe('Quellen-Parser', () => {
  it('liest Google-Trends-RSS', () => {
    const xml = `<rss><channel><item><title>GTA 6 &amp; More</title><ht:approx_traffic>200K+</ht:approx_traffic></item>
      <item><title><![CDATA[Vice City]]></title><ht:approx_traffic>500+</ht:approx_traffic></item></channel></rss>`;
    assert.deepEqual(parseGoogleTrendsRss(xml), [
      { title: 'GTA 6 & More', traffic: 200_000 },
      { title: 'Vice City', traffic: 500 },
    ]);
  });

  it('liest Suchvolumen-Angaben', () => {
    assert.equal(parseTraffic('2K+'), 2000);
    assert.equal(parseTraffic('1M+'), 1_000_000);
    assert.equal(parseTraffic('1,000+'), 1000);
    assert.equal(parseTraffic('?'), 0);
  });

  it('zählt nur News der letzten 24 Stunden', () => {
    const item = (d: Date) => `<item><title>x</title><pubDate>${d.toUTCString()}</pubDate></item>`;
    const xml = [item(new Date(NOW - 3_600_000)), item(new Date(NOW - 23 * 3_600_000)), item(new Date(NOW - 30 * 3_600_000))].join('');
    assert.equal(countRecentRssItems(xml, NOW, 24), 2);
  });

  it('gewichtet Stichwörter nach Nachrichtenlage', () => {
    assert.equal(keywordWeight(null), 3);
    assert.equal(keywordWeight(5), 3);
    assert.equal(keywordWeight(15), 4);
    assert.equal(keywordWeight(100), 5);
  });

  it('liest Wikipedia-Toplisten ohne Spezialseiten', () => {
    const json = { items: [{ articles: [{ article: 'Main_Page' }, { article: 'Special:Search' }, { article: 'Grand_Theft_Auto_VI' }] }] };
    assert.deepEqual(parseWikipediaTop(json), ['Grand Theft Auto VI']);
    assert.deepEqual(parseWikipediaTop({}), []);
  });

  it('nutzt das Datum von gestern (UTC)', () => {
    assert.equal(wikipediaDate(Date.UTC(2026, 10, 10, 1)), '2026/11/09');
    assert.equal(wikipediaDate(Date.UTC(2026, 0, 1, 12)), '2025/12/31');
  });
});

describe('Trend-Regeln in der Strategie', () => {
  const c = cfg();

  it('erlaubt älteren, größeren Coins nur mit Trend-Bezug', () => {
    const p = goodPair({ pairCreatedAt: NOW - 300 * 3_600_000, marketCap: 20_000_000 });
    const normal = marketRejections(p, c, NOW, false);
    assert.ok(normal.some((r) => r.includes('zu alt')));
    assert.ok(normal.some((r) => r.includes('Market Cap')));
    assert.deepEqual(marketRejections(p, c, NOW, true), []);
  });

  it('lockert für Trends KEINE Sicherheits- oder Aktivitätsfilter', () => {
    const fake = goodPair({ marketCap: 12_000_000_000, volume: { h1: 0 }, txns: { h1: { buys: 0, sells: 0 } } });
    const r = marketRejections(fake, c, NOW, true);
    assert.ok(r.some((x) => x.includes('Market Cap')));
    assert.ok(r.some((x) => x.includes('Volumen')));
    const young = goodPair({ pairCreatedAt: NOW - 5 * 60_000 });
    assert.ok(marketRejections(young, c, NOW, true).some((x) => x.includes('zu jung')));
  });

  it('prüft Trend-Kandidaten immer zuerst', () => {
    const p = goodPair();
    const normalHuge: Candidate = { mint: 'A', symbol: 'A', pair: p, score: 1000 };
    const trendSmall: Candidate = { mint: 'B', symbol: 'B', pair: p, score: 1, trend: { score: 3, reasons: [] } };
    const trendBig: Candidate = { mint: 'C', symbol: 'C', pair: p, score: 5, trend: { score: 3, reasons: [] } };
    assert.deepEqual([normalHuge, trendSmall, trendBig].sort(compareCandidates).map((c) => c.mint), ['C', 'B', 'A']);
  });

  it('bevorzugt Trend-Treffer in der Rangfolge', () => {
    const p = goodPair();
    assert.ok(rankedScore(p, 5) > rankedScore(p, 0));
    assert.equal(rankedScore(p, -3), rankedScore(p, 0));
  });

  it('prüft die Trend-Einstellungen', () => {
    assert.deepEqual(loadConfig({}).trendKeywords, ['gta6', 'gta 6', 'gta vi', 'vice city', 'leonida', 'lucia']);
    assert.deepEqual(loadConfig({ TREND_KEYWORDS: ' Pepe , GTA6,pepe ' }).trendKeywords, ['pepe', 'gta6']);
    assert.throws(() => loadConfig({ TREND_KEYWORDS: 'ai' }), /zu kurz/);
    assert.throws(() => loadConfig({ TREND_GEOS: 'Germany' }), /Ländercode/);
    assert.throws(() => loadConfig({ TREND_ONLY: 'true', TREND_ENABLED: 'false' }), /TREND_ONLY/);
  });
});
