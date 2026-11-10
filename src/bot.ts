import fs from 'node:fs';
import { SOL_MINT, type Config } from './config.js';
import { DexScreenerClient, bestPairPerToken } from './dexscreener.js';
import { sleep } from './http.js';
import { JupiterClient, isNoRouteError, priceImpactPercent } from './jupiter.js';
import { errMsg, log } from './logger.js';
import { blockNewPositionReason, decideExit } from './risk.js';
import { RugCheckClient } from './rugcheck.js';
import { type BotState, type Position, StateStore, TradeJournal, pruneLists, rollDay } from './state.js';
import { candidateScore, marketRejections, roundtripRejections, safetyRejections, type Candidate } from './strategy.js';
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
  private lastBlockReason = '';
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
    this.trader = new Trader(cfg, this.jup, wallet, {
      getPaperBalance: () => BigInt(this.state.paperBalanceLamports),
      setPaperBalance: (v) => {
        this.state.paperBalanceLamports = v.toString();
      },
    });
  }

  stop(): void {
    this.running = false;
  }

  private save(): void {
    this.store.save(this.state);
  }

  async run(): Promise<void> {
    this.running = true;
    let nextScan = 0;
    let nextCheck = 0;
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
      this.save();
      for (let i = 0; i < 10 && this.running; i++) await sleep(100);
    }
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

  async scanAndMaybeBuy(): Promise<void> {
    if (fs.existsSync(STOP_FILE)) {
      if (!this.stopNoticeShown) log.warn(`Datei "${STOP_FILE}" gefunden: keine neuen Käufe. Bestehende Positionen werden weiter verwaltet.`);
      this.stopNoticeShown = true;
      return;
    }
    this.stopNoticeShown = false;

    const balance = await this.trader.solBalance();
    const block = blockNewPositionReason(this.state, balance, this.cfg);
    if (block) {
      if (block !== this.lastBlockReason) log.info(`Keine neuen Käufe: ${block}`);
      this.lastBlockReason = block;
      return;
    }
    this.lastBlockReason = '';

    const held = new Set(this.state.positions.map((p) => p.mint));
    const discovered = new Set([...(await this.dex.discoverSolanaTokens()), ...(await this.jup.trendingMints())]);
    const mints = [...discovered].filter(
      (m) => m !== SOL_MINT && !held.has(m) && !this.state.cooldowns[m] && !this.state.rejected[m],
    );
    if (mints.length === 0) {
      log.info('Scan: keine neuen Token.');
      return;
    }

    const best = bestPairPerToken(await this.dex.pairsForTokens(mints));
    const candidates: Candidate[] = [];
    let marketRejected = 0;
    for (const [mint, pair] of best) {
      const reasons = marketRejections(pair, this.cfg);
      if (reasons.length) {
        marketRejected++;
        this.state.rejected[mint] = Date.now() + MARKET_REJECT_MS;
        log.debug(`${pair.baseToken.symbol}: abgelehnt (Markt): ${reasons.join('; ')}`);
        continue;
      }
      candidates.push({ mint, symbol: pair.baseToken.symbol, pair, score: candidateScore(pair) });
    }
    candidates.sort((a, b) => b.score - a.score);
    log.info(`Scan: ${mints.length} Token, ${marketRejected} durch Markt-Filter, ${candidates.length} Kandidaten.`);

    const buyLamports = solToLamports(this.cfg.buyAmountSol);
    for (const c of candidates.slice(0, this.cfg.maxSafetyChecksPerScan)) {
      if (!this.running) return;
      const ok = await this.passesSafety(c, buyLamports);
      if (!ok) continue;
      await this.openPosition(c, buyLamports);
      return; // höchstens ein Kauf pro Scan
    }
  }

  private async passesSafety(c: Candidate, buyLamports: bigint): Promise<boolean> {
    let report;
    try {
      report = await this.rug.report(c.mint);
    } catch (e) {
      log.warn(`${c.symbol}: RugCheck nicht erreichbar (${errMsg(e)}) – übersprungen.`);
      return false;
    }
    const safety = safetyRejections(report, this.cfg);
    if (safety.length) {
      this.state.rejected[c.mint] = Date.now() + SAFETY_REJECT_MS;
      log.info(`${c.symbol}: abgelehnt (Sicherheit): ${safety.join('; ')}`);
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

  private async openPosition(c: Candidate, buyLamports: bigint): Promise<void> {
    const p = c.pair;
    log.info(
      `${c.symbol}: alle Prüfungen bestanden (Liq $${Math.round(p.liquidity?.usd ?? 0)}, MCap $${Math.round(p.marketCap ?? 0)}, ` +
        `Vol 1h $${Math.round(p.volume?.h1 ?? 0)}, 1h ${p.priceChange?.h1 ?? '?'}%). Kaufe für ${this.cfg.buyAmountSol} SOL ` +
        `${this.trader.live ? '(LIVE)' : '(Papier)'}…`,
    );
    let res;
    try {
      res = await this.trader.buy(c.mint, buyLamports);
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
      reason: `Score ${c.score.toFixed(2)}`,
      signature: res.signature,
    });
    log.trade(
      `KAUF ${c.symbol} für ${lamportsToSol(res.spentLamports).toFixed(4)} SOL` +
        (res.signature ? ` – https://solscan.io/tx/${res.signature}` : '') +
        ` – https://dexscreener.com/solana/${c.pair.pairAddress}`,
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

function fmtPct(ratio: number): string {
  const v = (ratio - 1) * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}
