import dotenv from 'dotenv';

dotenv.config({ quiet: true });

/**
 * Zentrale Konfiguration. Alle Werte kommen aus der .env-Datei
 * (siehe .env.example). Jeder Wert wird beim Start geprüft, damit der Bot
 * nie mit unsinnigen Einstellungen echtes Geld handelt.
 */

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const LAMPORTS_PER_SOL = 1_000_000_000;
export const LIVE_CONFIRM_PHRASE = 'ICH_VERSTEHE_DAS_RISIKO';
/** GTA 6: Titel, Schreibweisen, Spielort (Vice City im Bundesstaat Leonida) und Hauptfigur Lucia. */
export const DEFAULT_TREND_KEYWORDS = 'gta6,gta 6,gta vi,vice city,leonida,lucia';

export interface Config {
  // Wallet & Verbindung
  privateKey: string | undefined;
  expectedWalletAddress: string | undefined;
  rpcUrl: string;
  jupiterApiKey: string | undefined;
  jupiterRps: number;

  // Modus
  dryRun: boolean;
  paperStartSol: number;
  paperFeeSol: number;
  dataDir: string;

  // Positionsgröße & Risiko
  buyAmountSol: number;
  maxOpenPositions: number;
  minSolReserve: number;
  maxDailyLossSol: number;
  maxTradesPerDay: number;
  slippageBps: number; // 0 = Jupiter wählt automatisch
  maxPriceImpactPct: number;
  maxRoundtripLossPct: number;

  // Markt-Filter (DexScreener)
  minLiquidityUsd: number;
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  minPairAgeMinutes: number;
  maxPairAgeHours: number;
  minVolumeH1Usd: number;
  minTxnsH1: number;
  minBuySellRatioH1: number;
  minPriceChangeH1Pct: number;
  maxPriceChangeH1Pct: number;
  minPriceChangeM5Pct: number;
  requireSocials: boolean;

  // Sicherheits-Filter (RugCheck)
  maxRugcheckScore: number;
  maxTop10HolderPct: number;
  maxSingleHolderPct: number;
  maxInsiderPct: number;
  minHolders: number;
  rejectDangerRisks: boolean;

  // Ausstieg
  takeProfitPct: number;
  takeProfitSellFraction: number;
  stopLossPct: number;
  trailingStopPct: number;
  trailingActivationPct: number;
  maxHoldMinutes: number;

  // Trend-Radar
  trendEnabled: boolean;
  trendKeywords: string[];
  trendOnly: boolean;
  trendInternetSources: boolean;
  trendGeos: string[];
  trendRefreshMin: number;
  trendMaxSearches: number;
  trendMaxPairAgeHours: number;
  trendMaxMarketCapUsd: number;

  // Timing
  scanIntervalSec: number;
  positionCheckIntervalSec: number;
  maxSafetyChecksPerScan: number;
  rebuyCooldownHours: number;
}

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

function num(env: Env, key: string, def: number, opts: { min?: number; max?: number; int?: boolean } = {}): number {
  const raw = env[key];
  const value = raw === undefined || raw.trim() === '' ? def : Number(raw.trim());
  if (!Number.isFinite(value)) throw new ConfigError(`${key} ist keine gültige Zahl: "${raw}"`);
  if (opts.int && !Number.isInteger(value)) throw new ConfigError(`${key} muss eine ganze Zahl sein: ${value}`);
  if (opts.min !== undefined && value < opts.min) throw new ConfigError(`${key} muss >= ${opts.min} sein (ist ${value})`);
  if (opts.max !== undefined && value > opts.max) throw new ConfigError(`${key} muss <= ${opts.max} sein (ist ${value})`);
  return value;
}

function bool(env: Env, key: string, def: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return def;
  if (['true', '1', 'yes', 'ja'].includes(raw)) return true;
  if (['false', '0', 'no', 'nein'].includes(raw)) return false;
  throw new ConfigError(`${key} muss true oder false sein (ist "${env[key]}")`);
}

function list(env: Env, key: string, def: string): string[] {
  const raw = env[key] ?? def;
  return [...new Set(raw.split(',').map((x) => x.trim().toLowerCase()).filter((x) => x.length > 0))];
}

function str(env: Env, key: string): string | undefined {
  const raw = env[key]?.trim();
  return raw ? raw : undefined;
}

export function loadConfig(env: Env = process.env): Config {
  const dryRun = bool(env, 'DRY_RUN', true);

  const cfg: Config = {
    privateKey: str(env, 'PRIVATE_KEY'),
    expectedWalletAddress: str(env, 'EXPECTED_WALLET_ADDRESS'),
    rpcUrl: str(env, 'RPC_URL') ?? 'https://api.mainnet-beta.solana.com',
    jupiterApiKey: str(env, 'JUPITER_API_KEY'),
    jupiterRps: num(env, 'JUPITER_RPS', str(env, 'JUPITER_API_KEY') ? 1 : 0.5, { min: 0.1, max: 150 }),

    dryRun,
    paperStartSol: num(env, 'PAPER_START_SOL', 1, { min: 0 }),
    paperFeeSol: num(env, 'PAPER_FEE_SOL', 0.0001, { min: 0 }),
    dataDir: str(env, 'DATA_DIR') ?? 'data',

    buyAmountSol: num(env, 'BUY_AMOUNT_SOL', 0.05, { min: 0.001, max: 100 }),
    maxOpenPositions: num(env, 'MAX_OPEN_POSITIONS', 3, { min: 1, max: 20, int: true }),
    minSolReserve: num(env, 'MIN_SOL_RESERVE', 0.05, { min: 0.01 }),
    maxDailyLossSol: num(env, 'MAX_DAILY_LOSS_SOL', 0.15, { min: 0.001 }),
    maxTradesPerDay: num(env, 'MAX_TRADES_PER_DAY', 15, { min: 1, int: true }),
    slippageBps: num(env, 'SLIPPAGE_BPS', 300, { min: 0, max: 5000, int: true }),
    maxPriceImpactPct: num(env, 'MAX_PRICE_IMPACT_PCT', 3, { min: 0.1, max: 50 }),
    maxRoundtripLossPct: num(env, 'MAX_ROUNDTRIP_LOSS_PCT', 8, { min: 0.5, max: 50 }),

    minLiquidityUsd: num(env, 'MIN_LIQUIDITY_USD', 25_000, { min: 0 }),
    minMarketCapUsd: num(env, 'MIN_MARKET_CAP_USD', 75_000, { min: 0 }),
    maxMarketCapUsd: num(env, 'MAX_MARKET_CAP_USD', 10_000_000, { min: 0 }),
    minPairAgeMinutes: num(env, 'MIN_PAIR_AGE_MINUTES', 60, { min: 0 }),
    maxPairAgeHours: num(env, 'MAX_PAIR_AGE_HOURS', 72, { min: 0 }),
    minVolumeH1Usd: num(env, 'MIN_VOLUME_H1_USD', 15_000, { min: 0 }),
    minTxnsH1: num(env, 'MIN_TXNS_H1', 150, { min: 0, int: true }),
    minBuySellRatioH1: num(env, 'MIN_BUY_SELL_RATIO_H1', 1.05, { min: 0 }),
    minPriceChangeH1Pct: num(env, 'MIN_PRICE_CHANGE_H1_PCT', 0),
    maxPriceChangeH1Pct: num(env, 'MAX_PRICE_CHANGE_H1_PCT', 100),
    minPriceChangeM5Pct: num(env, 'MIN_PRICE_CHANGE_M5_PCT', -3),
    requireSocials: bool(env, 'REQUIRE_SOCIALS', true),

    maxRugcheckScore: num(env, 'MAX_RUGCHECK_SCORE', 30, { min: 0, max: 100 }),
    maxTop10HolderPct: num(env, 'MAX_TOP10_HOLDER_PCT', 30, { min: 0, max: 100 }),
    maxSingleHolderPct: num(env, 'MAX_SINGLE_HOLDER_PCT', 8, { min: 0, max: 100 }),
    maxInsiderPct: num(env, 'MAX_INSIDER_PCT', 15, { min: 0, max: 100 }),
    minHolders: num(env, 'MIN_HOLDERS', 300, { min: 0, int: true }),
    rejectDangerRisks: bool(env, 'REJECT_DANGER_RISKS', true),

    takeProfitPct: num(env, 'TAKE_PROFIT_PCT', 50, { min: 1 }),
    takeProfitSellFraction: num(env, 'TAKE_PROFIT_SELL_FRACTION', 0.5, { min: 0.05, max: 1 }),
    stopLossPct: num(env, 'STOP_LOSS_PCT', 20, { min: 1, max: 95 }),
    trailingStopPct: num(env, 'TRAILING_STOP_PCT', 20, { min: 1, max: 95 }),
    trailingActivationPct: num(env, 'TRAILING_ACTIVATION_PCT', 25, { min: 0 }),
    maxHoldMinutes: num(env, 'MAX_HOLD_MINUTES', 180, { min: 1 }),

    trendEnabled: bool(env, 'TREND_ENABLED', true),
    trendKeywords: list(env, 'TREND_KEYWORDS', DEFAULT_TREND_KEYWORDS),
    trendOnly: bool(env, 'TREND_ONLY', false),
    trendInternetSources: bool(env, 'TREND_INTERNET_SOURCES', true),
    trendGeos: list(env, 'TREND_GEOS', 'US,DE').map((g) => g.toUpperCase()),
    trendRefreshMin: num(env, 'TREND_REFRESH_MIN', 15, { min: 5 }),
    trendMaxSearches: num(env, 'TREND_MAX_SEARCHES', 25, { min: 1, max: 100, int: true }),
    trendMaxPairAgeHours: num(env, 'TREND_MAX_PAIR_AGE_HOURS', 2160, { min: 1 }),
    trendMaxMarketCapUsd: num(env, 'TREND_MAX_MARKET_CAP_USD', 50_000_000, { min: 0 }),

    scanIntervalSec: num(env, 'SCAN_INTERVAL_SEC', 60, { min: 15 }),
    positionCheckIntervalSec: num(env, 'POSITION_CHECK_INTERVAL_SEC', 15, { min: 5 }),
    maxSafetyChecksPerScan: num(env, 'MAX_SAFETY_CHECKS_PER_SCAN', 4, { min: 1, max: 20, int: true }),
    rebuyCooldownHours: num(env, 'REBUY_COOLDOWN_HOURS', 24, { min: 0 }),
  };

  for (const kw of cfg.trendKeywords) {
    if (kw.replace(/[^a-z0-9]/g, '').length < 3) throw new ConfigError(`TREND_KEYWORDS: "${kw}" ist zu kurz (mind. 3 Buchstaben/Ziffern)`);
  }
  for (const g of cfg.trendGeos) {
    if (!/^[A-Z]{2}$/.test(g)) throw new ConfigError(`TREND_GEOS: "${g}" ist kein Ländercode (z. B. US, DE)`);
  }
  if (cfg.trendOnly && !cfg.trendEnabled) throw new ConfigError('TREND_ONLY=true erfordert TREND_ENABLED=true');

  if (cfg.minMarketCapUsd > cfg.maxMarketCapUsd) {
    throw new ConfigError('MIN_MARKET_CAP_USD darf nicht größer als MAX_MARKET_CAP_USD sein');
  }
  if (cfg.minPriceChangeH1Pct > cfg.maxPriceChangeH1Pct) {
    throw new ConfigError('MIN_PRICE_CHANGE_H1_PCT darf nicht größer als MAX_PRICE_CHANGE_H1_PCT sein');
  }
  if (cfg.minPairAgeMinutes > cfg.maxPairAgeHours * 60) {
    throw new ConfigError('MIN_PAIR_AGE_MINUTES darf nicht größer als MAX_PAIR_AGE_HOURS * 60 sein');
  }

  if (!dryRun) {
    if (str(env, 'LIVE_TRADING_CONFIRM') !== LIVE_CONFIRM_PHRASE) {
      throw new ConfigError(
        `Live-Trading (DRY_RUN=false) erfordert LIVE_TRADING_CONFIRM=${LIVE_CONFIRM_PHRASE} in der .env-Datei.`,
      );
    }
    if (!cfg.privateKey) throw new ConfigError('Live-Trading erfordert PRIVATE_KEY in der .env-Datei.');
    if (cfg.buyAmountSol > cfg.maxDailyLossSol * 10) {
      throw new ConfigError('BUY_AMOUNT_SOL ist im Verhältnis zu MAX_DAILY_LOSS_SOL unplausibel hoch (> 10x).');
    }
  }

  return cfg;
}

/** Konfiguration für Ausgaben ohne Geheimnisse. */
export function redactConfig(cfg: Config): Record<string, unknown> {
  const { privateKey, jupiterApiKey, ...rest } = cfg;
  return { ...rest, privateKey: privateKey ? '***gesetzt***' : 'nicht gesetzt', jupiterApiKey: jupiterApiKey ? '***gesetzt***' : 'nicht gesetzt' };
}
