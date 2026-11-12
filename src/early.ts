import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { DexScreenerClient, type DexMeta } from './dexscreener.js';
import type { JupiterClient, JupToken } from './jupiter.js';
import { errMsg, log } from './logger.js';
import { normalize, topicMatches, type TrendRadar, type TrendTopic } from './trends.js';

/**
 * Frühphasen-Radar: findet ganz neue Coins Sekunden nach dem Start und bewertet
 * ihr Potenzial mit einem nachvollziehbaren Score (0–100).
 *
 * Quellen:
 *  - PumpPortal-Stream (wss://pumpportal.fun/api/data): jeder neue Pump.fun-Coin in Echtzeit
 *    (kostenlos; laut Betreiber nur EINE Verbindung erlaubt – wird hier strikt eingehalten)
 *  - Jupiter Tokens API "recent": neueste Coins aller Launchpads, inkl. Sicherheitsdaten
 *
 * Ein Coin wird erst nach einer Mindest-Beobachtungszeit bewertet (die ersten Minuten
 * gehören Sniper-Bots, und die meisten Rug-Pulls passieren sofort). Jede Bewertung wird
 * mit dem späteren Kursverlauf (+15 / +60 min) protokolliert, damit sich messen lässt,
 * ob hohe Scores wirklich häufiger steigen ("npm run auswertung").
 */

// ------------------------------------------------------------ Nischen

/**
 * Meme-Nischen und typische Begriffe. Die Schlüssel entsprechen den
 * "Metas" von DexScreener, deren Marktentwicklung die "Hitze" einer Nische liefert.
 */
export const NICHES: Record<string, string[]> = {
  cat: ['cat', 'cats', 'kitty', 'kitten', 'meow', 'neko', 'popcat', 'mew', 'purr'],
  dog: ['dog', 'doge', 'inu', 'shib', 'shiba', 'puppy', 'pup', 'wif', 'bonk', 'corgi', 'pitbull'],
  ai: ['ai', 'agent', 'agents', 'gpt', 'llm', 'neural', 'robot', 'agi', 'claude', 'grok', 'openai'],
  trump: ['trump', 'maga', 'donald', 'melania', 'barron', 'potus'],
  'elon-musk': ['elon', 'musk', 'tesla', 'spacex', 'doge'],
  celebrity: ['kanye', 'drake', 'taylor', 'swift', 'beyonce', 'mrbeast', 'kardashian'],
  tiktok: ['tiktok', 'viral', 'trend'],
  brainrot: ['skibidi', 'rizz', 'sigma', 'gyatt', 'ohio', 'brainrot', 'mewing', 'fanum'],
  stonks: ['stonks', 'stock', 'stocks', 'nasdaq', 'wallstreet', 'bull', 'bear'],
  chinese: ['chinese', 'china', 'dragon', 'panda', 'mao'],
  frog: ['pepe', 'frog', 'kek', 'ribbit', 'toad'],
  gaming: ['gta', 'gta6', 'gtavi', 'vicecity', 'leonida', 'game', 'gamer', 'nintendo', 'pokemon', 'mario', 'minecraft', 'roblox', 'fortnite'],
  degen: ['degen', 'ape', 'gamble', 'casino', 'moon', 'lambo'],
};

/** Wörter aus Name und Symbol (Kleinbuchstaben, ohne Sonderzeichen). */
export function wordsOf(name: string, symbol: string): string[] {
  const raw = `${name} ${symbol}`
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return [...new Set([...raw, normalize(name), normalize(symbol)].filter((w) => w.length > 0))];
}

/** Welche Nischen passen zu Name/Symbol? Kurze Begriffe (≤3) nur als ganzes Wort. */
export function nichesOf(name: string, symbol: string): string[] {
  const words = wordsOf(name, symbol);
  const out: string[] = [];
  for (const [niche, terms] of Object.entries(NICHES)) {
    const hit = terms.some((t) => words.some((w) => w === t || (t.length >= 4 && w.includes(t))));
    if (hit) out.push(niche);
  }
  return out;
}

/** "Hitze" je Nische aus den DexScreener-Metas: 12 = Top-3 steigend, 6 = steigend, 0 = fallend. */
export function nicheHeatFromMetas(metas: DexMeta[]): Map<string, number> {
  const heat = new Map<string, number>();
  const rising = metas
    .filter((m) => (m.marketCapChange?.h6 ?? 0) > 0)
    .sort((a, b) => (b.marketCapChange?.h6 ?? 0) - (a.marketCapChange?.h6 ?? 0));
  rising.forEach((m, i) => heat.set(m.slug, i < 3 ? 12 : 6));
  for (const m of metas) if (!heat.has(m.slug)) heat.set(m.slug, 0);
  return heat;
}

// ------------------------------------------------------------ Score

export interface EarlyScore {
  total: number;
  narrative: number;
  momentum: number;
  community: number;
  safety: number;
  /** Harte Ausschlussgründe – Coin wird nie gekauft. */
  gates: string[];
  /** Noch nicht kaufbar (z. B. zu jung) – kann sich ändern. */
  waits: string[];
  reasons: string[];
}

export interface ScoreContext {
  ageMin: number;
  firstMcap: number;
  maxMcap: number;
  graduated: boolean;
  topics: TrendTopic[];
  nicheHeat: Map<string, number>;
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

export function mcapOf(t: JupToken): number {
  if (typeof t.mcap === 'number' && t.mcap > 0) return t.mcap;
  if (typeof t.fdv === 'number' && t.fdv > 0) return t.fdv;
  return 0;
}

export function scoreEarly(t: JupToken, ctx: ScoreContext, cfg: Config): EarlyScore {
  const gates: string[] = [];
  const waits: string[] = [];
  const reasons: string[] = [];
  const a = t.audit ?? {};
  const mcap = mcapOf(t);
  const holders = t.holderCount ?? 0;
  const liq = t.liquidity ?? 0;

  // ---- Harte Ausschlüsse (Betrugsmuster)
  if (a.isSus) gates.push('von Jupiter als verdächtig markiert');
  if (a.mintAuthorityDisabled !== true) gates.push('Mint-Authority nicht entzogen');
  if (a.freezeAuthorityDisabled !== true) gates.push('Freeze-Authority nicht entzogen');
  const devPct = a.devBalancePercentage ?? 0;
  if (devPct > cfg.earlyMaxDevPct) gates.push(`Entwickler hält ${devPct.toFixed(1)}% > ${cfg.earlyMaxDevPct}%`);
  const topPct = a.topHoldersPercentage ?? 0;
  if (topPct > cfg.earlyMaxTopHoldersPct) gates.push(`Top-Holder halten ${topPct.toFixed(1)}% > ${cfg.earlyMaxTopHoldersPct}%`);
  const devMints = a.devMints ?? 0;
  if (devMints > cfg.earlyMaxDevMints) gates.push(`Massen-Launcher: Entwickler hat ${devMints} Coins erstellt`);
  if (ctx.maxMcap > 0 && mcap < ctx.maxMcap * 0.5) gates.push(`Absturz: ${Math.round((1 - mcap / ctx.maxMcap) * 100)}% unter Hoch`);
  const ch5 = t.stats5m?.priceChange;
  if (typeof ch5 === 'number' && ch5 <= -40) gates.push(`Kurs 5 min ${ch5.toFixed(0)}%`);

  // ---- Noch-nicht-Bedingungen
  if (ctx.ageMin < cfg.earlyMinAgeMinutes) waits.push(`erst ${ctx.ageMin.toFixed(1)} min alt`);
  if (ctx.ageMin > cfg.earlyMaxAgeMinutes) waits.push('älter als Frühphase');
  if (liq < cfg.earlyMinLiquidityUsd) waits.push(`Liquidität $${Math.round(liq)} < $${cfg.earlyMinLiquidityUsd}`);
  if (holders < cfg.earlyMinHolders) waits.push(`${holders} Holder < ${cfg.earlyMinHolders}`);
  if (mcap > cfg.earlyMaxMarketCapUsd) waits.push(`Market Cap $${Math.round(mcap)} zu groß für Frühphase`);

  // ---- Narrativ / Nische (max 35)
  let narrative = 0;
  const kwHit = ctx.topics.find((tp) => tp.source === 'keyword' && topicMatches(tp, t.name ?? '', t.symbol ?? ''));
  if (kwHit) {
    narrative += 20;
    reasons.push(`Stichwort "${kwHit.term}"`);
  }
  const trendHit = ctx.topics.find((tp) => tp.source !== 'keyword' && tp.source !== 'dexmeta' && topicMatches(tp, t.name ?? '', t.symbol ?? ''));
  if (trendHit) {
    narrative += 10;
    reasons.push(`Trend "${trendHit.term}"`);
  }
  const niches = nichesOf(t.name ?? '', t.symbol ?? '');
  if (niches.length) {
    const best = Math.max(...niches.map((n) => ctx.nicheHeat.get(n) ?? 3));
    narrative += best;
    reasons.push(`Nische ${niches.join('/')}${best >= 12 ? ' (heiß)' : best >= 6 ? ' (steigend)' : ''}`);
  }
  narrative = Math.min(35, narrative);

  // ---- Momentum (max 35)
  const age = Math.max(ctx.ageMin, 1);
  const holdersPerMin = holders / age;
  let momentum = clamp01(holdersPerMin / 10) * 10;
  const s = t.stats5m?.numTraders ? t.stats5m : t.stats1h;
  if (s?.numTraders) momentum += clamp01(((s.numNetBuyers ?? 0) / s.numTraders - 0.2) / 0.5) * 8;
  const bv = t.stats1h?.buyVolume ?? 0;
  const sv = t.stats1h?.sellVolume ?? 0;
  if (bv + sv > 0) momentum += clamp01((bv / (bv + sv) - 0.5) / 0.25) * 7;
  if (ctx.firstMcap > 0 && mcap > 0) momentum += clamp01(Math.log2(mcap / ctx.firstMcap) / 2) * 5;
  momentum += clamp01((t.organicScore ?? 0) / 100) * 5;
  if (ctx.graduated) {
    momentum += 5;
    reasons.push('hat Bonding-Curve abgeschlossen');
  }
  momentum = Math.min(35, momentum);
  if (holdersPerMin >= 5) reasons.push(`${holdersPerMin.toFixed(1)} neue Holder/min`);

  // ---- Community (max 15)
  let community = 0;
  if (t.twitter) community += 6;
  if (t.website) community += 5;
  if (t.telegram) community += 4;
  if (community >= 11) reasons.push('Website + Socials');

  // ---- Sicherheit (max 15)
  let safety = clamp01(1 - devPct / Math.max(cfg.earlyMaxDevPct, 0.01)) * 7;
  safety += clamp01(1 - topPct / Math.max(cfg.earlyMaxTopHoldersPct, 0.01)) * 5;
  if (devMints <= 3) safety += 3;

  const total = Math.round(narrative + momentum + community + safety);
  return {
    total,
    narrative: Math.round(narrative),
    momentum: Math.round(momentum),
    community: Math.round(community),
    safety: Math.round(safety),
    gates,
    waits,
    reasons,
  };
}

// ------------------------------------------------------------ PumpPortal-Stream

export interface StreamEvent {
  mint: string;
  name?: string;
  symbol?: string;
  dev?: string;
  type: 'create' | 'migration';
}

/** Genau EINE WebSocket-Verbindung mit automatischem, gebremstem Wiederverbinden. */
export class PumpPortalStream {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffMs = 5000;
  private loggedMigration = false;

  constructor(private readonly onEvent: (e: StreamEvent) => void) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    try {
      this.ws?.close();
    } catch {
      // egal
    }
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped || this.ws) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket('wss://pumpportal.fun/api/data');
    } catch (e) {
      log.warn(`PumpPortal: Verbindung fehlgeschlagen: ${errMsg(e)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoffMs = 5000;
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      ws.send(JSON.stringify({ method: 'subscribeMigration' }));
      log.info('Frühphasen-Radar: Echtzeit-Stream neuer Pump.fun-Coins verbunden.');
    };
    ws.onmessage = (msg) => {
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(String(msg.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof d.mint !== 'string') return;
      if (d.txType === 'create') {
        this.onEvent({
          mint: d.mint,
          name: typeof d.name === 'string' ? d.name : undefined,
          symbol: typeof d.symbol === 'string' ? d.symbol : undefined,
          dev: typeof d.traderPublicKey === 'string' ? d.traderPublicKey : undefined,
          type: 'create',
        });
      } else {
        if (!this.loggedMigration) {
          log.debug(`PumpPortal Migrations-Nachricht: ${JSON.stringify(d).slice(0, 300)}`);
          this.loggedMigration = true;
        }
        this.onEvent({ mint: d.mint, type: 'migration' });
      }
    };
    ws.onerror = () => {
      // "close" folgt und kümmert sich um das Wiederverbinden.
    };
    ws.onclose = () => {
      this.ws = null;
      if (!this.stopped) {
        log.warn(`Frühphasen-Radar: Stream getrennt, neuer Versuch in ${Math.round(this.backoffMs / 1000)}s.`);
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 120_000);
    setTimeout(() => this.connect(), wait).unref();
  }
}

// ------------------------------------------------------------ Radar

interface Watched {
  mint: string;
  name: string;
  symbol: string;
  createdAt: number;
  firstSeen: number;
  graduated: boolean;
  firstMcap: number;
  maxMcap: number;
  lastMcap: number;
  last?: JupToken;
  score?: EarlyScore;
  /** Zeitpunkt der ersten vollständigen Bewertung (Start der Erfolgsmessung). */
  ratedAt?: number;
  ratedMcap?: number;
  ratedScore?: EarlyScore;
  done15?: boolean;
  done60?: boolean;
  inactive?: boolean; // nicht mehr aktiv beobachtet, nur noch Messpunkte
}

export interface EarlyCandidate {
  mint: string;
  symbol: string;
  name: string;
  score: EarlyScore;
  token: JupToken;
  ageMin: number;
}

const NICHE_REFRESH_MS = 15 * 60_000;

export class EarlyRadar {
  private readonly watch = new Map<string, Watched>();
  private readonly stream: PumpPortalStream;
  private readonly dex = new DexScreenerClient();
  private nicheHeat = new Map<string, number>();
  private nicheRefreshedAt = 0;
  private readonly csvFile: string;
  private streamCount = 0;

  constructor(
    private readonly cfg: Config,
    private readonly jup: JupiterClient,
    private readonly trends: TrendRadar | undefined,
  ) {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    this.csvFile = path.join(cfg.dataDir, 'fruehphase.csv');
    if (!fs.existsSync(this.csvFile)) {
      fs.writeFileSync(
        this.csvFile,
        'zeit_utc;typ;mint;symbol;alter_min;score;narrativ;momentum;community;sicherheit;ausschluss;mcap_usd;holder;aenderung_pct;gruende\n',
      );
    }
    this.stream = new PumpPortalStream((e) => this.onStreamEvent(e));
  }

  start(): void {
    if (this.cfg.earlyStream) this.stream.start();
  }

  stop(): void {
    this.stream.stop();
  }

  get size(): number {
    return [...this.watch.values()].filter((w) => !w.inactive).length;
  }

  private onStreamEvent(e: StreamEvent): void {
    const now = Date.now();
    const w = this.watch.get(e.mint);
    if (e.type === 'migration') {
      if (w) w.graduated = true;
      else this.add(e.mint, e.name ?? '?', e.symbol ?? '?', now, true);
      return;
    }
    this.streamCount++;
    if (!w) this.add(e.mint, e.name ?? '?', e.symbol ?? '?', now, false);
  }

  private add(mint: string, name: string, symbol: string, createdAt: number, graduated: boolean): void {
    if (this.watch.has(mint)) return;
    this.watch.set(mint, { mint, name, symbol, createdAt, firstSeen: Date.now(), graduated, firstMcap: 0, maxMcap: 0, lastMcap: 0 });
  }

  /**
   * Ein Bewertungsdurchlauf: neue Coins holen, Daten aktualisieren, bewerten,
   * Messpunkte schreiben. Gibt kaufbare Kandidaten (bester zuerst) zurück.
   */
  async evaluate(now = Date.now()): Promise<EarlyCandidate[]> {
    await this.refreshNicheHeat(now);

    try {
      for (const t of await this.jup.recentTokens()) {
        const created = t.createdAt ? Date.parse(t.createdAt) : now;
        this.add(t.id, t.name, t.symbol, Number.isFinite(created) ? created : now, !!t.graduatedAt);
      }
    } catch (e) {
      log.debug(`Jupiter "recent" nicht erreichbar: ${errMsg(e)}`);
    }

    this.prune(now);

    // Aktiv beobachtete Coins + fällige Messpunkte aktualisieren.
    const due = [...this.watch.values()].filter((w) => !w.inactive || this.measureDue(w, now));
    const fresh = new Map<string, JupToken>();
    try {
      for (const t of await this.jup.tokensByMint(due.map((w) => w.mint))) fresh.set(t.id, t);
    } catch (e) {
      log.warn(`Frühphasen-Radar: Datenabruf fehlgeschlagen: ${errMsg(e)}`);
      return [];
    }

    const topics = this.trends?.getTopics() ?? this.keywordTopics();
    const candidates: EarlyCandidate[] = [];

    for (const w of due) {
      const t = fresh.get(w.mint);
      this.writeMeasurements(w, t, now);
      if (w.inactive || !t) continue;

      w.last = t;
      w.name = t.name ?? w.name;
      w.symbol = t.symbol ?? w.symbol;
      if (t.createdAt) {
        const c = Date.parse(t.createdAt);
        if (Number.isFinite(c)) w.createdAt = c;
      }
      if (t.graduatedAt) w.graduated = true;
      const mcap = mcapOf(t);
      if (mcap > 0) {
        if (w.firstMcap === 0) w.firstMcap = mcap;
        w.maxMcap = Math.max(w.maxMcap, mcap);
        w.lastMcap = mcap;
      }
      const ageMin = (now - w.createdAt) / 60_000;
      w.score = scoreEarly(t, { ageMin, firstMcap: w.firstMcap, maxMcap: w.maxMcap, graduated: w.graduated, topics, nicheHeat: this.nicheHeat }, this.cfg);

      // Erste vollständige Bewertung nach der Mindest-Beobachtungszeit -> Messung starten.
      if (!w.ratedAt && ageMin >= this.cfg.earlyMinAgeMinutes && mcap > 0) {
        w.ratedAt = now;
        w.ratedMcap = mcap;
        w.ratedScore = w.score;
        this.csv(now, 'BEWERTUNG', w, ageMin, w.score, mcap, t.holderCount ?? 0, '');
      }

      if (w.score.gates.length === 0 && w.score.waits.length === 0 && w.score.total >= this.cfg.earlyMinScore) {
        candidates.push({ mint: w.mint, symbol: w.symbol, name: w.name, score: w.score, token: t, ageMin });
      }
    }
    candidates.sort((a, b) => b.score.total - a.score.total);
    return candidates;
  }

  /** Bester Stand für Anzeigen (z. B. "npm run fruehphase"). */
  snapshot(): { mint: string; symbol: string; name: string; ageMin: number; score?: EarlyScore; mcap: number; holders: number }[] {
    const now = Date.now();
    return [...this.watch.values()]
      .filter((w) => !w.inactive && w.score)
      .map((w) => ({
        mint: w.mint,
        symbol: w.symbol,
        name: w.name,
        ageMin: (now - w.createdAt) / 60_000,
        score: w.score,
        mcap: w.lastMcap,
        holders: w.last?.holderCount ?? 0,
      }))
      .sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0));
  }

  get streamedCount(): number {
    return this.streamCount;
  }

  private keywordTopics(): TrendTopic[] {
    return this.cfg.trendKeywords.map((k) => ({ term: k, source: 'keyword' as const, weight: 3, detail: '' }));
  }

  private measureDue(w: Watched, now: number): boolean {
    if (!w.ratedAt) return false;
    return (!w.done15 && now - w.ratedAt >= 15 * 60_000) || (!w.done60 && now - w.ratedAt >= 60 * 60_000);
  }

  private writeMeasurements(w: Watched, t: JupToken | undefined, now: number): void {
    if (!w.ratedAt || !w.ratedMcap || !w.ratedScore) return;
    for (const [mins, flag] of [
      [15, 'done15'],
      [60, 'done60'],
    ] as const) {
      if (w[flag] || now - w.ratedAt < mins * 60_000) continue;
      w[flag] = true;
      const mcap = t ? mcapOf(t) : 0;
      const change = t && mcap > 0 ? (mcap / w.ratedMcap - 1) * 100 : -100;
      this.csv(now, t ? `NACH${mins}` : `NACH${mins}_VERSCHWUNDEN`, w, (now - w.createdAt) / 60_000, w.ratedScore, mcap, t?.holderCount ?? 0, change.toFixed(1));
    }
  }

  /** Inaktive/tote Coins aus der aktiven Beobachtung nehmen; Messung läuft weiter. */
  private prune(now: number): void {
    for (const w of this.watch.values()) {
      const ageMin = (now - w.createdAt) / 60_000;
      if (w.inactive) {
        if ((w.done60 || !w.ratedAt) && now - w.firstSeen > 2 * 3_600_000) this.watch.delete(w.mint);
        continue;
      }
      const dead = ageMin >= 10 && (w.last?.holderCount ?? 0) < 15;
      const gated = (w.score?.gates.length ?? 0) > 0 && ageMin >= this.cfg.earlyMinAgeMinutes;
      if (ageMin > this.cfg.earlyMaxAgeMinutes || dead || gated) {
        w.inactive = true;
        if (!w.ratedAt) this.watch.delete(w.mint); // nie bewertet -> nichts zu messen
      }
    }
    // Obergrenze: jüngste und beste behalten.
    const active = [...this.watch.values()].filter((w) => !w.inactive);
    if (active.length > this.cfg.earlyWatchMax) {
      active
        .sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0) || b.createdAt - a.createdAt)
        .slice(this.cfg.earlyWatchMax)
        .forEach((w) => {
          w.inactive = true;
          if (!w.ratedAt) this.watch.delete(w.mint);
        });
    }
  }

  private async refreshNicheHeat(now: number): Promise<void> {
    if (now - this.nicheRefreshedAt < NICHE_REFRESH_MS) return;
    this.nicheRefreshedAt = now;
    try {
      this.nicheHeat = nicheHeatFromMetas(await this.dex.trendingMetas());
      const hot = [...this.nicheHeat.entries()].filter(([, h]) => h >= 12).map(([n]) => n);
      if (hot.length) log.info(`Frühphasen-Radar: heiße Nischen gerade: ${hot.join(', ')}`);
    } catch (e) {
      log.debug(`Nischen-Daten nicht abrufbar: ${errMsg(e)}`);
    }
  }

  private csv(now: number, typ: string, w: Watched, ageMin: number, s: EarlyScore, mcap: number, holders: number, change: string): void {
    const clean = (x: string) => x.replace(/[;\n\r]/g, ' ');
    const line = [
      new Date(now).toISOString(),
      typ,
      w.mint,
      clean(w.symbol),
      ageMin.toFixed(1),
      s.total,
      s.narrative,
      s.momentum,
      s.community,
      s.safety,
      clean(s.gates.join(' | ')),
      Math.round(mcap),
      holders,
      change,
      clean(s.reasons.join(' | ')),
    ].join(';');
    try {
      fs.appendFileSync(this.csvFile, line + '\n');
    } catch {
      // Messung ist optional.
    }
  }
}
