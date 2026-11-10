import fs from 'node:fs';
import path from 'node:path';

/**
 * Persistenter Zustand (offene Positionen, Tagesstatistik, Sperrlisten).
 * Wird nach jeder Änderung atomar gespeichert, damit nach einem Neustart
 * oder Absturz keine Position "vergessen" wird.
 * Papier- und Live-Modus haben getrennte Dateien.
 */

export interface Position {
  mint: string;
  symbol: string;
  openedAt: number;
  entryLamports: string; // insgesamt ausgegebene SOL (Lamports)
  initialTokenRaw: string; // beim Kauf erhaltene Token (Roh-Einheiten)
  tokenRaw: string; // aktuell gehaltene Token
  realizedLamports: string; // bereits durch Teilverkäufe erhaltene SOL
  peakRatio: number; // höchster Kurs relativ zum Einstiegskurs (1 = Einstieg)
  tookProfit: boolean;
  lastRatio?: number;
  buySignature?: string;
  sellFailures?: number;
  quoteFailures?: number;
}

export interface DayStats {
  date: string; // YYYY-MM-DD (lokale Zeit)
  realizedPnlLamports: string;
  buys: number;
}

export interface BotState {
  version: 1;
  mode: 'paper' | 'live';
  /** Nur Live-Modus: Wallet, zu der die Positionen gehören. */
  walletAddress?: string;
  paperBalanceLamports: string;
  positions: Position[];
  day: DayStats;
  /** Mint -> Zeitpunkt, bis zu dem der Token nicht erneut gekauft wird. */
  cooldowns: Record<string, number>;
  /** Mint -> Zeitpunkt, bis zu dem ein abgelehnter Token nicht erneut geprüft wird. */
  rejected: Record<string, number>;
  totalRealizedPnlLamports: string;
  closedTrades: number;
  wins: number;
}

export function localDate(now = Date.now()): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function newState(mode: 'paper' | 'live', paperStartLamports: bigint): BotState {
  return {
    version: 1,
    mode,
    paperBalanceLamports: paperStartLamports.toString(),
    positions: [],
    day: { date: localDate(), realizedPnlLamports: '0', buys: 0 },
    cooldowns: {},
    rejected: {},
    totalRealizedPnlLamports: '0',
    closedTrades: 0,
    wins: 0,
  };
}

/** Tageswechsel: Tageszähler zurücksetzen. Gibt true zurück, wenn ein neuer Tag begonnen hat. */
export function rollDay(state: BotState, now = Date.now()): boolean {
  const today = localDate(now);
  if (state.day.date === today) return false;
  state.day = { date: today, realizedPnlLamports: '0', buys: 0 };
  return true;
}

/** Abgelaufene Einträge aus Sperrlisten entfernen. */
export function pruneLists(state: BotState, now = Date.now()): void {
  for (const list of [state.cooldowns, state.rejected]) {
    for (const [mint, until] of Object.entries(list)) if (until <= now) delete list[mint];
  }
}

export class StateStore {
  readonly file: string;

  constructor(dataDir: string, mode: 'paper' | 'live') {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, `state.${mode}.json`);
  }

  load(mode: 'paper' | 'live', paperStartLamports: bigint): BotState {
    if (!fs.existsSync(this.file)) return newState(mode, paperStartLamports);
    const raw = fs.readFileSync(this.file, 'utf8');
    let parsed: BotState;
    try {
      parsed = JSON.parse(raw) as BotState;
    } catch {
      throw new Error(`Zustandsdatei ${this.file} ist beschädigt. Bitte prüfen (offene Positionen!) bevor sie gelöscht wird.`);
    }
    if (parsed.version !== 1 || parsed.mode !== mode) throw new Error(`Zustandsdatei ${this.file} passt nicht zum Modus ${mode}.`);
    parsed.cooldowns ??= {};
    parsed.rejected ??= {};
    return parsed;
  }

  save(state: BotState): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

/** Trade-Journal als CSV (z. B. für die Steuererklärung). */
export class TradeJournal {
  private readonly file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'trades.csv');
    if (!fs.existsSync(this.file)) {
      fs.writeFileSync(this.file, 'zeit_utc;modus;aktion;symbol;mint;sol_betrag;token_roh;gewinn_sol;grund;signatur\n');
    }
  }

  record(row: {
    mode: 'paper' | 'live';
    action: 'KAUF' | 'VERKAUF' | 'TEILVERKAUF';
    symbol: string;
    mint: string;
    sol: number;
    tokenRaw: string;
    pnlSol?: number;
    reason: string;
    signature?: string;
  }): void {
    const clean = (s: string) => s.replace(/[;\n\r]/g, ' ');
    const line = [
      new Date().toISOString(),
      row.mode,
      row.action,
      clean(row.symbol),
      row.mint,
      row.sol.toFixed(9),
      row.tokenRaw,
      row.pnlSol === undefined ? '' : row.pnlSol.toFixed(9),
      clean(row.reason),
      row.signature ?? '',
    ].join(';');
    fs.appendFileSync(this.file, line + '\n');
  }
}

/**
 * Verhindert, dass Bot und Notverkauf gleichzeitig laufen und sich
 * gegenseitig den Zustand überschreiben.
 */
export function acquireLock(dataDir: string): () => void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'bot.lock');
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (e) {
        alive = (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    }
    if (alive) throw new Error(`Der Bot läuft bereits (Prozess ${pid}). Bitte zuerst beenden (Strg+C).`);
  }
  fs.writeFileSync(file, String(process.pid));
  const release = () => {
    try {
      if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file);
    } catch {
      // bereits entfernt
    }
  };
  process.on('exit', release);
  return release;
}
