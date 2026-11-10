/**
 * Kleine HTTP-Hilfen: Timeouts, Wiederholungen bei 429/5xx und ein
 * Rate-Limiter, damit wir die Limits der kostenlosen APIs einhalten.
 */

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export { sleep };

/** Reiht Anfragen so ein, dass höchstens `rps` Anfragen pro Sekunde gesendet werden. */
export class RateLimiter {
  private next = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly intervalMs: number;

  constructor(rps: number) {
    this.intervalMs = Math.ceil(1000 / rps);
  }

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const slot = this.chain.then(async () => {
      const wait = this.next - Date.now();
      if (wait > 0) await sleep(wait);
      this.next = Date.now() + this.intervalMs;
    });
    this.chain = slot.catch(() => undefined);
    return slot.then(fn);
  }

  /** Nach einer 429-Antwort alle weiteren Anfragen zurückstellen. */
  backoff(ms: number): void {
    this.next = Math.max(this.next, Date.now() + ms);
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Nur für idempotente Anfragen (GET) sinnvoll. */
  retries?: number;
  limiter?: RateLimiter;
}

export async function requestJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', headers = {}, body, timeoutMs = 15_000, limiter } = opts;
  const retries = opts.retries ?? (method === 'GET' ? 3 : 0);
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const doFetch = () =>
      fetch(url, {
        method,
        headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    try {
      const res = limiter ? await limiter.schedule(doFetch) : await doFetch();
      const text = await res.text();
      if (res.ok) {
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new HttpError(`Ungültiges JSON von ${redactUrl(url)}`, res.status, text.slice(0, 300));
        }
      }
      const err = new HttpError(`HTTP ${res.status} von ${redactUrl(url)}: ${text.slice(0, 300)}`, res.status, text);
      if (res.status === 429 || res.status >= 500) {
        lastErr = err;
        const backoffMs = retryAfterMs(res) ?? 2000 * 2 ** attempt;
        limiter?.backoff(backoffMs);
        if (attempt < retries) {
          await sleep(backoffMs);
          continue;
        }
      }
      throw err;
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 429 || e.status >= 500) lastErr = e;
        else throw e;
      } else {
        lastErr = e; // Netzwerkfehler oder Timeout
      }
      if (attempt < retries) {
        await sleep(1500 * 2 ** attempt);
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function retryAfterMs(res: Response): number | undefined {
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter && Number.isFinite(Number(retryAfter))) return Math.min(Number(retryAfter) * 1000, 60_000);
  const reset = res.headers.get('x-ratelimit-reset');
  if (reset && Number.isFinite(Number(reset))) {
    const ms = Number(reset) * 1000 - Date.now();
    if (ms > 0) return Math.min(ms + 250, 60_000);
  }
  return undefined;
}

function redactUrl(url: string): string {
  return url.replace(/(api[-_]?key=)[^&]+/gi, '$1***');
}
