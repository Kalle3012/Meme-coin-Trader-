import { RateLimiter, requestJson } from './http.js';

/**
 * DexScreener-API (kostenlos, ohne Key). Dient zum Finden neuer Meme-Coins
 * (Boosts / Token-Profile) und für Marktdaten (Liquidität, Volumen, Käufe/Verkäufe).
 * Limit laut Doku: 60 Anfragen/Minute für Profile/Boosts -> wir bleiben bei 1/s.
 */

const BASE = 'https://api.dexscreener.com';

export interface DexPair {
  chainId: string;
  dexId: string;
  url?: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken?: { address: string; name: string; symbol: string } | null;
  priceNative?: string;
  priceUsd?: string | null;
  txns?: Record<string, { buys: number; sells: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number> | null;
  liquidity?: { usd?: number | null; base?: number; quote?: number } | null;
  fdv?: number | null;
  marketCap?: number | null;
  pairCreatedAt?: number | null; // Millisekunden
  info?: {
    websites?: { url: string }[] | null;
    socials?: { url?: string; type?: string; platform?: string; handle?: string }[] | null;
  } | null;
}

interface TokenListEntry {
  chainId: string;
  tokenAddress: string;
}

export class DexScreenerClient {
  private readonly limiter = new RateLimiter(1);

  /** Neu beworbene / neu profilierte Solana-Token-Adressen (dedupliziert). */
  async discoverSolanaTokens(): Promise<string[]> {
    const endpoints = ['/token-boosts/latest/v1', '/token-boosts/top/v1', '/token-profiles/latest/v1'];
    const seen = new Set<string>();
    for (const ep of endpoints) {
      try {
        const list = await requestJson<TokenListEntry[]>(`${BASE}${ep}`, { limiter: this.limiter });
        if (!Array.isArray(list)) continue;
        for (const t of list) {
          if (t?.chainId === 'solana' && typeof t.tokenAddress === 'string') seen.add(t.tokenAddress);
        }
      } catch {
        // Ein ausgefallener Endpunkt soll den Scan nicht stoppen.
      }
    }
    return [...seen];
  }

  /** Paare zu bis zu 30 Token-Adressen pro Anfrage. */
  async pairsForTokens(mints: string[]): Promise<DexPair[]> {
    const out: DexPair[] = [];
    for (let i = 0; i < mints.length; i += 30) {
      const batch = mints.slice(i, i + 30);
      const pairs = await requestJson<DexPair[]>(`${BASE}/tokens/v1/solana/${batch.join(',')}`, { limiter: this.limiter });
      if (Array.isArray(pairs)) out.push(...pairs);
    }
    return out;
  }
}

/** Pro Token das Paar mit der höchsten USD-Liquidität, bei dem der Token der Basis-Token ist. */
export function bestPairPerToken(pairs: DexPair[]): Map<string, DexPair> {
  const best = new Map<string, DexPair>();
  for (const p of pairs) {
    if (p.chainId !== 'solana' || !p.baseToken?.address) continue;
    const mint = p.baseToken.address;
    const cur = best.get(mint);
    if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) best.set(mint, p);
  }
  return best;
}
