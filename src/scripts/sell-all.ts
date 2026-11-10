import { Bot } from '../bot.js';
import { log } from '../logger.js';
import { setup } from '../setup.js';
import { acquireLock } from '../state.js';

/**
 * Notverkauf: verkauft alle vom Bot geöffneten Positionen sofort.
 * Im Live-Modus muss zur Sicherheit "--ja" angegeben werden:
 *   npm run sell-all -- --ja
 * Vorher den laufenden Bot beenden (Strg+C), damit nicht beide gleichzeitig handeln.
 */
async function main(): Promise<void> {
  const { cfg, wallet } = await setup();
  acquireLock(cfg.dataDir);
  const bot = new Bot(cfg, wallet);
  if (bot.state.positions.length === 0) {
    console.log('Keine offenen Positionen.');
    return;
  }
  if (!cfg.dryRun && !process.argv.includes('--ja')) {
    console.log(`${bot.state.positions.length} LIVE-Position(en) offen. Zum Verkaufen ausführen: npm run sell-all -- --ja`);
    return;
  }
  await bot.sellAll();
  const left = bot.state.positions.length;
  if (left) log.warn(`${left} Position(en) konnten nicht verkauft werden – bitte in Phantom prüfen.`);
  else log.info('Alle Positionen verkauft.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
