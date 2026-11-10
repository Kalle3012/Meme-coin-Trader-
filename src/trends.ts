import type { Config } from './config.js';
import { DexScreenerClient, type DexPair } from './dexscreener.js';
import { RateLimiter, requestJson, requestText } from './http.js';
import { errMsg, log } from './logger.js';

/**
 * Trend-Radar: Liest frei zugängliche Trend-Quellen im Internet und sucht
 * passende Solana-Meme-Coins.
 *
 * Quellen (alle kostenlos, ohne API-Key, im Nov. 2026 live geprüft):
 *  - Eigene Stichwörter (z. B. GTA 6) + Google News: wie viele Artikel in 24 h?
 *  - Google Trends: tägliche Suchtrends (RSS, mehrere Länder)
 *  - Wikipedia: meistgelesene Artikel von gestern
 *  - CoinGecko: aktuell meistgesuchte Coins
 *  - DexScreener: trendende Narrative ("Metas") und deren Token
 * (Reddit blockiert automatische Abfragen, X/Twitter ist kostenpflichtig.)
 *
 * WICHTIG: Ein Trend-Treffer erhöht nur die PRIORITÄT eines Tokens.
 * Alle Markt- und Sicherheitsfilter gelten unverändert – Trend-Coins sind
 * besonders beliebt für Betrug (Kopien, Rug-Pulls, gefälschte "offizielle" Token).
 */

export type TrendSource = 'keyword' | 'google' | 'wikipedia' | 'coingecko' | 'dexmeta';

export interface TrendTopic {
  term: string;
  source: TrendSource;
  weight: number;
  detail: string;
  /** Nur CoinGecko: Symbol des trendenden Coins. */
  symbol?: string;
}

export interface TrendHit {
  mint: string;
  symbol: string;
  name: string;
  score: number;
  reasons: string[];
}

const SOURCE_LABEL: Record<TrendSource, string> = {
  keyword: 'Stichwort',
  google: 'Google Trends',
  wikipedia: 'Wikipedia',
  coingecko: 'CoinGecko-Trend',
  dexmeta: 'DexScreener-Narrativ',
};

const UA = 'Mozilla/5.0 (compatible; MemeCoinTrader/1.0; +https://github.com)';
const MAX_TOKENS_PER_TOPIC = 3; // Schutz vor Kopien: nur die liquidesten Token je Thema
const MAX_TREND_SCORE = 10;

// ------------------------------------------------------------ reine Funktionen

/** Kleinbuchstaben, ohne Akzente/Sonderzeichen/Leerzeichen: "GTA VI!" -> "gtavi" */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Passt ein Token (Name/Symbol) zu einem Trend-Thema? Allgemeine Trends werden strenger geprüft. */
export function topicMatches(topic: TrendTopic, name: string, symbol: string): boolean {
  const t = normalize(topic.term);
  const n = normalize(name);
  const sy = normalize(symbol);
  if (t.length < 3) return false;
  switch (topic.source) {
    case 'keyword':
      return n.includes(t) || sy.includes(t);
    case 'coingecko':
      return n === t || (!!topic.symbol && normalize(topic.symbol).length >= 3 && sy === normalize(topic.symbol));
    default:
      if (t.length < 5) return sy === t;
      return n.includes(t) || sy === t;
  }
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

/** "2K+" -> 2000, "100+" -> 100, "1M+" -> 1000000 */
export function parseTraffic(s: string): number {
  const m = /([\d.,]+)\s*([KkMm]?)/.exec(s);
  if (!m) return 0;
  const base = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(base)) return 0;
  const mult = /m/i.test(m[2] ?? '') ? 1_000_000 : /k/i.test(m[2] ?? '') ? 1000 : 1;
  return base * mult;
}

export function parseGoogleTrendsRss(xml: string): { title: string; traffic: number }[] {
  const out: { title: string; traffic: number }[] = [];
  for (const item of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const title = /<title>([\s\S]*?)<\/title>/.exec(item)?.[1];
    if (!title) continue;
    const traffic = /<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/.exec(item)?.[1] ?? '0';
    out.push({ title: decodeXml(title), traffic: parseTraffic(traffic) });
  }
  return out;
}

/** Anzahl der Feed-Einträge, die jünger als `hours` Stunden sind. */
export function countRecentRssItems(xml: string, now: number, hours = 24): number {
  let n = 0;
  for (const item of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const d = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(item)?.[1];
    const t = d ? Date.parse(d) : NaN;
    if (Number.isFinite(t) && now - t <= hours * 3_600_000 && t <= now + 3_600_000) n++;
  }
  return n;
}

export function parseWikipediaTop(json: unknown, limit = 30): string[] {
  const items = (json as { items?: { articles?: { article: string }[] }[] })?.items;
  const articles = items?.[0]?.articles ?? [];
  const out: string[] = [];
  for (const a of articles) {
    const t = a.article;
    if (!t || t.includes(':') || t === 'Main_Page' || t.startsWith('Hauptseite')) continue;
    out.push(t.replace(/_/g, ' '));
    if (out.length >= limit) break;
  }
  return out;
}

/** Datum von gestern (UTC) im Format YYYY/MM/DD für die Wikimedia-API. */
export function wikipediaDate(now: number): string {
  const d = new Date(now - 86_400_000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
}

/** Gewicht eines Stichworts je nach Nachrichtenlage (Artikel in 24 h). */
export function keywordWeight(newsCount: number | null): number {
  if (newsCount === null) return 3;
  if (newsCount >= 30) return 5; // großer Hype, z. B. Release-Tag
  if (newsCount >= 10) return 4;
  return 3;
}

export function trafficWeight(traffic: number): number {
  if (traffic >= 100_000) return 2;
  if (traffic >= 10_000) return 1.5;
  return 1;
}

/**
 * Ordnet gefundene Paare den Themen zu. Je Thema zählen nur die
 * `MAX_TOKENS_PER_TOPIC` liquidesten Token (Kopien mit wenig Liquidität fallen raus).
 */
export function collectHits(topic: TrendTopic, pairs: DexPair[], hits: Map<string, TrendHit>, matchByName = true): void {
  const best = new Map<string, DexPair>();
  for (const p of pairs) {
    if (p.chainId !== 'solana' || !p.baseToken?.address) continue;
    if (matchByName && !topicMatches(topic, p.baseToken.name ?? '', p.baseToken.symbol ?? '')) continue;
    const cur = best.get(p.baseToken.address);
    if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) best.set(p.baseToken.address, p);
  }
  const top = [...best.values()].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)).slice(0, MAX_TOKENS_PER_TOPIC);
  for (const p of top) {
    const mint = p.baseToken.address;
    const hit = hits.get(mint) ?? { mint, symbol: p.baseToken.symbol, name: p.baseToken.name, score: 0, reasons: [] };
    const reason = `${SOURCE_LABEL[topic.source]} "${topic.term}"${topic.detail ? ` (${topic.detail})` : ''}`;
    if (!hit.reasons.includes(reason)) {
      hit.reasons.push(reason);
      hit.score = Math.min(MAX_TREND_SCORE, hit.score + topic.weight);
    }
    hits.set(mint, hit);
  }
}

// ------------------------------------------------------------ Trend-Radar

export class TrendRadar {
  private readonly dex = new DexScreenerClient();
  private readonly webLimiter = new RateLimiter(1);
  private hits = new Map<string, TrendHit>();
  private topics: TrendTopic[] = [];
  private lastRefresh = 0;
  private running: Promise<void> | null = null;

  constructor(private readonly cfg: Config) {}

  /** Aktuelle Treffer. Ist der Stand veraltet, wird im Hintergrund aktualisiert (blockiert den Bot nicht). */
  current(now = Date.now()): Map<string, TrendHit> {
    if (!this.running && now - this.lastRefresh >= this.cfg.trendRefreshMin * 60_000) {
      this.running = this.refresh()
        .catch((e) => log.warn(`Trend-Radar: Aktualisierung fehlgeschlagen: ${errMsg(e)}`))
        .finally(() => {
          this.running = null;
        });
    }
    return this.hits;
  }

  /** Vollständige Aktualisierung (wartet auf das Ergebnis). */
  async refresh(): Promise<void> {
    const started = Date.now();
    const topics = await this.collectTopics(started);
    const hits = new Map<string, TrendHit>();

    // Themen nach Gewicht sortieren; eigene Stichwörter immer zuerst.
    const searchable = topics
      .filter((t) => t.source !== 'dexmeta')
      .sort((a, b) => (a.source === 'keyword' ? -1 : 0) - (b.source === 'keyword' ? -1 : 0) || b.weight - a.weight);
    let searches = 0;
    for (const topic of searchable) {
      if (searches >= this.cfg.trendMaxSearches) break;
      searches++;
      try {
        const query = topic.source === 'coingecko' && topic.symbol ? topic.symbol : topic.term;
        collectHits(topic, await this.dex.search(query), hits);
      } catch (e) {
        log.debug(`Trend-Suche "${topic.term}" fehlgeschlagen: ${errMsg(e)}`);
      }
    }

    // DexScreener-Narrative liefern ihre Token direkt.
    for (const topic of topics.filter((t) => t.source === 'dexmeta')) {
      try {
        collectHits(topic, await this.dex.metaPairs(topic.term), hits, false);
      } catch (e) {
        log.debug(`Narrativ "${topic.term}" fehlgeschlagen: ${errMsg(e)}`);
      }
    }

    this.topics = topics;
    this.hits = hits;
    this.lastRefresh = Date.now();
    const top = [...hits.values()].sort((a, b) => b.score - a.score).slice(0, 5);
    log.info(
      `Trend-Radar: ${topics.length} Themen, ${searches} Suchen, ${hits.size} passende Token` +
        (top.length ? ` – Top: ${top.map((h) => `${h.symbol} (${h.score.toFixed(1)})`).join(', ')}` : '') +
        ` [${Math.round((Date.now() - started) / 1000)}s]`,
    );
  }

  getTopics(): TrendTopic[] {
    return this.topics;
  }

  getHits(): Map<string, TrendHit> {
    return this.hits;
  }

  private async collectTopics(now: number): Promise<TrendTopic[]> {
    const topics: TrendTopic[] = [];

    for (const kw of this.cfg.trendKeywords) {
      const n = await this.newsCount(kw, now);
      topics.push({
        term: kw,
        source: 'keyword',
        weight: keywordWeight(n),
        detail: n === null ? 'News nicht abrufbar' : `${n} News-Artikel in 24 h`,
      });
    }

    if (!this.cfg.trendInternetSources) return topics;

    for (const geo of this.cfg.trendGeos) {
      try {
        const xml = await requestText(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`, this.webOpts());
        for (const t of parseGoogleTrendsRss(xml)) {
          topics.push({ term: t.title, source: 'google', weight: trafficWeight(t.traffic), detail: `${geo}, ${t.traffic}+ Suchen` });
        }
      } catch (e) {
        log.debug(`Google Trends ${geo} nicht erreichbar: ${errMsg(e)}`);
      }
    }

    try {
      const json = await requestJson<unknown>(
        `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${wikipediaDate(now)}`,
        this.webOpts(),
      );
      for (const title of parseWikipediaTop(json, 20)) topics.push({ term: title, source: 'wikipedia', weight: 1, detail: 'meistgelesen' });
    } catch (e) {
      log.debug(`Wikipedia nicht erreichbar: ${errMsg(e)}`);
    }

    try {
      const cg = await requestJson<{ coins?: { item: { name: string; symbol: string; market_cap_rank?: number | null } }[] }>(
        'https://api.coingecko.com/api/v3/search/trending',
        this.webOpts(),
      );
      for (const c of cg.coins ?? []) {
        const rank = c.item.market_cap_rank;
        if (typeof rank === 'number' && rank <= 100) continue; // große Coins sind keine Meme-Kandidaten
        topics.push({ term: c.item.name, symbol: c.item.symbol, source: 'coingecko', weight: 2, detail: `Symbol ${c.item.symbol}` });
      }
    } catch (e) {
      log.debug(`CoinGecko nicht erreichbar: ${errMsg(e)}`);
    }

    try {
      const metas = (await this.dex.trendingMetas())
        .filter((m) => (m.marketCapChange?.h6 ?? 0) > 0)
        .sort((a, b) => (b.marketCapChange?.h6 ?? 0) - (a.marketCapChange?.h6 ?? 0))
        .slice(0, 3);
      for (const m of metas) {
        topics.push({ term: m.slug, source: 'dexmeta', weight: 1.5, detail: `${m.name}, 6h ${(m.marketCapChange?.h6 ?? 0).toFixed(1)}%` });
      }
    } catch (e) {
      log.debug(`DexScreener-Metas nicht erreichbar: ${errMsg(e)}`);
    }
    return topics;
  }

  private async newsCount(keyword: string, now: number): Promise<number | null> {
    try {
      const q = encodeURIComponent(`"${keyword}" when:1d`);
      const xml = await requestText(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`, this.webOpts());
      return countRecentRssItems(xml, now, 24);
    } catch (e) {
      log.debug(`Google News für "${keyword}" nicht erreichbar: ${errMsg(e)}`);
      return null;
    }
  }

  private webOpts() {
    return { headers: { 'user-agent': UA }, limiter: this.webLimiter, retries: 1, timeoutMs: 20_000 };
  }
}
