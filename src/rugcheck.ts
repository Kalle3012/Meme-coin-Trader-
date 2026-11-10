import { RateLimiter, requestJson } from './http.js';

/**
 * RugCheck-API (https://api.rugcheck.xyz). Der vollständige Report enthält u. a.
 * Mint-/Freeze-Authority, Top-Holder, Insider-Netzwerke und Risiko-Liste.
 * Felder wurden gegen echte API-Antworten geprüft (Nov. 2026).
 */

const BASE = 'https://api.rugcheck.xyz';

export interface RugRisk {
  name: string;
  value: string;
  description: string;
  score: number;
  level: string; // "info" | "warn" | "danger"
}

export interface RugHolder {
  address: string;
  owner: string;
  pct: number;
  insider?: boolean;
}

export interface RugReport {
  mint: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  token?: { supply?: number; decimals?: number; mintAuthority?: string | null; freezeAuthority?: string | null } | null;
  topHolders: RugHolder[] | null;
  risks: RugRisk[] | null;
  score: number;
  score_normalised: number;
  totalHolders?: number;
  rugged?: boolean;
  transferFee?: { pct?: number } | null;
  knownAccounts?: Record<string, { name?: string; type?: string }> | null;
  insiderNetworks?: { id: string; size: number; type: string; tokenAmount?: number; currentHolding?: number }[] | null;
  graphInsidersDetected?: number;
}

export class RugCheckClient {
  private readonly limiter = new RateLimiter(0.7);

  async report(mint: string): Promise<RugReport> {
    return requestJson<RugReport>(`${BASE}/v1/tokens/${encodeURIComponent(mint)}/report`, {
      limiter: this.limiter,
      timeoutMs: 25_000,
    });
  }
}
