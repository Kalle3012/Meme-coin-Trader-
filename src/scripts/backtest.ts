import { backtestAllEntries, biggestHourlyJump, simulateTrade, type Bar, type SimParams } from '../backtest.js';
import { ConfigError, loadConfig } from '../config.js';
import { DexScreenerClient, bestPairPerToken } from '../dexscreener.js';
import { requestJson } from '../http.js';
import { profileParams } from '../risk.js';

/**
 * Was hätten die Regeln des Bots mit einem bestimmten Coin gemacht?
 * Aufruf: npm run backtest -- <Coin-Adresse>
 * Datenquelle: GeckoTerminal (kostenlos, Stundenkerzen der letzten ~40 Tage).
 */

const COST_PCT = 3; // Gebühren + Slippage + Spread für Kauf und Verkauf zusammen (vorsichtig geschätzt)

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(e instanceof ConfigError ? `Konfigurationsfehler: ${e.message}` : e);
    process.exit(1);
  }
  const mint = (process.argv[2] ?? '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    console.log('Bitte die Coin-Adresse (Mint) angeben, z. B.:  npm run backtest -- nxPqZ4F7ux8Vph5NFu25rEP6Kx9Gr1U6Fmj36Rjpump');
    console.log('Die Adresse findest du auf DexScreener oder in Phantom beim Coin ("Adresse kopieren").');
    process.exit(1);
  }

  const pair = bestPairPerToken(await new DexScreenerClient().pairsForTokens([mint])).get(mint);
  if (!pair) {
    console.log('Zu dieser Adresse wurde auf Solana kein Handelspaar gefunden.');
    process.exit(1);
  }
  console.log(`\n${pair.baseToken.symbol} – ${pair.baseToken.name}  (Pool ${pair.pairAddress}, ${pair.dexId})`);

  const res = await requestJson<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pair.pairAddress}/ohlcv/hour?limit=1000`,
    { timeoutMs: 30_000 },
  );
  const bars: Bar[] = (res.data?.attributes?.ohlcv_list ?? [])
    .map(([t, o, h, l, c, v]) => ({ t: t!, o: o!, h: h!, l: l!, c: c!, v: v ?? 0 }))
    .filter((b) => b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0)
    .sort((a, b) => a.t - b.t);
  if (bars.length < 24) {
    console.log('Zu wenig Kursdaten (weniger als 24 Stunden).');
    return;
  }
  const d = (i: number) => new Date(bars[i]!.t * 1000).toLocaleString('de-DE', { timeZone: 'UTC' }) + ' UTC';
  const last = bars[bars.length - 1]!;
  const peakIdx = bars.reduce((m, b, i) => (b.h > bars[m]!.h ? i : m), 0);
  console.log(`Daten: ${bars.length} Stunden, ${d(0)} bis ${d(bars.length - 1)}`);
  console.log(`Kurs: Start ${bars[0]!.o.toPrecision(3)} $, Hoch ${bars[peakIdx]!.h.toPrecision(3)} $ (${d(peakIdx)}), jetzt ${last.c.toPrecision(3)} $`);
  console.log(`Vom Hoch bis jetzt: ${((last.c / bars[peakIdx]!.h - 1) * 100).toFixed(0)} %`);
  const jump = biggestHourlyJump(bars);
  if (jump) {
    const after = bars[Math.min(jump.idx + 24, bars.length - 1)]!;
    console.log(
      `Größter Sprung in einer Stunde: +${jump.pct.toFixed(0)} % am ${d(jump.idx)}. ` +
        `24 h später stand der Kurs ${((after.c / bars[jump.idx]!.h - 1) * 100).toFixed(0)} % unter dem damaligen Hoch.`,
    );
  }

  const fmt = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(0)} %`;
  console.log(`\nWas wäre bei einem Einstieg zu JEDER Stunde passiert? (Kosten ${COST_PCT} % pro Trade, vorsichtige Annahmen)\n`);
  for (const [label, profile] of [
    ['Normale Regeln', 'normal'],
    ['Frühphasen-Regeln', 'early'],
  ] as const) {
    const pp = profileParams(cfg, profile);
    const p: SimParams = { ...pp, costPct: COST_PCT };
    const s = backtestAllEntries(bars, p);
    if (!s) continue;
    console.log(
      `${label} (Stop −${pp.stopLossPct} %, Take-Profit +${pp.takeProfitPct} %, Trailing ${pp.trailingStopPct} %, max ${pp.maxHoldMinutes} min):`,
    );
    console.log(
      `   ${s.trades} Einstiege – Median ${fmt(s.medianPct)}, Durchschnitt ${fmt(s.meanPct)}, ` +
        `Gewinn-Trades ${s.winRatePct.toFixed(0)} %, bester ${fmt(s.bestPct)}, schlechtester ${fmt(s.worstPct)}`,
    );
    if (jump && jump.idx + 1 < bars.length) {
      const r = simulateTrade(bars, jump.idx + 1, p);
      console.log(`   Einstieg direkt nach dem größten Sprung (${d(jump.idx + 1)}): ${fmt((r.multiple - 1) * 100)} (${r.reason})`);
    }
  }
  console.log(`\nKaufen & halten ab Datenbeginn: ${fmt((last.c / bars[0]!.o - 1) * 100)}; ab dem Hoch: ${fmt((last.c / bars[peakIdx]!.h - 1) * 100)}`);
  console.log('\nHinweis: Ein einzelner Coin ist eine Anekdote. Coins, die man im Nachhinein auswählt, sind meist Gewinner;');
  console.log('die vielen Kopien und Rug-Pulls desselben Trends fehlen in diesem Test.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
