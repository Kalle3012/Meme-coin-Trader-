import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import dotenv from 'dotenv';
import { formatEnvValue, setEnvValues } from '../src/envfile.js';

const TEMPLATE = `# Kommentar
DRY_RUN=true
# LIVE_TRADING_CONFIRM=ICH_VERSTEHE_DAS_RISIKO
PRIVATE_KEY=
RPC_URL=https://api.mainnet-beta.solana.com
`;

describe('.env bearbeiten', () => {
  it('ersetzt bestehende Werte und behält Kommentare', () => {
    const out = setEnvValues(TEMPLATE, { DRY_RUN: 'false', PRIVATE_KEY: 'abc123' });
    assert.match(out, /^# Kommentar$/m);
    const env = dotenv.parse(out);
    assert.equal(env.DRY_RUN, 'false');
    assert.equal(env.PRIVATE_KEY, 'abc123');
  });

  it('aktiviert auskommentierte Vorlage-Zeilen', () => {
    const out = setEnvValues(TEMPLATE, { LIVE_TRADING_CONFIRM: 'ICH_VERSTEHE_DAS_RISIKO' });
    assert.equal(dotenv.parse(out).LIVE_TRADING_CONFIRM, 'ICH_VERSTEHE_DAS_RISIKO');
    assert.equal(out.match(/LIVE_TRADING_CONFIRM/g)?.length, 1);
  });

  it('deaktiviert Werte mit null', () => {
    const on = setEnvValues(TEMPLATE, { LIVE_TRADING_CONFIRM: 'ICH_VERSTEHE_DAS_RISIKO' });
    const off = setEnvValues(on, { LIVE_TRADING_CONFIRM: null });
    assert.equal(dotenv.parse(off).LIVE_TRADING_CONFIRM, undefined);
  });

  it('hängt unbekannte Schlüssel an', () => {
    assert.equal(dotenv.parse(setEnvValues(TEMPLATE, { JUPITER_RPS: '1' })).JUPITER_RPS, '1');
  });

  it('erhält Windows-Zeilenenden', () => {
    const out = setEnvValues(TEMPLATE.replace(/\n/g, '\r\n'), { DRY_RUN: 'false' });
    assert.ok(out.includes('DRY_RUN=false\r\n'));
    assert.ok(!/[^\r]\n/.test(out));
  });

  it('entfernt doppelte aktive Einträge', () => {
    const out = setEnvValues('A=1\nA=2\n', { A: '3' });
    assert.equal(out, 'A=3\n');
  });

  it('formatiert Sonderzeichen so, dass dotenv sie exakt liest', () => {
    for (const v of ['https://x.y/?api-key=a&b=c', 'mit leerzeichen', 'hash#tag', '[1,2,3]', 'a"b']) {
      assert.equal(dotenv.parse(`K=${formatEnvValue(v)}\n`).K, v);
    }
    assert.throws(() => formatEnvValue('a\nb'));
  });
});
