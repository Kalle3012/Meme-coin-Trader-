import { Bot } from '../bot.js';
import { setup } from '../setup.js';
import { lamportsToSol } from '../wallet.js';
import { priceRatio } from '../risk.js';

/** Zeigt Guthaben, offene Positionen und Statistik. Handelt NICHT. */
async function main(): Promise<void> {
  const { cfg, wallet } = await setup();
  const bot = new Bot(cfg, wallet);
  const s = bot.state;
  console.log(`\nModus: ${s.mode === 'paper' ? 'Papier' : 'LIVE'}`);
  console.log(`Guthaben: ${lamportsToSol(await bot.trader.solBalance()).toFixed(4)} SOL`);
  console.log(`Heute (${s.day.date}): ${s.day.buys} Käufe, Ergebnis ${lamportsToSol(BigInt(s.day.realizedPnlLamports)).toFixed(4)} SOL`);
  console.log(
    `Gesamt: ${s.closedTrades} abgeschlossene Trades, ${s.wins} Gewinner, Ergebnis ${lamportsToSol(BigInt(s.totalRealizedPnlLamports)).toFixed(4)} SOL`,
  );
  console.log(`\nOffene Positionen: ${s.positions.length}`);
  for (const p of s.positions) {
    let line = `- ${p.symbol} (${p.mint}) seit ${new Date(p.openedAt).toLocaleString('de-DE')}, Einsatz ${lamportsToSol(BigInt(p.entryLamports)).toFixed(4)} SOL`;
    try {
      const v = await bot.trader.quoteSellValue(p.mint, BigInt(p.tokenRaw));
      const r = priceRatio(p, v);
      line += `, aktueller Wert ${lamportsToSol(v).toFixed(4)} SOL (${((r - 1) * 100).toFixed(1)}%)`;
    } catch {
      line += ', aktueller Wert: nicht abrufbar';
    }
    console.log(line);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
