import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { bucketStats, parseEarlyCsv } from '../evaluation.js';

/** Zeigt, ob der Potenzial-Score in der Vergangenheit wirklich etwas vorhergesagt hat. */
function main(): void {
  const cfg = loadConfig();
  const file = path.join(cfg.dataDir, 'fruehphase.csv');
  if (!fs.existsSync(file)) {
    console.log('Noch keine Messdaten. Bot (npm start) oder "npm run fruehphase" einige Stunden laufen lassen.');
    return;
  }
  const rows = parseEarlyCsv(fs.readFileSync(file, 'utf8'));
  const stats = bucketStats(rows);
  const fmt = (v: number | null, suffix = '%') => (v === null ? '   –  ' : `${v >= 0 ? '+' : ''}${v.toFixed(0)}${suffix}`.padStart(6));

  console.log(`\nFrühphasen-Auswertung: ${rows.length} bewertete Coins\n`);
  console.log('Gruppe                          Anzahl  gemessen   Median 15min  Median 60min  verdoppelt  abgestürzt');
  for (const s of stats) {
    console.log(
      `${s.label.padEnd(32)}${String(s.count).padStart(6)}  ${String(s.measured60).padStart(8)}   ` +
        `${fmt(s.median15).padStart(12)}  ${fmt(s.median60).padStart(12)}  ${fmt(s.doubled60Pct).padStart(10)}  ${fmt(s.crashed60Pct).padStart(10)}`,
    );
  }
  console.log('\nverdoppelt = Anteil mit mindestens +100 % nach 60 min; abgestürzt = Anteil mit -50 % oder schlechter (inkl. verschwunden).');

  const hi = stats.find((s) => s.label === 'Score 60–79');
  const top = stats.find((s) => s.label === 'Score 80–100');
  const lo = stats.find((s) => s.label === 'Score 0–39');
  const good = [hi, top].filter((s) => s && s.measured60 >= 20);
  if (!good.length || !lo || lo.measured60 < 20) {
    console.log('\nNoch zu wenig Daten für eine Aussage (mindestens 20 gemessene Coins je Gruppe). Weiter sammeln!');
    return;
  }
  const better = good.every((s) => (s!.median60 ?? -100) > (lo.median60 ?? -100) && (s!.crashed60Pct ?? 100) <= (lo.crashed60Pct ?? 100));
  console.log(
    better
      ? '\n✓ Hohe Scores haben sich bisher besser entwickelt als niedrige. Das ist ein Hinweis, KEIN Beweis – weiter beobachten.'
      : '\n✗ Hohe Scores haben sich NICHT klar besser entwickelt. Den Frühphasen-Handel so nicht live nutzen (EARLY_ENABLED=false) oder Einstellungen anpassen.',
  );
}

main();
