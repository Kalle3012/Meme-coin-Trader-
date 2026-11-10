import { SOL_MINT, type Config } from './config.js';
import { JupiterClient, priceImpactPercent, type JupiterOrder } from './jupiter.js';
import { log } from './logger.js';
import { sleep } from './http.js';
import { Wallet, solToLamports } from './wallet.js';

/**
 * Führt Käufe und Verkäufe aus.
 * - Papiermodus: echte Jupiter-Kurse, aber keine Transaktion. Guthaben ist simuliert.
 * - Live-Modus: Jupiter /order -> lokal signieren -> Jupiter /execute.
 *   Die tatsächlich erhaltenen Mengen werden on-chain nachgeprüft.
 */

export interface BuyResult {
  tokenRaw: bigint;
  spentLamports: bigint;
  signature?: string;
}

export interface SellResult {
  soldRaw: bigint;
  receivedLamports: bigint;
  remainingRaw: bigint;
  signature?: string;
}

export interface Ledger {
  getPaperBalance(): bigint;
  setPaperBalance(v: bigint): void;
}

const MAX_SELL_SLIPPAGE_BPS = 2000;

export class Trader {
  constructor(
    private readonly cfg: Config,
    private readonly jup: JupiterClient,
    private readonly wallet: Wallet | undefined,
    private readonly ledger: Ledger,
  ) {}

  get live(): boolean {
    return !this.cfg.dryRun;
  }

  /** Was bekämen wir jetzt für diese Token-Menge in SOL (Jupiter-Quote, inkl. Preiseinfluss)? */
  async quoteSellValue(mint: string, tokenRaw: bigint): Promise<bigint> {
    if (tokenRaw <= 0n) return 0n;
    const q = await this.jup.order({ inputMint: mint, outputMint: SOL_MINT, amount: tokenRaw });
    return BigInt(q.outAmount);
  }

  /** Kurs-Quote für einen Kauf (ohne Ausführung). */
  async quoteBuy(mint: string, lamports: bigint): Promise<JupiterOrder> {
    return this.jup.order({ inputMint: SOL_MINT, outputMint: mint, amount: lamports, slippageBps: this.cfg.slippageBps });
  }

  async solBalance(): Promise<bigint> {
    if (!this.live) return this.ledger.getPaperBalance();
    return this.requireWallet().solBalanceLamports();
  }

  async onChainTokenBalance(mint: string): Promise<bigint> {
    return this.requireWallet().tokenBalanceRaw(mint);
  }

  async buy(mint: string, lamports: bigint): Promise<BuyResult> {
    if (!this.live) {
      const q = await this.quoteBuy(mint, lamports);
      const fee = solToLamports(this.cfg.paperFeeSol);
      const spent = lamports + fee;
      const bal = this.ledger.getPaperBalance();
      if (bal < spent) throw new Error('Papier-Guthaben reicht nicht');
      this.ledger.setPaperBalance(bal - spent);
      return { tokenRaw: BigInt(q.outAmount), spentLamports: spent };
    }

    const wallet = this.requireWallet();
    const preToken = await wallet.tokenBalanceRaw(mint);
    const preSol = await wallet.solBalanceLamports();

    const order = await this.jup.order({
      inputMint: SOL_MINT,
      outputMint: mint,
      amount: lamports,
      taker: wallet.address,
      slippageBps: this.cfg.slippageBps,
    });
    assertBuildable(order);
    const impact = priceImpactPercent(order);
    if (impact === null || impact > this.cfg.maxPriceImpactPct) {
      throw new Error(`Kauf abgebrochen: Preiseinfluss ${impact ?? 'unbekannt'}% > ${this.cfg.maxPriceImpactPct}%`);
    }

    const signed = await wallet.signBase64(order.transaction as string);
    const res = await this.jup.execute(signed, order.requestId);

    // Unabhängig von der Jupiter-Antwort: on-chain nachsehen, was wirklich angekommen ist.
    const postToken = await this.waitForTokenChange(mint, preToken, (v) => v > preToken);
    const received = postToken - preToken;

    if (res.status !== 'Success' && received <= 0n) {
      throw new Error(`Kauf fehlgeschlagen (Code ${res.code}): ${res.error ?? 'unbekannter Fehler'}`);
    }
    if (res.status !== 'Success') log.warn(`Jupiter meldete Fehler (Code ${res.code}), aber Token sind angekommen – Position wird übernommen.`);

    const postSol = await wallet.solBalanceLamports();
    const swapIn = BigInt(res.totalInputAmount ?? order.inAmount);
    const spent = plausibleDiff(preSol - postSol, swapIn) ?? swapIn;
    const tokenRaw = received > 0n ? received : BigInt(res.totalOutputAmount ?? res.outputAmountResult ?? order.outAmount);
    return { tokenRaw, spentLamports: spent, signature: res.signature };
  }

  /**
   * Verkauft `fraction` (0..1] der Position. Im Live-Modus wird die echte
   * on-chain-Menge verwendet. `attempt` erhöht bei wiederholten Fehlversuchen
   * die erlaubte Slippage, damit ein Stop-Loss im Crash nicht hängen bleibt.
   */
  async sell(mint: string, heldRaw: bigint, fraction: number, attempt = 0): Promise<SellResult> {
    const slippage = Math.min(
      MAX_SELL_SLIPPAGE_BPS,
      (this.cfg.slippageBps > 0 ? this.cfg.slippageBps : 300) * (1 + attempt),
    );

    if (!this.live) {
      const amount = portion(heldRaw, fraction);
      if (amount <= 0n) return { soldRaw: 0n, receivedLamports: 0n, remainingRaw: heldRaw };
      const q = await this.jup.order({ inputMint: mint, outputMint: SOL_MINT, amount });
      const fee = solToLamports(this.cfg.paperFeeSol);
      const out = BigInt(q.outAmount);
      const received = out > fee ? out - fee : 0n;
      this.ledger.setPaperBalance(this.ledger.getPaperBalance() + received);
      return { soldRaw: amount, receivedLamports: received, remainingRaw: heldRaw - amount };
    }

    const wallet = this.requireWallet();
    const onChain = await wallet.tokenBalanceRaw(mint);
    const amount = portion(onChain, fraction);
    if (amount <= 0n) return { soldRaw: 0n, receivedLamports: 0n, remainingRaw: onChain };
    const preSol = await wallet.solBalanceLamports();

    const order = await this.jup.order({
      inputMint: mint,
      outputMint: SOL_MINT,
      amount,
      taker: wallet.address,
      slippageBps: slippage,
    });
    assertBuildable(order);
    const signed = await wallet.signBase64(order.transaction as string);
    const res = await this.jup.execute(signed, order.requestId);

    const postToken = await this.waitForTokenChange(mint, onChain, (v) => v < onChain);
    const sold = onChain - postToken;
    if (res.status !== 'Success' && sold <= 0n) {
      throw new Error(`Verkauf fehlgeschlagen (Code ${res.code}): ${res.error ?? 'unbekannter Fehler'}`);
    }
    if (res.status !== 'Success') log.warn(`Jupiter meldete Fehler (Code ${res.code}), aber Token wurden verkauft.`);

    const postSol = await wallet.solBalanceLamports();
    const swapOut = BigInt(res.totalOutputAmount ?? res.outputAmountResult ?? order.outAmount);
    const received = plausibleDiff(postSol - preSol, swapOut) ?? swapOut;
    return { soldRaw: sold > 0n ? sold : amount, receivedLamports: received, remainingRaw: postToken, signature: res.signature };
  }

  private async waitForTokenChange(mint: string, before: bigint, done: (v: bigint) => boolean): Promise<bigint> {
    const wallet = this.requireWallet();
    let last = before;
    for (let i = 0; i < 8; i++) {
      try {
        last = await wallet.tokenBalanceRaw(mint);
        if (done(last)) return last;
      } catch (e) {
        log.debug(`Token-Saldo-Abfrage fehlgeschlagen: ${String(e)}`);
      }
      await sleep(2000);
    }
    return last;
  }

  private requireWallet(): Wallet {
    if (!this.wallet) throw new Error('Keine Wallet geladen (PRIVATE_KEY fehlt).');
    return this.wallet;
  }
}

function assertBuildable(order: JupiterOrder): void {
  if (!order.transaction) {
    throw new Error(
      `Jupiter konnte keine Transaktion bauen (errorCode ${order.errorCode ?? '?'}: ${order.errorMessage ?? order.error ?? 'unbekannt'})`,
    );
  }
}

/** Anteil einer Menge, ganzzahlig abgerundet. fraction >= 1 => alles. */
export function portion(amount: bigint, fraction: number): bigint {
  if (fraction >= 1) return amount;
  if (fraction <= 0) return 0n;
  return (amount * BigInt(Math.round(fraction * 1_000_000))) / 1_000_000n;
}

/**
 * Saldo-Differenz nur verwenden, wenn sie plausibel ist (Gebühren und
 * Kontomiete können sie um bis zu ~0,01 SOL vom reinen Swap-Betrag abweichen lassen).
 */
export function plausibleDiff(diff: bigint, reference: bigint): bigint | null {
  const tolerance = 10_000_000n; // 0,01 SOL
  if (diff <= 0n) return null;
  const delta = diff > reference ? diff - reference : reference - diff;
  return delta <= tolerance ? diff : null;
}
