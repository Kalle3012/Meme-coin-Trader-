import { Bot } from './bot.js';
import { redactConfig } from './config.js';
import { sleep } from './http.js';
import { errMsg, log } from './logger.js';
import { setup } from './setup.js';
import { acquireLock } from './state.js';
import { lamportsToSol } from './wallet.js';

async function main(): Promise<void> {
  const { cfg, wallet } = await setup();
  acquireLock(cfg.dataDir);
  const bot = new Bot(cfg, wallet);

  log.info('================ Meme-Coin-Trader ================');
  log.info(`Modus: ${cfg.dryRun ? 'PAPIER (simuliert, kein echtes Geld)' : 'LIVE – ECHTES GELD'}`);
  log.debug(`Konfiguration: ${JSON.stringify(redactConfig(cfg))}`);
  log.info(
    `Kaufbetrag ${cfg.buyAmountSol} SOL | max. ${cfg.maxOpenPositions} Positionen | Stop-Loss -${cfg.stopLossPct}% | ` +
      `Take-Profit +${cfg.takeProfitPct}% (${cfg.takeProfitSellFraction * 100}%) | Trailing ${cfg.trailingStopPct}% | ` +
      `Tagesverlust-Limit ${cfg.maxDailyLossSol} SOL`,
  );

  const balance = await bot.trader.solBalance();
  log.info(`${cfg.dryRun ? 'Papier-Guthaben' : 'SOL-Guthaben'}: ${lamportsToSol(balance).toFixed(4)} SOL`);
  if (bot.state.positions.length) log.info(`${bot.state.positions.length} offene Position(en) aus dem letzten Lauf werden weiter verwaltet.`);

  if (bot.trends) {
    log.info(
      `Trend-Radar aktiv${cfg.trendOnly ? ' (NUR Trend-Token werden gekauft)' : ''}. Stichwörter: ${cfg.trendKeywords.join(', ')}`,
    );
    await bot.trends.refresh().catch((e) => log.warn(`Trend-Radar: erste Abfrage fehlgeschlagen: ${errMsg(e)}`));
  }

  if (!cfg.dryRun) {
    log.warn('LIVE-MODUS: Der Bot handelt in 15 Sekunden mit echtem Geld. Abbrechen mit Strg+C.');
    for (let i = 15; i > 0; i--) {
      process.stdout.write(`\r  Start in ${i}s … `);
      await sleep(1000);
    }
    process.stdout.write('\n');
  }

  let stopping = false;
  let firstSignalAt = 0;
  const shutdown = () => {
    if (stopping) {
      // npm/tsx leiten Strg+C teils doppelt weiter – nur ein bewusstes zweites Strg+C zählt.
      if (Date.now() - firstSignalAt < 2000) return;
      log.warn('Sofortiges Beenden.');
      process.exit(1);
    }
    stopping = true;
    firstSignalAt = Date.now();
    log.info('Beende nach dem aktuellen Schritt … (nochmal Strg+C = sofort)');
    bot.stop();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await bot.run();

  if (bot.state.positions.length) {
    log.warn(
      `Bot beendet. ${bot.state.positions.length} Position(en) sind NOCH OFFEN und werden nicht mehr überwacht! ` +
        'Bot neu starten oder "npm run sell-all" ausführen.',
    );
  } else {
    log.info('Bot beendet. Keine offenen Positionen.');
  }
}

main().catch((e) => {
  log.error(`Unerwarteter Fehler: ${errMsg(e)}`);
  process.exit(1);
});
