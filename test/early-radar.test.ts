import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { EarlyRadar } from '../src/early.js';
import type { JupiterClient, JupToken } from '../src/jupiter.js';

const MIN = 60_000;

function tok(id: string, createdAt: number, over: Partial<JupToken> = {}): JupToken {
  return {
    id,
    name: `Token ${id}`,
    symbol: id,
    createdAt: new Date(createdAt).toISOString(),
    holderCount: 300,
    mcap: 100_000,
    liquidity: 20_000,
    organicScore: 30,
    twitter: 'x',
    website: 'w',
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, devBalancePercentage: 1, topHoldersPercentage: 15, devMints: 1 },
    stats5m: { numTraders: 50, numNetBuyers: 40 },
    stats1h: { buyVolume: 20_000, sellVolume: 5000 },
    ...over,
  };
}

function setup(tokens: () => JupToken[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'early-'));
  const cfg = loadConfig({ DATA_DIR: dir, EARLY_STREAM: 'false', TREND_ENABLED: 'false' });
  const fakeJup = {
    recentTokens: async () => tokens(),
    tokensByMint: async (mints: string[]) => tokens().filter((t) => mints.includes(t.id)),
  } as unknown as JupiterClient;
  const radar = new EarlyRadar(cfg, fakeJup, undefined);
  const csv = () => fs.readFileSync(path.join(dir, 'fruehphase.csv'), 'utf8').trim().split('\n').slice(1);
  return { radar, csv };
}

describe('Frühphasen-Radar (Ablauf)', () => {
  it('bewertet junge Coins erst nach der Mindest-Beobachtungszeit', async () => {
    const t0 = Date.now();
    // Name mit GTA-6-Bezug (Standard-Stichwort) -> Narrativ-Punkte
    const { radar, csv } = setup(() => [tok('YOUNG', t0 - 2 * MIN, { name: 'GTA6 Cat' })]);
    assert.equal((await radar.evaluate(t0)).length, 0); // 2 min alt -> warten
    assert.equal(csv().length, 0);
    const c = await radar.evaluate(t0 + 4 * MIN); // jetzt 6 min alt
    assert.equal(csv().filter((l) => l.includes(';BEWERTUNG;YOUNG;')).length, 1);
    assert.equal(c.length, 1, 'gesunder Coin mit gutem Score ist Kandidat');
  });

  it('Coins ohne Trend- oder Nischenbezug erreichen die Kaufschwelle nicht', async () => {
    const t0 = Date.now();
    const { radar } = setup(() => [tok('PLAIN', t0 - 6 * MIN)]);
    assert.equal((await radar.evaluate(t0)).length, 0);
    const s = radar.snapshot()[0]!.score!;
    assert.equal(s.narrative, 0);
    assert.ok(s.total < 60, `Score ${s.total}`);
  });

  it('ignoriert alte Coins (z. B. aus dem Migrations-Stream)', async () => {
    const t0 = Date.now();
    const { radar, csv } = setup(() => [tok('OLD', t0 - 500 * 24 * 60 * MIN)]);
    assert.equal((await radar.evaluate(t0)).length, 0);
    assert.equal(csv().length, 0);
    assert.equal(radar.size, 0);
  });

  it('schreibt Messpunkte nach 15 und 60 Minuten', async () => {
    const t0 = Date.now();
    let mcap = 100_000;
    const { radar, csv } = setup(() => [tok('M', t0 - 6 * MIN, { mcap })]);
    await radar.evaluate(t0);
    mcap = 250_000;
    await radar.evaluate(t0 + 16 * MIN);
    await radar.evaluate(t0 + 61 * MIN);
    const lines = csv();
    assert.ok(lines.some((l) => l.includes(';NACH15;M;') && l.includes(';150.0;')), lines.join('\n'));
    assert.ok(lines.some((l) => l.includes(';NACH60;M;')));
  });

  it('markiert verschwundene Coins als Totalverlust in der Messung', async () => {
    const t0 = Date.now();
    let alive = true;
    const { radar, csv } = setup(() => (alive ? [tok('R', t0 - 6 * MIN)] : []));
    await radar.evaluate(t0);
    alive = false;
    await radar.evaluate(t0 + 16 * MIN);
    assert.ok(csv().some((l) => l.includes(';NACH15_VERSCHWUNDEN;R;') && l.includes(';-100.0;')));
  });

  it('kauft keine Coins mit Betrugsmustern, misst sie aber trotzdem', async () => {
    const t0 = Date.now();
    const { radar, csv } = setup(() => [tok('SCAM', t0 - 6 * MIN, { audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, devBalancePercentage: 60 } })]);
    assert.equal((await radar.evaluate(t0)).length, 0);
    assert.ok(csv().some((l) => l.includes(';BEWERTUNG;SCAM;') && l.includes('Entwickler hält')));
  });
});
