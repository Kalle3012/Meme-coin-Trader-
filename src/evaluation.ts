/**
 * Auswertung der Frühphasen-Messdaten (data/fruehphase.csv):
 * Steigen Coins mit hohem Potenzial-Score wirklich häufiger als andere?
 * Reine Funktionen, damit sie testbar sind.
 */

export interface Rated {
  mint: string;
  score: number;
  gated: boolean;
  change15?: number;
  change60?: number;
  vanished60?: boolean;
}

export function parseEarlyCsv(text: string): Rated[] {
  const byMint = new Map<string, Rated>();
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const c = line.split(';');
    const [, typ, mint, , , score, , , , , gates, , , change] = c;
    if (!typ || !mint) continue;
    if (typ === 'BEWERTUNG') {
      byMint.set(mint, { mint, score: Number(score), gated: (gates ?? '').trim().length > 0 });
      continue;
    }
    const r = byMint.get(mint);
    if (!r) continue;
    const v = Number(change);
    if (!Number.isFinite(v)) continue;
    if (typ.startsWith('NACH15')) r.change15 = v;
    if (typ.startsWith('NACH60')) {
      r.change60 = v;
      r.vanished60 = typ.includes('VERSCHWUNDEN');
    }
  }
  return [...byMint.values()];
}

export interface BucketStats {
  label: string;
  count: number;
  measured60: number;
  median15: number | null;
  median60: number | null;
  doubled60Pct: number | null; // Anteil mit >= +100 % nach 60 min
  crashed60Pct: number | null; // Anteil mit <= -50 % (inkl. verschwunden) nach 60 min
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export const BUCKETS: { label: string; test: (r: Rated) => boolean }[] = [
  { label: 'ausgeschlossen (Betrugsmuster)', test: (r) => r.gated },
  { label: 'Score 0–39', test: (r) => !r.gated && r.score < 40 },
  { label: 'Score 40–59', test: (r) => !r.gated && r.score >= 40 && r.score < 60 },
  { label: 'Score 60–79', test: (r) => !r.gated && r.score >= 60 && r.score < 80 },
  { label: 'Score 80–100', test: (r) => !r.gated && r.score >= 80 },
];

export function bucketStats(rows: Rated[]): BucketStats[] {
  return BUCKETS.map(({ label, test }) => {
    const inB = rows.filter(test);
    const with60 = inB.filter((r) => r.change60 !== undefined);
    const c15 = inB.filter((r) => r.change15 !== undefined).map((r) => r.change15!);
    const c60 = with60.map((r) => r.change60!);
    return {
      label,
      count: inB.length,
      measured60: with60.length,
      median15: median(c15),
      median60: median(c60),
      doubled60Pct: with60.length ? (c60.filter((v) => v >= 100).length / with60.length) * 100 : null,
      crashed60Pct: with60.length ? (c60.filter((v) => v <= -50).length / with60.length) * 100 : null,
    };
  });
}
