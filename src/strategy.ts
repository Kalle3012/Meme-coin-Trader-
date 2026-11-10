import type { Config } from './config.js';
import type { DexPair } from './dexscreener.js';
import type { RugReport } from './rugcheck.js';

/**
 * Reine Entscheidungslogik (ohne Netzwerk), damit sie vollständig testbar ist.
 * Jede Funktion liefert eine Liste von Ablehnungsgründen. Leere Liste = bestanden.
 */

export interface Candidate {
  mint: string;
  symbol: string;
  pair: DexPair;
  score: number;
  /** Gesetzt, wenn der Token zu einem Internet-Trend passt (Trend-Radar). */
  trend?: { score: number; reasons: string[] };
}

/** Sortierung: Trend-Treffer immer zuerst prüfen, innerhalb der Gruppen nach Score. */
export function compareCandidates(a: Candidate, b: Candidate): number {
  const ta = a.trend ? 1 : 0;
  const tb = b.trend ? 1 : 0;
  return tb - ta || b.score - a.score;
}

/** Rangfolge mit Trend-Bonus: Trend-Treffer werden bevorzugt geprüft (Filter bleiben gleich!). */
export function rankedScore(pair: DexPair, trendScore: number): number {
  return candidateScore(pair) * (1 + Math.max(0, trendScore));
}

/**
 * Stufe 1: Marktdaten von DexScreener.
 * Für Trend-Treffer (`isTrend`) gelten eine höhere Alters- und Market-Cap-Grenze:
 * Event-Coins (z. B. GTA 6) entstehen oft Wochen vor dem Ereignis, und ein
 * etablierter Coin ist sicherer als eine frische Kopie. Alle anderen Filter
 * (Liquidität, Volumen, Kaufdruck, Mindestalter …) bleiben gleich.
 */
export function marketRejections(pair: DexPair, cfg: Config, now = Date.now(), isTrend = false): string[] {
  const maxAgeHours = isTrend ? Math.max(cfg.maxPairAgeHours, cfg.trendMaxPairAgeHours) : cfg.maxPairAgeHours;
  const maxMcap = isTrend ? Math.max(cfg.maxMarketCapUsd, cfg.trendMaxMarketCapUsd) : cfg.maxMarketCapUsd;
  const r: string[] = [];
  const liq = pair.liquidity?.usd ?? 0;
  const mcap = pair.marketCap ?? pair.fdv ?? 0;
  const h1 = pair.txns?.h1;
  const vol1h = pair.volume?.h1 ?? 0;
  const pc = pair.priceChange ?? {};

  if (pair.chainId !== 'solana') r.push('nicht Solana');
  if (liq < cfg.minLiquidityUsd) r.push(`Liquidität $${Math.round(liq)} < $${cfg.minLiquidityUsd}`);
  if (mcap < cfg.minMarketCapUsd) r.push(`Market Cap $${Math.round(mcap)} < $${cfg.minMarketCapUsd}`);
  if (mcap > maxMcap) r.push(`Market Cap $${Math.round(mcap)} > $${maxMcap}`);

  if (!pair.pairCreatedAt) {
    r.push('Alter des Paares unbekannt');
  } else {
    const ageMin = (now - pair.pairCreatedAt) / 60_000;
    if (ageMin < cfg.minPairAgeMinutes) r.push(`zu jung (${Math.round(ageMin)} min)`);
    if (ageMin > maxAgeHours * 60) r.push(`zu alt (${Math.round(ageMin / 60)} h)`);
  }

  if (vol1h < cfg.minVolumeH1Usd) r.push(`Volumen 1h $${Math.round(vol1h)} < $${cfg.minVolumeH1Usd}`);
  if (!h1) {
    r.push('keine Transaktionsdaten');
  } else {
    const total = h1.buys + h1.sells;
    if (total < cfg.minTxnsH1) r.push(`nur ${total} Transaktionen in 1h`);
    const ratio = h1.sells === 0 ? (h1.buys > 0 ? Infinity : 0) : h1.buys / h1.sells;
    if (ratio < cfg.minBuySellRatioH1) r.push(`Kauf/Verkauf-Verhältnis ${ratio.toFixed(2)} < ${cfg.minBuySellRatioH1}`);
  }

  const ch1 = pc.h1;
  const cm5 = pc.m5;
  if (typeof ch1 !== 'number') r.push('Preisänderung 1h unbekannt');
  else {
    if (ch1 < cfg.minPriceChangeH1Pct) r.push(`Preis 1h ${ch1}% < ${cfg.minPriceChangeH1Pct}%`);
    if (ch1 > cfg.maxPriceChangeH1Pct) r.push(`Preis 1h ${ch1}% > ${cfg.maxPriceChangeH1Pct}% (zu spät, kein FOMO)`);
  }
  if (typeof cm5 === 'number' && cm5 < cfg.minPriceChangeM5Pct) r.push(`fällt gerade (5m ${cm5}%)`);

  if (cfg.requireSocials) {
    const hasSocial = (pair.info?.socials?.length ?? 0) > 0 || (pair.info?.websites?.length ?? 0) > 0;
    if (!hasSocial) r.push('keine Website/Social-Links');
  }
  return r;
}

/** Rangfolge: Volumen relativ zur Liquidität und Kaufdruck. */
export function candidateScore(pair: DexPair): number {
  const liq = Math.max(pair.liquidity?.usd ?? 0, 1);
  const vol = pair.volume?.h1 ?? 0;
  const h1 = pair.txns?.h1 ?? { buys: 0, sells: 0 };
  const buyPressure = (h1.buys + 1) / (h1.sells + 1);
  return (vol / liq) * Math.min(buyPressure, 3);
}

export interface HolderStats {
  top10Pct: number;
  maxSinglePct: number;
  insiderPct: number;
}

/** Holder-Konzentration ohne Liquiditätspools (AMM-Konten zählen nicht als "Wal"). */
export function holderStats(rep: RugReport): HolderStats {
  const known = rep.knownAccounts ?? {};
  const isPool = (addr: string) => {
    const t = known[addr]?.type?.toUpperCase();
    return t === 'AMM' || t === 'CLOB' || t === 'POOL';
  };
  const holders = (rep.topHolders ?? []).filter((h) => !isPool(h.owner) && !isPool(h.address));
  const sorted = [...holders].sort((a, b) => b.pct - a.pct);
  const top10Pct = sorted.slice(0, 10).reduce((s, h) => s + h.pct, 0);
  const maxSinglePct = sorted[0]?.pct ?? 0;

  const supply = rep.token?.supply ?? 0;
  let networkPct = 0;
  if (supply > 0) {
    for (const n of rep.insiderNetworks ?? []) {
      const pct = ((n.currentHolding ?? 0) / supply) * 100;
      const size = Math.max(1, n.size ?? 1);
      // Riesige "Netzwerke" (Tausende Wallets) sind meist über Börsen verknüpfte
      // normale Käufer, keine koordinierte Insider-Gruppe.
      if (size > MAX_INSIDER_NETWORK_SIZE) continue;
      // Plausibilität: k Wallets können höchstens so viel halten wie die k größten Holder.
      // Liefert RugCheck mehr, sind die Daten widersprüchlich (z. B. Pools mitgezählt) -> ignorieren.
      const bound = maxHoldingOfLargest(sorted, size);
      if (pct > bound * 1.05 + 0.5) continue;
      networkPct += Math.min(pct, bound);
    }
  }
  // Holder, die RugCheck selbst als Insider markiert, zusätzlich berücksichtigen.
  const flagged = holders.filter((h) => h.insider).reduce((s, h) => s + h.pct, 0);
  const insiderPct = Math.min(100, Math.max(networkPct, flagged));

  return { top10Pct, maxSinglePct, insiderPct };
}

const MAX_INSIDER_NETWORK_SIZE = 100;

/**
 * Obergrenze dessen, was k Wallets halten können: Summe der k größten bekannten Holder.
 * RugCheck listet nur die größten ~20 Holder; jede weitere Wallet hält höchstens so viel
 * wie der kleinste gelistete Holder.
 */
export function maxHoldingOfLargest(sortedDesc: { pct: number }[], k: number): number {
  const listed = sortedDesc.slice(0, k).reduce((s, h) => s + h.pct, 0);
  const extra = Math.max(0, k - sortedDesc.length) * (sortedDesc[sortedDesc.length - 1]?.pct ?? 0);
  return listed + extra;
}

/** Stufe 2: Sicherheitsprüfung mit dem RugCheck-Report. */
/**
 * RugCheck liefert gelegentlich Teilberichte (z. B. ohne Holder-Liste oder Token-Daten),
 * auch für Token, die Minuten vorher vollständig geprüft wurden. Solche Berichte
 * sind keine Kaufgrundlage, aber auch kein Grund für eine lange Sperre.
 */
export function isIncompleteReport(rep: RugReport): boolean {
  return !rep.token || !rep.topHolders || rep.topHolders.length === 0 || typeof rep.score_normalised !== 'number';
}

export function safetyRejections(rep: RugReport, cfg: Config): string[] {
  const r: string[] = [];
  const mintAuth = rep.mintAuthority ?? rep.token?.mintAuthority ?? null;
  const freezeAuth = rep.freezeAuthority ?? rep.token?.freezeAuthority ?? null;

  if (rep.rugged) r.push('von RugCheck als "rugged" markiert');
  if (mintAuth) r.push('Mint-Authority aktiv (Entwickler kann unbegrenzt neue Token erzeugen)');
  if (freezeAuth) r.push('Freeze-Authority aktiv (Entwickler kann Verkäufe blockieren = Honeypot)');
  if ((rep.transferFee?.pct ?? 0) > 0) r.push(`Transfer-Gebühr ${rep.transferFee?.pct}%`);
  if (typeof rep.score_normalised !== 'number') r.push('RugCheck-Score fehlt');
  else if (rep.score_normalised > cfg.maxRugcheckScore) r.push(`RugCheck-Score ${rep.score_normalised} > ${cfg.maxRugcheckScore}`);

  if (cfg.rejectDangerRisks) {
    for (const risk of rep.risks ?? []) {
      if (risk.level?.toLowerCase() === 'danger') r.push(`RugCheck-Gefahr: ${risk.name}`);
    }
  }

  if ((rep.totalHolders ?? 0) < cfg.minHolders) r.push(`nur ${rep.totalHolders ?? 0} Holder < ${cfg.minHolders}`);

  if (!rep.topHolders || rep.topHolders.length === 0) {
    r.push('keine Holder-Daten');
  } else {
    const s = holderStats(rep);
    if (s.top10Pct > cfg.maxTop10HolderPct) r.push(`Top-10-Holder besitzen ${s.top10Pct.toFixed(1)}% > ${cfg.maxTop10HolderPct}%`);
    if (s.maxSinglePct > cfg.maxSingleHolderPct) r.push(`größter Holder besitzt ${s.maxSinglePct.toFixed(1)}% > ${cfg.maxSingleHolderPct}%`);
    if (s.insiderPct > cfg.maxInsiderPct) r.push(`Insider-Netzwerke halten ${s.insiderPct.toFixed(1)}% > ${cfg.maxInsiderPct}%`);
  }
  return r;
}

/**
 * Stufe 3: Honeypot-/Steuer-Test über echte Jupiter-Quotes:
 * Kaufen und sofort wieder Verkaufen simulieren. Ist der Verlust zu hoch,
 * kann man den Token nicht vernünftig verkaufen.
 */
export function roundtripRejections(
  buyInLamports: bigint,
  sellOutLamports: bigint,
  buyImpactPct: number | null,
  cfg: Config,
): string[] {
  const r: string[] = [];
  if (buyImpactPct === null) r.push('Preiseinfluss unbekannt');
  else if (buyImpactPct > cfg.maxPriceImpactPct) r.push(`Preiseinfluss ${buyImpactPct.toFixed(2)}% > ${cfg.maxPriceImpactPct}%`);
  const lossPct = roundtripLossPct(buyInLamports, sellOutLamports);
  if (lossPct > cfg.maxRoundtripLossPct) r.push(`Kauf+Verkauf-Verlust ${lossPct.toFixed(2)}% > ${cfg.maxRoundtripLossPct}% (Honeypot/Steuer/dünne Liquidität)`);
  return r;
}

export function roundtripLossPct(inLamports: bigint, outLamports: bigint): number {
  if (inLamports <= 0n) return 100;
  return (1 - Number(outLamports) / Number(inLamports)) * 100;
}
