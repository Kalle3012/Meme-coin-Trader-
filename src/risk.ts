import type { Config } from './config.js';
import type { BotState, Position } from './state.js';
import { solToLamports } from './wallet.js';

/**
 * Risiko-Management: Wann darf eine neue Position eröffnet werden,
 * und wann muss eine bestehende verkauft werden?
 */

/** Gibt einen Grund zurück, warum KEINE neue Position eröffnet werden darf, sonst null. */
export function blockNewPositionReason(state: BotState, solBalanceLamports: bigint, cfg: Config): string | null {
  if (state.positions.length >= cfg.maxOpenPositions) return `maximale Anzahl offener Positionen (${cfg.maxOpenPositions}) erreicht`;
  if (state.day.buys >= cfg.maxTradesPerDay) return `Tageslimit von ${cfg.maxTradesPerDay} Käufen erreicht`;
  const dayPnl = BigInt(state.day.realizedPnlLamports);
  if (dayPnl <= -solToLamports(cfg.maxDailyLossSol)) {
    return `Tagesverlust-Limit (${cfg.maxDailyLossSol} SOL) erreicht – keine neuen Käufe bis morgen`;
  }
  // Nach dem Kauf muss noch die Reserve (für Gebühren, Kontomiete, Verkäufe) übrig sein.
  const needed = solToLamports(cfg.buyAmountSol + cfg.minSolReserve);
  if (solBalanceLamports < needed) {
    return `zu wenig SOL (${(Number(solBalanceLamports) / 1e9).toFixed(4)} SOL, benötigt ${(cfg.buyAmountSol + cfg.minSolReserve).toFixed(4)} inkl. Reserve)`;
  }
  return null;
}

export type ExitDecision =
  | { action: 'hold'; ratio: number; peakRatio: number }
  | { action: 'sell'; fraction: number; reason: string; ratio: number; peakRatio: number };

/**
 * Kurs im Verhältnis zum Einstiegskurs:
 * (aktueller Wert pro Token) / (Einstiegskosten pro Token).
 */
export function priceRatio(pos: Position, currentValueLamports: bigint): number {
  const held = Number(BigInt(pos.tokenRaw));
  const initial = Number(BigInt(pos.initialTokenRaw));
  const entry = Number(BigInt(pos.entryLamports));
  if (held <= 0 || initial <= 0 || entry <= 0) return 0;
  return (Number(currentValueLamports) / held) / (entry / initial);
}

export function decideExit(pos: Position, currentValueLamports: bigint, cfg: Config, now = Date.now()): ExitDecision {
  const ratio = priceRatio(pos, currentValueLamports);
  const peakRatio = Math.max(pos.peakRatio, ratio);
  const sell = (fraction: number, reason: string): ExitDecision => ({ action: 'sell', fraction, reason, ratio, peakRatio });

  // 1. Stop-Loss
  if (ratio <= 1 - cfg.stopLossPct / 100) return sell(1, `Stop-Loss (${pct(ratio)})`);

  // 2. Trailing-Stop (aktiv nach Teilgewinnmitnahme oder ab Aktivierungsschwelle)
  const trailingActive = pos.tookProfit || peakRatio >= 1 + cfg.trailingActivationPct / 100;
  if (trailingActive && ratio <= peakRatio * (1 - cfg.trailingStopPct / 100)) {
    return sell(1, `Trailing-Stop (Hoch ${pct(peakRatio)}, jetzt ${pct(ratio)})`);
  }

  // 3. Take-Profit (einmalig, Teilverkauf)
  if (!pos.tookProfit && ratio >= 1 + cfg.takeProfitPct / 100) {
    return sell(cfg.takeProfitSellFraction, `Take-Profit (${pct(ratio)})`);
  }

  // 4. Maximale Haltedauer
  if (now - pos.openedAt >= cfg.maxHoldMinutes * 60_000) return sell(1, `maximale Haltedauer erreicht (${pct(ratio)})`);

  return { action: 'hold', ratio, peakRatio };
}

function pct(ratio: number): string {
  const v = (ratio - 1) * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}
