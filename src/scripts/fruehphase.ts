import { ConfigError, loadConfig } from '../config.js';
import { EarlyRadar } from '../early.js';
import { sleep } from '../http.js';
import { JupiterClient } from '../jupiter.js';
import { setLogDir } from '../logger.js';
import { TrendRadar } from '../trends.js';

/**
 * Live-Ansicht des Frühphasen-Radars: zeigt neue Coins, ihren Potenzial-Score
 * und warum sie (nicht) kaufbar wären. KAUFT NICHTS.
 * Aufruf: npm run fruehphase -- 30   (Laufzeit in Minuten, Standard 15)
 * Nebenbei werden Messdaten für "npm run auswertung" gesammelt.
 */
async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(e instanceof ConfigError ? `Konfigurationsfehler: ${e.message}` : e);
    process.exit(1);
  }
  setLogDir(cfg.dataDir);
  const minutes = Math.max(1, Number(process.argv[2] ?? 15) || 15);
  const trends = cfg.trendEnabled ? new TrendRadar(cfg) : undefined;
  if (trends) {
    console.log('Trend-Radar wird geladen (ca. 40 s) …');
    await trends.refresh().catch(() => undefined);
  }
  const radar = new EarlyRadar(cfg, new JupiterClient(cfg.jupiterApiKey, cfg.jupiterRps), trends);
  radar.start();
  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
  });

  console.log(`\nFrühphasen-Radar läuft ${minutes} Minuten (Strg+C beendet). Kauf-Schwelle: Score ${cfg.earlyMinScore}/100.\n`);
  const end = Date.now() + minutes * 60_000;
  await sleep(20_000);
  while (!stop && Date.now() < end) {
    const candidates = await radar.evaluate();
    const snap = radar.snapshot();
    console.log(`\n===== ${new Date().toLocaleTimeString('de-DE')} – ${radar.size} Coins beobachtet, ${radar.streamedCount} per Stream erkannt =====`);
    for (const s of snap.slice(0, 10)) {
      const sc = s.score!;
      const status = sc.gates.length ? `✗ ${sc.gates[0]}` : sc.waits.length ? `… ${sc.waits[0]}` : sc.total >= cfg.earlyMinScore ? '✓ KAUF-KANDIDAT' : '– Score zu niedrig';
      console.log(
        `${String(sc.total).padStart(3)}/100  ${s.symbol.slice(0, 12).padEnd(12)} ${s.ageMin.toFixed(0).padStart(4)} min  ` +
          `MCap $${Math.round(s.mcap).toLocaleString('de-DE').padStart(10)}  ${String(s.holders).padStart(5)} Holder  ` +
          `[N${sc.narrative} M${sc.momentum} C${sc.community} S${sc.safety}]  ${status}`,
      );
      if (sc.reasons.length) console.log(`         ${sc.reasons.join(' | ')}`);
    }
    if (candidates.length) {
      console.log(`\n→ ${candidates.length} Kauf-Kandidat(en). Der Bot würde jetzt RugCheck + Honeypot-Test machen:`);
      for (const c of candidates.slice(0, 3)) console.log(`   ${c.symbol}: https://dexscreener.com/solana/${c.mint}`);
    }
    for (let i = 0; i < cfg.earlyEvalIntervalSec && !stop && Date.now() < end; i++) await sleep(1000);
  }
  radar.stop();
  console.log('\nBeendet. Messdaten liegen in data/fruehphase.csv – Auswertung mit "npm run auswertung".');
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
