/**
 * Einfacher, bewusst konservativer Backtest der Ausstiegsregeln auf Stundenkerzen.
 *
 * Annahmen (lieber zu pessimistisch als zu optimistisch):
 *  - Einstieg zum Eröffnungskurs einer Stunde.
 *  - Innerhalb einer Stunde wird ZUERST das Tief, dann das Hoch angenommen
 *    (Stops greifen also vor Gewinnmitnahmen).
 *  - Öffnet eine Stunde schon unter dem Stop, wird zum Eröffnungskurs verkauft (Kurslücke).
 *  - Kosten (Gebühren, Slippage, Spread) werden als Prozentsatz für Kauf+Verkauf abgezogen.
 * Grenzen: Stundendaten sind grob; Meme-Coins bewegen sich teils in Sekunden.
 * Ein einzelner Coin ist eine Anekdote, kein Beweis – und Coins, die man sich
 * im Nachhinein ansieht, sind meist Gewinner (Survivorship Bias).
 */

export interface Bar {
  t: number; // Sekunden (Unix)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface SimParams {
  stopLossPct: number;
  takeProfitPct: number;
  takeProfitSellFraction: number;
  trailingStopPct: number;
  trailingActivationPct: number;
  maxHoldMinutes: number;
  costPct: number; // Kauf + Verkauf zusammen
}

export interface TradeResult {
  multiple: number; // 1.2 = +20 %
  reason: string;
  exitIdx: number;
}

export function simulateTrade(bars: Bar[], entryIdx: number, p: SimParams): TradeResult {
  const half = p.costPct / 200;
  const first = bars[entryIdx];
  if (!first || first.o <= 0) return { multiple: 1, reason: 'keine Daten', exitIdx: entryIdx };
  const entry = first.o * (1 + half);
  const holdBars = Math.max(1, Math.ceil(p.maxHoldMinutes / 60));
  const sl = 1 - p.stopLossPct / 100;
  const tp = 1 + p.takeProfitPct / 100;
  const act = 1 + p.trailingActivationPct / 100;
  const trail = 1 - p.trailingStopPct / 100;

  let pos = 1;
  let realized = 0;
  let peak = 1;
  let took = false;
  const sell = (ratio: number) => pos * ratio * (1 - half);

  for (let i = entryIdx; i < bars.length; i++) {
    const b = bars[i]!;
    if (i - entryIdx >= holdBars) return { multiple: realized + sell(b.o / entry), reason: 'maximale Haltedauer', exitIdx: i };
    const rOpen = b.o / entry;
    const rLow = b.l / entry;
    const trailing = took || peak >= act;
    const trailLevel = peak * trail;
    // Stops (inkl. Kurslücke beim Öffnen)
    if (rLow <= sl || (trailing && rLow <= trailLevel)) {
      const level = trailing ? Math.max(sl, trailLevel) : sl;
      const fill = Math.min(level, rOpen);
      return { multiple: realized + sell(fill), reason: trailing && trailLevel >= sl ? 'Trailing-Stop' : 'Stop-Loss', exitIdx: i };
    }
    const rHigh = b.h / entry;
    peak = Math.max(peak, rHigh);
    if (!took && rHigh >= tp) {
      realized += pos * p.takeProfitSellFraction * tp * (1 - half);
      pos *= 1 - p.takeProfitSellFraction;
      took = true;
      if (pos <= 1e-9) return { multiple: realized, reason: 'Take-Profit', exitIdx: i };
    }
  }
  const last = bars[bars.length - 1]!;
  return { multiple: realized + sell(last.c / entry), reason: 'Ende der Daten (noch offen)', exitIdx: bars.length - 1 };
}

export interface BacktestSummary {
  trades: number;
  medianPct: number;
  meanPct: number;
  winRatePct: number;
  bestPct: number;
  worstPct: number;
}

export function summarize(results: TradeResult[]): BacktestSummary | null {
  if (!results.length) return null;
  const pct = results.map((r) => (r.multiple - 1) * 100).sort((a, b) => a - b);
  const mid = Math.floor(pct.length / 2);
  return {
    trades: pct.length,
    medianPct: pct.length % 2 ? pct[mid]! : (pct[mid - 1]! + pct[mid]!) / 2,
    meanPct: pct.reduce((s, x) => s + x, 0) / pct.length,
    winRatePct: (pct.filter((x) => x > 0).length / pct.length) * 100,
    bestPct: pct[pct.length - 1]!,
    worstPct: pct[0]!,
  };
}

/** Einstieg zu JEDER Stunde im Zeitraum – zeigt, wie stark das Ergebnis vom Zeitpunkt abhängt. */
export function backtestAllEntries(bars: Bar[], p: SimParams, fromIdx = 0, toIdx = bars.length - 1): BacktestSummary | null {
  const res: TradeResult[] = [];
  for (let i = Math.max(0, fromIdx); i <= Math.min(toIdx, bars.length - 2); i++) res.push(simulateTrade(bars, i, p));
  return summarize(res);
}

/** Größter Stundenanstieg (Schluss/Eröffnung) – meist der Auslöser (News, Trailer, Influencer). */
export function biggestHourlyJump(bars: Bar[]): { idx: number; pct: number } | null {
  let best: { idx: number; pct: number } | null = null;
  bars.forEach((b, idx) => {
    if (b.o <= 0) return;
    const pct = (b.h / b.o - 1) * 100;
    if (!best || pct > best.pct) best = { idx, pct };
  });
  return best;
}
