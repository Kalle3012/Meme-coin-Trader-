import { ConfigError, loadConfig } from '../config.js';
import { DexScreenerClient, bestPairPerToken } from '../dexscreener.js';
import { errMsg } from '../logger.js';
import { RugCheckClient } from '../rugcheck.js';
import { marketRejections, safetyRejections } from '../strategy.js';
import { TrendRadar, type TrendSource } from '../trends.js';

/**
 * Zeigt, was der Trend-Radar gerade im Internet findet und wie die
 * passenden Meme-Coins bei den Filtern abschneiden. Kauft NICHTS.
 */

const LABEL: Record<TrendSource, string> = {
  keyword: 'Deine Stichwörter (+ Google News)',
  google: 'Google Trends',
  wikipedia: 'Wikipedia (meistgelesen gestern)',
  coingecko: 'CoinGecko (meistgesucht)',
  dexmeta: 'DexScreener-Narrative',
};

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(e instanceof ConfigError ? `Konfigurationsfehler: ${e.message}` : e);
    process.exit(1);
  }
  console.log('Trend-Radar wird abgefragt (dauert ca. 30–60 Sekunden) …\n');
  const radar = new TrendRadar(cfg);
  await radar.refresh();

  const topics = radar.getTopics();
  for (const source of Object.keys(LABEL) as TrendSource[]) {
    const list = topics.filter((t) => t.source === source);
    if (!list.length) continue;
    console.log(`\n■ ${LABEL[source]}`);
    for (const t of list.slice(0, 12)) console.log(`   - ${t.term}  [${t.detail}]`);
    if (list.length > 12) console.log(`   … und ${list.length - 12} weitere`);
  }

  const hits = [...radar.getHits().values()].sort((a, b) => b.score - a.score);
  console.log(`\n================ Passende Solana-Token: ${hits.length} ================`);
  if (!hits.length) return;

  const dex = new DexScreenerClient();
  const rug = new RugCheckClient();
  const pairs = bestPairPerToken(await dex.pairsForTokens(hits.map((h) => h.mint)));
  let safetyChecks = 0;

  for (const h of hits.slice(0, 25)) {
    const p = pairs.get(h.mint);
    console.log(`\n${h.symbol} – ${h.name}   (Trend-Score ${h.score.toFixed(1)})`);
    console.log(`   Adresse: ${h.mint}`);
    console.log(`   Trend:   ${h.reasons.join(' | ')}`);
    if (!p) {
      console.log('   Markt:   keine Daten');
      continue;
    }
    const ageH = p.pairCreatedAt ? ((Date.now() - p.pairCreatedAt) / 3_600_000).toFixed(1) : '?';
    console.log(
      `   Markt:   Liq $${Math.round(p.liquidity?.usd ?? 0)}, MCap $${Math.round(p.marketCap ?? 0)}, ` +
        `Vol 1h $${Math.round(p.volume?.h1 ?? 0)}, 1h ${p.priceChange?.h1 ?? '?'}%, Alter ${ageH} h`,
    );
    console.log(`   Chart:   https://dexscreener.com/solana/${p.pairAddress}`);
    const market = marketRejections(p, cfg, Date.now(), true);
    if (market.length) {
      console.log(`   ✗ Markt-Filter: ${market.join('; ')}`);
      continue;
    }
    if (safetyChecks >= 8) {
      console.log('   ✓ Markt-Filter bestanden (Sicherheitsprüfung übersprungen – Limit erreicht)');
      continue;
    }
    safetyChecks++;
    try {
      const safety = safetyRejections(await rug.report(h.mint), cfg);
      console.log(safety.length ? `   ✗ Sicherheit: ${safety.join('; ')}` : '   ✓ Markt + Sicherheit bestanden → Kauf-Kandidat für den Bot');
    } catch (e) {
      console.log(`   ? RugCheck nicht erreichbar: ${errMsg(e)}`);
    }
  }
  console.log('\nHinweis: Diese Übersicht kauft nichts. Ein ✓ ist keine Gewinngarantie.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
