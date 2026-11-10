import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { ConfigError, LIVE_CONFIRM_PHRASE, loadConfig, redactConfig } from '../src/config.js';
import { loadKeypair } from '../src/wallet.js';

describe('Konfiguration', () => {
  it('startet standardmäßig im Papiermodus', () => {
    assert.equal(loadConfig({}).dryRun, true);
  });

  it('Live-Modus nur mit Bestätigungsphrase', () => {
    assert.throws(() => loadConfig({ DRY_RUN: 'false', PRIVATE_KEY: 'x' }), ConfigError);
    const c = loadConfig({ DRY_RUN: 'false', PRIVATE_KEY: 'x', LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE });
    assert.equal(c.dryRun, false);
  });

  it('Live-Modus nur mit Schlüssel', () => {
    assert.throws(() => loadConfig({ DRY_RUN: 'false', LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE }), /PRIVATE_KEY/);
  });

  it('lehnt ungültige Werte ab', () => {
    assert.throws(() => loadConfig({ BUY_AMOUNT_SOL: 'abc' }), ConfigError);
    assert.throws(() => loadConfig({ STOP_LOSS_PCT: '0' }), ConfigError);
    assert.throws(() => loadConfig({ MAX_OPEN_POSITIONS: '1.5' }), ConfigError);
    assert.throws(() => loadConfig({ DRY_RUN: 'vielleicht' }), ConfigError);
    assert.throws(() => loadConfig({ MIN_MARKET_CAP_USD: '10', MAX_MARKET_CAP_USD: '5' }), ConfigError);
  });

  it('gibt den Schlüssel nie im Klartext aus', () => {
    const r = redactConfig(loadConfig({ PRIVATE_KEY: 'GEHEIM', JUPITER_API_KEY: 'AUCHGEHEIM' }));
    assert.ok(!JSON.stringify(r).includes('GEHEIM'));
  });
});

describe('Wallet-Import (Phantom-Format)', () => {
  it('liest Base58-Schlüssel wie aus Phantom exportiert', async () => {
    const kp = await Keypair.generate();
    const loaded = await loadKeypair(bs58.encode(kp.secretKey));
    assert.equal(loaded.publicKey.toBase58(), kp.publicKey.toBase58());
  });

  it('liest JSON-Array (solana-keygen-Format)', async () => {
    const kp = await Keypair.generate();
    const loaded = await loadKeypair(JSON.stringify(Array.from(kp.secretKey)));
    assert.equal(loaded.publicKey.toBase58(), kp.publicKey.toBase58());
  });

  it('weist Seed-Phrasen ab', async () => {
    const phrase = 'apple banana cherry dog eagle fish grape house island jungle kite lemon';
    await assert.rejects(loadKeypair(phrase), /Seed-Phrase/);
  });

  it('weist falsche Längen und Müll ab', async () => {
    await assert.rejects(loadKeypair(bs58.encode(new Uint8Array(32))), /64/);
    await assert.rejects(loadKeypair('0OIl'), /Base58/);
    await assert.rejects(loadKeypair('[1,2,300]'), /Bytes/);
  });

  it('weist Schlüssel ab, deren öffentlicher Teil nicht passt', async () => {
    const a = await Keypair.generate();
    const b = await Keypair.generate();
    const bad = new Uint8Array(64);
    bad.set(a.secretKey.slice(0, 32), 0);
    bad.set(b.publicKey.toBytes(), 32);
    await assert.rejects(loadKeypair(bs58.encode(bad)), /ungültig/);
  });
});
