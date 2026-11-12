import { HttpError, RateLimiter, requestJson } from './http.js';

/**
 * Client für die Jupiter Swap API V2 (https://api.jup.ag/swap/v2).
 * Ablauf laut Doku: GET /order -> Transaktion signieren -> POST /execute.
 * Jupiter sendet die Transaktion selbst und meldet das Ergebnis zurück.
 * Ohne API-Key: 0,5 Anfragen/Sekunde (keyless). Mit kostenlosem Key: 1/s.
 */

const BASE = 'https://api.jup.ag';

export interface JupiterOrder {
  transaction: string | null; // base64, null ohne taker, "" wenn nicht baubar
  requestId: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  slippageBps?: number;
  priceImpact?: number; // in Prozentpunkten, z. B. -0.1 = -0,1 %
  priceImpactPct?: string; // veraltet: Anteil, z. B. "-0.001"
  router?: string;
  mode?: string;
  feeBps?: number;
  errorCode?: number;
  errorMessage?: string;
  error?: string;
}

export interface JupiterExecuteResult {
  status: 'Success' | 'Failed';
  signature?: string;
  code: number;
  error?: string;
  totalInputAmount?: string;
  totalOutputAmount?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
}

export interface OrderParams {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  taker?: string;
  slippageBps?: number; // 0 oder undefined = automatisch
}

export interface JupTokenStats {
  priceChange?: number | null;
  holderChange?: number | null;
  buyVolume?: number | null;
  sellVolume?: number | null;
  buyOrganicVolume?: number | null;
  numBuys?: number | null;
  numSells?: number | null;
  numTraders?: number | null;
  numNetBuyers?: number | null;
}

/** Token-Objekt der Jupiter Tokens API V2 (Felder im Nov. 2026 live geprüft). */
export interface JupToken {
  id: string;
  name: string;
  symbol: string;
  createdAt?: string | null;
  dev?: string | null;
  launchpad?: string | null;
  graduatedAt?: string | null;
  holderCount?: number | null;
  mcap?: number | null;
  fdv?: number | null;
  liquidity?: number | null;
  usdPrice?: number | null;
  organicScore?: number | null;
  twitter?: string | null;
  website?: string | null;
  telegram?: string | null;
  tags?: string[] | null;
  audit?: {
    isSus?: boolean | null;
    mintAuthorityDisabled?: boolean | null;
    freezeAuthorityDisabled?: boolean | null;
    topHoldersPercentage?: number | null;
    devBalancePercentage?: number | null;
    devMints?: number | null;
    devMigrations?: number | null;
  } | null;
  stats5m?: JupTokenStats | null;
  stats1h?: JupTokenStats | null;
}

export class NoRouteError extends Error {}

/**
 * true, wenn Jupiter den Token grundsätzlich nicht handeln kann (keine Route, 4xx).
 * Netzwerkfehler, 429 und 5xx zählen NICHT dazu (vorübergehende Störung).
 */
export function isNoRouteError(e: unknown): boolean {
  if (e instanceof NoRouteError) return true;
  return e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 401 && e.status !== 403;
}

export class JupiterClient {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly apiKey: string | undefined,
    rps: number,
  ) {
    this.limiter = new RateLimiter(rps);
  }

  private headers(): Record<string, string> {
    return this.apiKey ? { 'x-api-key': this.apiKey } : {};
  }

  async order(p: OrderParams): Promise<JupiterOrder> {
    if (p.amount <= 0n) throw new Error('Jupiter-Order: Betrag muss > 0 sein');
    const qs = new URLSearchParams({
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      amount: p.amount.toString(),
    });
    if (p.taker) qs.set('taker', p.taker);
    if (p.slippageBps && p.slippageBps > 0) qs.set('slippageBps', String(p.slippageBps));
    const order = await requestJson<JupiterOrder>(`${BASE}/swap/v2/order?${qs}`, {
      headers: this.headers(),
      limiter: this.limiter,
    });
    if (order.error && !order.outAmount) throw new Error(`Jupiter-Order-Fehler: ${order.error}`);
    if (!order.outAmount || BigInt(order.outAmount) <= 0n) {
      throw new NoRouteError(`Jupiter: keine Route gefunden (${order.errorMessage ?? order.error ?? 'outAmount=0'})`);
    }
    return order;
  }

  /** Die neuesten Token (Sekunden bis Minuten alt), inkl. Sicherheits- und Handelsdaten. */
  async recentTokens(): Promise<JupToken[]> {
    const list = await requestJson<JupToken[]>(`${BASE}/tokens/v2/recent`, {
      headers: this.headers(),
      limiter: this.limiter,
      retries: 1,
    });
    return Array.isArray(list) ? list.filter((t) => typeof t?.id === 'string') : [];
  }

  /** Aktuelle Daten zu bestimmten Token (max. 30 pro Anfrage, wird automatisch aufgeteilt). */
  async tokensByMint(mints: string[]): Promise<JupToken[]> {
    const out: JupToken[] = [];
    for (let i = 0; i < mints.length; i += 30) {
      const batch = mints.slice(i, i + 30);
      const list = await requestJson<JupToken[]>(`${BASE}/tokens/v2/search?query=${batch.join(',')}`, {
        headers: this.headers(),
        limiter: this.limiter,
        retries: 1,
      });
      if (Array.isArray(list)) out.push(...list.filter((t) => typeof t?.id === 'string' && batch.includes(t.id)));
    }
    return out;
  }

  /**
   * Token-Entdeckung über die Jupiter Tokens API V2: aktuell trendende Token
   * und Token mit hohem "Organic Score" (echte Nutzer statt Bot-/Wash-Volumen).
   */
  async trendingMints(limit = 50): Promise<string[]> {
    const out = new Set<string>();
    for (const category of ['toptrending', 'toporganicscore']) {
      try {
        const list = await requestJson<{ id?: string }[]>(`${BASE}/tokens/v2/${category}/1h?limit=${limit}`, {
          headers: this.headers(),
          limiter: this.limiter,
          retries: 1,
        });
        if (Array.isArray(list)) for (const t of list) if (typeof t?.id === 'string') out.add(t.id);
      } catch {
        // Entdeckung ist optional – Ausfall ignorieren.
      }
    }
    return [...out];
  }

  /** Signierte Transaktion an Jupiter übergeben. Kein automatisches Wiederholen (Doppelausführung vermeiden). */
  async execute(signedTransactionBase64: string, requestId: string): Promise<JupiterExecuteResult> {
    return requestJson<JupiterExecuteResult>(`${BASE}/swap/v2/execute`, {
      method: 'POST',
      headers: this.headers(),
      body: { signedTransaction: signedTransactionBase64, requestId },
      timeoutMs: 90_000,
      retries: 0,
    });
  }
}

/** Preiseinfluss einer Order in Prozent (Betrag). `null` wenn Jupiter keinen Wert liefert. */
export function priceImpactPercent(order: JupiterOrder): number | null {
  if (typeof order.priceImpact === 'number' && Number.isFinite(order.priceImpact)) return Math.abs(order.priceImpact);
  if (order.priceImpactPct !== undefined) {
    const v = Number(order.priceImpactPct);
    if (Number.isFinite(v)) return Math.abs(v * 100);
  }
  return null;
}
