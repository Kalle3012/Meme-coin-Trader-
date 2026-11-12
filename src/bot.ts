import fs from 'node:fs';
import { SOL_MINT, type Config } from './config.js';
import { DexScreenerClient, bestPairPerToken } from './dexscreener.js';
import { sleep } from './http.js';
import { JupiterClient, isNoRouteError, priceImpactPercent } from './jupiter.js';
import { errMsg, log } from './logger.js';
import { EarlyRadar, type EarlyCandidate } from './early.js';
import { blockNewPositionReason, decideExit, profileParams, type Profile } from './risk.js';
import { RugCheckClient } from './rugcheck.js';
import { type BotState, type Position, StateStore, TradeJournal, pruneLists, rollDay } from './state.js';
import { compareCandidates, isIncompleteReport, marketRejections, rankedScore, roundtripRejections, safetyRejections, type Candidate } from './strategy.js';
import { TrendRadar, type TrendHit } from './trends.js';
import { Trader } from './trader.js';
import { Wallet, lamportsToSol, solToLamports } from './wallet.js';

const STOP_FILE = 'STOP';
const MARKET_REJECT_MS = 15 * 60_000;
const SAFETY_REJECT_MS = 6 * 60 * 60_000;
const ROUNDTRIP_REJECT_MS = 60 * 60_000;
const DUST_LAMPORTS = 100_000n; // < 0,0001 SOL Restwert gilt als geschlossen
const MAX_QUOTE_FAILURES = 40;

export class Bot {
  private running = false;
  private readonly store: StateStore;
  private readonly journal: TradeJournal;
  readonly state: BotState;
  readonly trader: Trader;
  private readonly dex = new DexScreenerClient();
  private readonly rug = new RugCheckClient();
  private readonly jup: JupiterClient;
  readonly trends: TrendRadar | undefined;
  readonly early: EarlyRadar | undefined;
  private lastBlockReason = '';
  private lastEarlyBlockReason = '';
  private stopNoticeShown = false;

  constructor(
    private readonly cfg: Config,
    private readonly wallet: Wallet | undefined,
  ) {
    const mode = cfg.dryRun ? 'paper' : 'live';
    this.store = new StateStore(cfg.dataDir, mode);
    this.journal = new TradeJournal(cfg.dataDir);
    this.state = this.store.load(mode, solToLamports(cfg.paperStartSol));
    rollDay(this.state);
    if (mode === 'live' && wallet) {
      const saved = this.state.walletAddress;
      if (saved && saved !== wallet.address && this.state.positions.length > 0) {
        throw new Error(`Die gespeicherten Live-Positionen gehören zur Wallet ${saved}, geladen ist aber ${wallet.address}. Abbruch.`);
      }
      this.state.walletAddress = wallet.address;
    }
    this.jup = new JupiterClient(cfg.jupiterApiKey, cfg.jupiterRps);
    this.trends = cfg.trendEnabled ? new TrendRadar(cfg) : undefined;
    this.early = cfg.earlyEnabled ? new EarlyRadar(cfg, this.jup, this.trends) : undefined;
    this.trader = new Trader(cfg, this.jup, wallet, {
      getPaperBalance: () => BigInt(this.state.paperBalanceLamports),
      setPaperBalance: (v) => {
        this.state.paperBalanceLamports = v.toString();
      },
    });
  }

  stop(): void {
    this.running = false;
    this.early?.stop();
  }

  private save(): void {
    this.store.save(this.state);
  }

  async run(): Promise<void> {
    this.running = true;
    let nextScan = 0;
    let nextCheck = 0;
    let nextEarly = Date.now() + 20_000; // Stream erst ein paar Coins sammeln lassen
    this.early?.start();
    while (this.running) {
      const now = Date.now();
      if (rollDay(this.state, now)) log.info(`Neuer Tag ${this.state.day.date}: Tageszähler zurückgesetzt.`);
      pruneLists(this.state, now);

      if (now >= nextCheck) {
        await this.safe('Positionsprüfung', () => this.managePositions());
        nextCheck = Date.now() + this.cfg.positionCheckIntervalSec * 1000;
      }
      if (this.running && now >= nextScan) {
        await this.safe('Markt-Scan', () => this.scanAndMaybeBuy());
        nextScan = Date.now() + this.cfg.scanIntervalSec * 1000;
      }
      if (this.early && this.running && Date.now() >= nextEarly) {
        await this.safe('Frühphasen-Radar', () => this.earlyTick());
        nextEarly = Date.now() + this.cfg.earlyEvalIntervalSec * 1000;
      }
      this.save();
      for (let i = 0; i < 10 && this.running; i++) await sleep(100);
    }
    this.early?.stop();
    this.save();
  }

  private async safe(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      log.error(`${what} fehlgeschlagen: ${errMsg(e)}`);
    }
  }

  // ---------------------------------------------------------------- Positionen

  async managePositions(): Promise<void> {
    for (const pos of [...this.state.positions]) {
      try {
        await this.checkPosition(pos);
      } catch (e) {
        log.error(`${pos.symbol}: Prüfung fehlgeschlagen: ${errMsg(e)}`);
      }
      this.save();
    }
  }

  private async checkPosition(pos: Position): Promise<void> {
    if (this.trader.live) {
      // Falls der Nutzer in Phantom selbst verkauft/gekauft hat, echte Menge übernehmen.
      const onChain = await this.trader.onChainTokenBalance(pos.mint);
      if (onChain === 0n) {
        log.warn(`${pos.symbol}: keine Token mehr in der Wallet (manuell verkauft?). Position wird geschlossen.`);
        this.closePosition(pos, 0n, 'extern geschlossen');
        return;
      }
      if (onChain !== BigInt(pos.tokenRaw)) pos.tokenRaw = onChain.toString();
    }

    const held = BigInt(pos.tokenRaw);
    let value: bigint;
    try {
      value = await this.trader.quoteSellValue(pos.mint, held);
      pos.quoteFailures = 0;
    } catch (e) {
      if (!isNoRouteError(e)) {
        log.warn(`${pos.symbol}: Kursabfrage vorübergehend fehlgeschlagen: ${errMsg(e)}`);
        return;
      }
      pos.quoteFailures = (pos.quoteFailures ?? 0) + 1;
      log.warn(`${pos.symbol}: keine Verkaufsroute (${pos.quoteFailures}/${MAX_QUOTE_FAILURES}): ${errMsg(e)}`);
      if (pos.quoteFailures >= MAX_QUOTE_FAILURES) {
        log.error(`${pos.symbol}: seit ${MAX_QUOTE_FAILURES} Prüfungen nicht verkaufbar (Rug/Liquidität entfernt?). Position wird als Totalverlust abgeschrieben; Token bleiben in der Wallet.`);
        this.closePosition(pos, 0n, 'abgeschrieben (nicht verkaufbar)');
      }
      return;
    }
    const d = decideExit(pos, value, this.cfg);
    pos.peakRatio = d.peakRatio;
    pos.lastRatio = d.ratio;
    log.info(`${pos.symbol}: Wert ${lamportsToSol(value).toFixed(4)} SOL, ${fmtPct(d.ratio)} (Hoch ${fmtPct(d.peakRatio)})`);
    if (d.action === 'hold') return;

    await this.executeSell(pos, d.fraction, d.reason);
  }

  async executeSell(pos: Position, fraction: number, reason: string): Promise<void> {
    const held = BigInt(pos.tokenRaw);
    let res;
    try {
      res = await this.trader.sell(pos.mint, held, fraction, pos.sellFailures ?? 0);
    } catch (e) {
      pos.sellFailures = (pos.sellFailures ?? 0) + 1;
      log.error(`${pos.symbol}: Verkauf (${reason}) fehlgeschlagen, Versuch ${pos.sellFailures}: ${errMsg(e)}`);
      return;
    }
    pos.sellFailures = 0;
    if (res.soldRaw <= 0n) return;

    pos.realizedLamports = (BigInt(pos.realizedLamports) + res.receivedLamports).toString();
    pos.tokenRaw = res.remainingRaw.toString();
    const partial = fraction < 1;
    log.trade(
      `${partial ? 'TEILVERKAUF' : 'VERKAUF'} ${pos.symbol}: ${lamportsToSol(res.receivedLamports).toFixed(4)} SOL erhalten – ${reason}` +
        (res.signature ? ` – https://solscan.io/tx/${res.signature}` : ''),
    );

    let remainingValue = 0n;
    if (res.remainingRaw > 0n) {
      try {
        remainingValue = await this.trader.quoteSellValue(pos.mint, res.remainingRaw);
      } catch {
        remainingValue = DUST_LAMPORTS + 1n; // im Zweifel offen lassen
      }
    }

    if (remainingValue > DUST_LAMPORTS) {
      // Position bleibt (teilweise) offen.
      if (partial) pos.tookProfit = true;
      else log.warn(`${pos.symbol}: Verkauf nur teilweise ausgeführt, Rest wird beim nächsten Durchlauf erneut verkauft.`);
      this.journal.record({
        mode: this.state.mode,
        action: 'TEILVERKAUF',
        symbol: pos.symbol,
        mint: pos.mint,
        sol: lamportsToSol(res.receivedLamports),
        tokenRaw: res.soldRaw.toString(),
        reason,
        signature: res.signature,
      });
      return;
    }
    this.closePosition(pos, res.receivedLamports, reason, res.soldRaw, res.signature);
  }

  private closePosition(pos: Position, lastReceived: bigint, reason: string, soldRaw = 0n, signature?: string): void {
    const pnl = BigInt(pos.realizedLamports) - BigInt(pos.entryLamports);
    this.state.positions = this.state.positions.filter((p) => p.mint !== pos.mint);
    this.state.day.realizedPnlLamports = (BigInt(this.state.day.realizedPnlLamports) + pnl).toString();
    this.state.totalRealizedPnlLamports = (BigInt(this.state.totalRealizedPnlLamports) + pnl).toString();
    this.state.closedTrades += 1;
    if (pnl > 0n) this.state.wins += 1;
    this.state.cooldowns[pos.mint] = Date.now() + this.cfg.rebuyCooldownHours * 3_600_000;
    this.journal.record({
      mode: this.state.mode,
      action: 'VERKAUF',
      symbol: pos.symbol,
      mint: pos.mint,
      sol: lamportsToSol(lastReceived),
      tokenRaw: soldRaw.toString(),
      pnlSol: lamportsToSol(pnl),
      reason,
      signature,
    });
    log.trade(
      `Position ${pos.symbol} geschlossen: Ergebnis ${lamportsToSol(pnl) >= 0 ? '+' : ''}${lamportsToSol(pnl).toFixed(4)} SOL ` +
        `| heute ${lamportsToSol(BigInt(this.state.day.realizedPnlLamports)).toFixed(4)} SOL ` +
        `| gesamt ${lamportsToSol(BigInt(this.state.totalRealizedPnlLamports)).toFixed(4)} SOL ` +
        `(${this.state.wins}/${this.state.closedTrades} Gewinner)`,
    );
    this.save();
  }

  // ---------------------------------------------------------------- Scan & Kauf

  private buyingPaused(): boolean {
    if (fs.existsSync(STOP_FILE)) {
      if (!this.stopNoticeShown) log.warn(`Datei "${STOP_FILE}" gefunden: keine neuen Käufe. Bestehende Positionen werden weiter verwaltet.`);
      this.stopNoticeShown = true;
      return true;
    }
    this.stopNoticeShown = false;
    return false;
  }

  async scanAndMaybeBuy(): Promise<void> {
    if (this.buyingPaused()) return;

    const balance = await this.trader.solBalance();
    const block = blockNewPositionReason(this.state, balance, this.cfg);
    if (block) {
      if (block !== this.lastBlockReason) log.info(`Keine neuen Käufe: ${block}`);
      this.lastBlockReason = block;
      return;
    }
    this.lastBlockReason = '';

    const held = new Set(this.state.positions.map((p) => p.mint));
    const trendHits: Map<string, TrendHit> = this.trends?.current() ?? new Map();
    const discovered = new Set<string>(trendHits.keys());
    if (!this.cfg.trendOnly) {
      for (const m of await this.dex.discoverSolanaTokens()) discovered.add(m);
      for (const m of await this.jup.trendingMints()) discovered.add(m);
    }
    const mints = [...discovered].filter(
      (m) => m !== SOL_MINT && !held.has(m) && !this.state.cooldowns[m] && !this.state.rejected[m],
    );
    if (mints.length === 0) {
      log.info(this.cfg.trendOnly && trendHits.size === 0 ? 'Scan: Trend-Radar hat (noch) keine passenden Token.' : 'Scan: keine neuen Token.');
      return;
    }

    const best = bestPairPerToken(await this.dex.pairsForTokens(mints));
    const candidates: Candidate[] = [];
    let marketRejected = 0;
    for (const [mint, pair] of best) {
      const hit = trendHits.get(mint);
      const reasons = marketRejections(pair, this.cfg, Date.now(), !!hit);
      if (reasons.length) {
        marketRejected++;
        this.state.rejected[mint] = Date.now() + MARKET_REJECT_MS;
        const line = `TREND ${pair.baseToken.symbol} (${mint.slice(0, 6)}…, ${hit?.reasons[0]}): abgelehnt (Markt): ${reasons.join('; ')}`;
        // Eigene Stichwörter (z. B. GTA 6) immer zeigen, allgemeine Trends nur mit DEBUG=true.
        if (hit && hit.reasons.some((r) => r.startsWith('Stichwort'))) log.info(line);
        else if (hit) log.debug(line);
        else log.debug(`${pair.baseToken.symbol}: abgelehnt (Markt): ${reasons.join('; ')}`);
        continue;
      }
      candidates.push({
        mint,
        symbol: pair.baseToken.symbol,
        pair,
        score: rankedScore(pair, hit?.score ?? 0),
        trend: hit ? { score: hit.score, reasons: hit.reasons } : undefined,
      });
    }
    candidates.sort(compareCandidates);
    const trendCount = candidates.filter((c) => c.trend).length;
    log.info(
      `Scan: ${mints.length} Token, ${marketRejected} durch Markt-Filter, ${candidates.length} Kandidaten` +
        (this.trends ? ` (davon ${trendCount} mit Trend-Bezug).` : '.'),
    );

    const buyLamports = solToLamports(this.cfg.buyAmountSol);
    for (const c of candidates.slice(0, this.cfg.maxSafetyChecksPerScan)) {
      if (!this.running) return;
      const ok = await this.passesSafety(c.mint, c.symbol, buyLamports, 'normal');
      if (!ok) continue;
      const p = c.pair;
      await this.openPosition({
        mint: c.mint,
        symbol: c.symbol,
        profile: 'normal',
        buyLamports,
        summary:
          `Liq $${Math.round(p.liquidity?.usd ?? 0)}, MCap $${Math.round(p.marketCap ?? 0)}, ` +
          `Vol 1h $${Math.round(p.volume?.h1 ?? 0)}, 1h ${p.priceChange?.h1 ?? '?'}%`,
        details: c.trend ? `Trend-Bezug: ${c.trend.reasons.join(' | ')}` : undefined,
        journalReason: `Score ${c.score.toFixed(2)}` + (c.trend ? ` – Trend: ${c.trend.reasons.join(' | ')}` : ''),
        link: `https://dexscreener.com/solana/${p.pairAddress}`,
      });
      return; // höchstens ein Kauf pro Scan
    }
  }

  // ---------------------------------------------------------------- Frühphase

  async earlyTick(): Promise<void> {
    if (!this.early) return;
    const candidates = await this.early.evaluate();
    const top = this.early.snapshot()[0];
    log.info(
      `Frühphase: ${this.early.size} neue Coins unter Beobachtung (${this.early.streamedCount} per Echtzeit-Stream), ` +
        `${candidates.length} über Score ${this.cfg.earlyMinScore}` +
        (top?.score ? ` – bester: ${top.symbol} ${top.score.total}/100` : '') +
        '.',
    );
    if (candidates.length === 0 || this.buyingPaused()) return;

    const balance = await this.trader.solBalance();
    const block = blockNewPositionReason(this.state, balance, this.cfg, 'early');
    if (block) {
      if (block !== this.lastEarlyBlockReason) log.info(`Frühphase – keine neuen Käufe: ${block}`);
      this.lastEarlyBlockReason = block;
      return;
    }
    this.lastEarlyBlockReason = '';

    const held = new Set(this.state.positions.map((p) => p.mint));
    const buyLamports = solToLamports(this.cfg.earlyBuyAmountSol);
    for (const c of candidates.slice(0, 2)) {
      if (!this.running) return;
      if (held.has(c.mint) || this.state.cooldowns[c.mint] || this.state.rejected[c.mint]) continue;
      log.info(`FRÜHPHASE ${c.symbol} (${c.mint.slice(0, 6)}…): Score ${fmtScore(c)} – ${c.score.reasons.join(', ') || 'keine Besonderheiten'}`);
      const ok = await this.passesSafety(c.mint, c.symbol, buyLamports, 'early');
      if (!ok) continue;
      await this.openPosition({
        mint: c.mint,
        symbol: c.symbol,
        profile: 'early',
        buyLamports,
        summary:
          `Alter ${c.ageMin.toFixed(0)} min, MCap $${Math.round(c.token.mcap ?? 0)}, Liq $${Math.round(c.token.liquidity ?? 0)}, ` +
          `${c.token.holderCount ?? 0} Holder, Potenzial-Score ${c.score.total}/100`,
        details: c.score.reasons.length ? `Gründe: ${c.score.reasons.join(' | ')}` : undefined,
        journalReason: `Frühphase Score ${fmtScore(c)}` + (c.score.reasons.length ? ` – ${c.score.reasons.join(' | ')}` : ''),
        link: `https://dexscreener.com/solana/${c.mint}`,
      });
      return; // höchstens ein Frühphasen-Kauf pro Durchlauf
    }
  }

  private async passesSafety(mint: string, symbol: string, buyLamports: bigint, profile: Profile): Promise<boolean> {
    const c = { mint, symbol };
    // Frühphase: neue Coins haben naturgemäß weniger Holder – alle anderen Prüfungen bleiben gleich.
    const safetyCfg = profile === 'early' ? { ...this.cfg, minHolders: this.cfg.earlyMinHolders } : this.cfg;
    let report;
    try {
      report = await this.rug.report(c.mint);
    } catch (e) {
      log.warn(`${c.symbol}: RugCheck nicht erreichbar (${errMsg(e)}) – übersprungen.`);
      return false;
    }
    if (isIncompleteReport(report)) {
      // RugCheck liefert gelegentlich Teilberichte – nicht kaufen, aber bald erneut prüfen.
      this.state.rejected[c.mint] = Date.now() + MARKET_REJECT_MS;
      log.info(`${c.symbol} (${c.mint.slice(0, 6)}…): RugCheck-Bericht unvollständig – nicht gekauft, erneute Prüfung in 15 min.`);
      return false;
    }
    const safety = safetyRejections(report, safetyCfg);
    if (safety.length) {
      this.state.rejected[c.mint] = Date.now() + SAFETY_REJECT_MS;
      log.info(`${c.symbol} (${c.mint.slice(0, 6)}…): abgelehnt (Sicherheit): ${safety.join('; ')}`);
      return false;
    }

    try {
      const buyQ = await this.trader.quoteBuy(c.mint, buyLamports);
      const sellOut = await this.trader.quoteSellValue(c.mint, BigInt(buyQ.outAmount));
      const rt = roundtripRejections(buyLamports, sellOut, priceImpactPercent(buyQ), this.cfg);
      if (rt.length) {
        this.state.rejected[c.mint] = Date.now() + ROUNDTRIP_REJECT_MS;
        log.info(`${c.symbol}: abgelehnt (Handelbarkeit): ${rt.join('; ')}`);
        return false;
      }
    } catch (e) {
      this.state.rejected[c.mint] = Date.now() + ROUNDTRIP_REJECT_MS;
      log.info(`${c.symbol}: abgelehnt (keine Jupiter-Route): ${errMsg(e)}`);
      return false;
    }
    return true;
  }

  private async openPosition(c: {
    mint: string;
    symbol: string;
    profile: Profile;
    buyLamports: bigint;
    summary: string;
    details?: string;
    journalReason: string;
    link: string;
  }): Promise<void> {
    const amountSol = profileParams(this.cfg, c.profile).buyAmountSol;
    log.info(
      `${c.symbol}: alle Prüfungen bestanden (${c.summary}). Kaufe für ${amountSol} SOL ` +
        `${c.profile === 'early' ? '[Frühphase] ' : ''}${this.trader.live ? '(LIVE)' : '(Papier)'}…`,
    );
    if (c.details) log.info(`${c.symbol}: ${c.details}`);
    let res;
    try {
      res = await this.trader.buy(c.mint, c.buyLamports);
    } catch (e) {
      log.error(`${c.symbol}: Kauf fehlgeschlagen: ${errMsg(e)}`);
      this.state.cooldowns[c.mint] = Date.now() + 30 * 60_000;
      return;
    }
    if (res.tokenRaw <= 0n) {
      log.error(`${c.symbol}: Kauf ergab 0 Token.`);
      return;
    }
    const pos: Position = {
      mint: c.mint,
      symbol: c.symbol,
      openedAt: Date.now(),
      entryLamports: res.spentLamports.toString(),
      initialTokenRaw: res.tokenRaw.toString(),
      tokenRaw: res.tokenRaw.toString(),
      realizedLamports: '0',
      peakRatio: 1,
      tookProfit: false,
      buySignature: res.signature,
      profile: c.profile,
    };
    this.state.positions.push(pos);
    this.state.day.buys += 1;
    this.journal.record({
      mode: this.state.mode,
      action: 'KAUF',
      symbol: c.symbol,
      mint: c.mint,
      sol: lamportsToSol(res.spentLamports),
      tokenRaw: res.tokenRaw.toString(),
      reason: c.journalReason,
      signature: res.signature,
    });
    log.trade(
      `KAUF ${c.symbol} für ${lamportsToSol(res.spentLamports).toFixed(4)} SOL` +
        (res.signature ? ` – https://solscan.io/tx/${res.signature}` : '') +
        ` – ${c.link}`,
    );
    this.save();
  }

  /** Alle Positionen verkaufen (für "npm run sell-all"). */
  async sellAll(): Promise<void> {
    this.running = true;
    for (const pos of [...this.state.positions]) {
      for (let attempt = 0; attempt < 4 && this.state.positions.some((p) => p.mint === pos.mint); attempt++) {
        await this.executeSell(pos, 1, 'manueller Notverkauf (sell-all)');
        this.save();
      }
    }
  }
}

function fmtScore(c: EarlyCandidate): string {
  const s = c.score;
  return `${s.total}/100 (Narrativ ${s.narrative}, Momentum ${s.momentum}, Community ${s.community}, Sicherheit ${s.safety})`;
}

function fmtPct(ratio: number): string {
  const v = (ratio - 1) * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}
