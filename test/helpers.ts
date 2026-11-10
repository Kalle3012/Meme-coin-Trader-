import { loadConfig, type Config } from '../src/config.js';
import type { DexPair } from '../src/dexscreener.js';
import type { RugReport } from '../src/rugcheck.js';
import type { Position } from '../src/state.js';

export const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

export function cfg(overrides: Record<string, string> = {}): Config {
  return loadConfig({ ...overrides });
}

export function goodPair(over: Partial<DexPair> = {}): DexPair {
  return {
    chainId: 'solana',
    dexId: 'pumpswap',
    pairAddress: 'PAIR111',
    baseToken: { address: 'MINT111', name: 'Test', symbol: 'TEST' },
    quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', symbol: 'SOL' },
    priceUsd: '0.001',
    txns: { m5: { buys: 30, sells: 20 }, h1: { buys: 300, sells: 200 }, h6: { buys: 1000, sells: 900 }, h24: { buys: 3000, sells: 2800 } },
    volume: { m5: 5000, h1: 50_000, h6: 200_000, h24: 600_000 },
    priceChange: { m5: 1, h1: 20, h6: 40, h24: 80 },
    liquidity: { usd: 60_000, base: 1, quote: 1 },
    fdv: 500_000,
    marketCap: 500_000,
    pairCreatedAt: NOW - 5 * 3_600_000,
    info: { websites: [{ url: 'https://example.org' }], socials: [{ type: 'twitter', url: 'https://x.com/test' }] },
    ...over,
  };
}

export function goodReport(over: Partial<RugReport> = {}): RugReport {
  const holders = Array.from({ length: 10 }, (_, i) => ({ address: `H${i}`, owner: `O${i}`, pct: 2, insider: false }));
  return {
    mint: 'MINT111',
    mintAuthority: null,
    freezeAuthority: null,
    token: { supply: 1_000_000, decimals: 6, mintAuthority: null, freezeAuthority: null },
    topHolders: [{ address: 'POOLVAULT', owner: 'POOL', pct: 40 }, ...holders],
    knownAccounts: { POOL: { name: 'Pump Fun AMM', type: 'AMM' } },
    risks: [{ name: 'Low amount of LP Providers', value: '', description: '', score: 100, level: 'warn' }],
    score: 500,
    score_normalised: 5,
    totalHolders: 1500,
    rugged: false,
    transferFee: { pct: 0 },
    insiderNetworks: [],
    ...over,
  };
}

export function position(over: Partial<Position> = {}): Position {
  return {
    mint: 'MINT111',
    symbol: 'TEST',
    openedAt: NOW - 10 * 60_000,
    entryLamports: '100000000', // 0,1 SOL
    initialTokenRaw: '1000000',
    tokenRaw: '1000000',
    realizedLamports: '0',
    peakRatio: 1,
    tookProfit: false,
    ...over,
  };
}
