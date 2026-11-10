import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { ConfigError, DEFAULT_TREND_KEYWORDS, LIVE_CONFIRM_PHRASE, loadConfig } from '../config.js';
import { setEnvValues } from '../envfile.js';
import { lamportsToSol, loadKeypair } from '../wallet.js';

/**
 * Einrichtungsassistent: schreibt die .env-Datei, damit nichts von Hand
 * bearbeitet werden muss. Der private Schlüssel wird unsichtbar eingegeben,
 * geprüft und nur lokal in der .env gespeichert.
 */

const ENV_FILE = path.resolve('.env');
const EXAMPLE_FILE = path.resolve('.env.example');
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

function readEnvFile(): string {
  if (!fs.existsSync(ENV_FILE)) {
    if (!fs.existsSync(EXAMPLE_FILE)) throw new Error('.env.example fehlt – bitte den Bot-Ordner vollständig herunterladen.');
    fs.copyFileSync(EXAMPLE_FILE, ENV_FILE);
    console.log('.env wurde aus der Vorlage erstellt.');
  }
  return fs.readFileSync(ENV_FILE, 'utf8');
}

function currentEnv(): Record<string, string> {
  return dotenv.parse(readEnvFile());
}

function save(values: Record<string, string | null>): void {
  fs.writeFileSync(ENV_FILE, setEnvValues(readEnvFile(), values));
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Eingabe ohne Anzeige (für den privaten Schlüssel). Einfügen mit Rechtsklick / Strg+V funktioniert. */
async function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(question);
  process.stdout.write(question);
  return new Promise((resolve) => {
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      const text = chunk.replace(/\x1b\[20[01]~/g, ''); // "bracketed paste"-Markierungen entfernen
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(buf.trim());
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.stdout.write('\nAbgebrochen.\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue;
        buf += ch;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

async function askYesNo(question: string): Promise<boolean> {
  for (;;) {
    const a = (await ask(`${question} (j/n): `)).toLowerCase();
    if (['j', 'ja', 'y', 'yes'].includes(a)) return true;
    if (['n', 'nein', 'no'].includes(a)) return false;
  }
}

function isValidAddress(addr: string): boolean {
  try {
    if (bs58.decode(addr).length !== 32) return false;
    new PublicKey(addr);
    return true;
  } catch {
    return false;
  }
}

async function balanceOf(address: string, rpcUrl: string): Promise<number | null> {
  try {
    const conn = new Connection(rpcUrl, 'confirmed');
    return lamportsToSol(await conn.getBalance(new PublicKey(address)));
  } catch {
    return null;
  }
}

function showStatus(): void {
  const env = currentEnv();
  const live = env.DRY_RUN?.trim().toLowerCase() === 'false';
  console.log('\n----------------------------------------------');
  console.log(` Modus:          ${live ? 'LIVE (echtes Geld)' : 'Papier (simuliert)'}`);
  console.log(` Wallet:         ${env.EXPECTED_WALLET_ADDRESS || (env.PRIVATE_KEY ? 'Schlüssel gesetzt' : 'nicht verbunden')}`);
  let rpcHost = 'Standard (öffentlich)';
  try {
    if (env.RPC_URL) rpcHost = new URL(env.RPC_URL).host;
  } catch {
    rpcHost = 'ungültig – bitte neu eintragen';
  }
  console.log(` RPC:            ${rpcHost}`);
  console.log(` Jupiter-Key:    ${env.JUPITER_API_KEY ? 'gesetzt' : 'nicht gesetzt (optional)'}`);
  console.log(` Kaufbetrag:     ${env.BUY_AMOUNT_SOL || '0.05'} SOL, max. ${env.MAX_OPEN_POSITIONS || '3'} Positionen`);
  const trendOn = env.TREND_ENABLED?.trim().toLowerCase() !== 'false';
  const trendOnly = env.TREND_ONLY?.trim().toLowerCase() === 'true';
  console.log(
    ` Trend-Radar:    ${trendOn ? (trendOnly ? 'an – kauft NUR Trend-Coins' : 'an') : 'aus'}` +
      (trendOn ? ` (${env.TREND_KEYWORDS?.trim() || DEFAULT_TREND_KEYWORDS})` : ''),
  );
  console.log('----------------------------------------------');
}

// ------------------------------------------------------------------ Aktionen

async function connectWallet(): Promise<void> {
  console.log('\n=== Wallet verbinden ===');
  console.log('Verwende NUR ein separates Bot-Konto aus Phantom mit wenig Guthaben.');
  console.log('NIEMALS die Seed-Phrase (12/24 Wörter) und NIEMALS dein Hauptkonto!\n');

  const address = await ask('1) Öffentliche Adresse des Bot-Kontos (in Phantom kopieren, hier einfügen): ');
  if (!isValidAddress(address)) {
    console.log('-> Das ist keine gültige Solana-Adresse. Nichts gespeichert.');
    return;
  }
  console.log('\n2) Privater Schlüssel des Bot-Kontos:');
  console.log('   Phantom -> Einstellungen -> Konten verwalten -> Bot-Konto -> "Privaten Schlüssel anzeigen"');
  const key = await askHidden('   Hier einfügen (Rechtsklick oder Strg+V), die Eingabe bleibt unsichtbar, dann Enter: ');
  if (!key) {
    console.log('-> Keine Eingabe. Nichts gespeichert.');
    return;
  }

  let derived: string;
  try {
    derived = (await loadKeypair(key)).publicKey.toBase58();
  } catch (e) {
    console.log(`-> ${e instanceof Error ? e.message : String(e)}\n   Nichts gespeichert.`);
    return;
  }
  if (derived !== address) {
    console.log(`-> Der Schlüssel gehört zur Adresse ${derived},`);
    console.log(`   eingegeben wurde aber ${address}. Falsches Konto? Nichts gespeichert.`);
    return;
  }

  save({ PRIVATE_KEY: key, EXPECTED_WALLET_ADDRESS: address });
  console.log(`\n✔ Wallet verbunden und gespeichert: ${address}`);
  const rpc = currentEnv().RPC_URL || DEFAULT_RPC;
  const bal = await balanceOf(address, rpc);
  console.log(bal === null ? '  (Guthaben konnte gerade nicht abgefragt werden.)' : `  Guthaben: ${bal.toFixed(4)} SOL`);
}

async function setRpcAndKeys(): Promise<void> {
  console.log('\n=== RPC & Jupiter-Key (optional, empfohlen für Live-Betrieb) ===');
  console.log('RPC-URL z. B. kostenlos von helius.dev ("Mainnet RPC URL"). Enter = unverändert.');
  const rpc = await ask('RPC-URL: ');
  if (rpc) {
    if (!/^https:\/\//.test(rpc)) {
      console.log('-> Die URL muss mit https:// beginnen. Nicht gespeichert.');
    } else {
      try {
        await new Connection(rpc, 'confirmed').getSlot();
        save({ RPC_URL: rpc });
        console.log('✔ RPC funktioniert und wurde gespeichert.');
      } catch (e) {
        console.log(`-> RPC antwortet nicht (${e instanceof Error ? e.message : String(e)}). Nicht gespeichert.`);
      }
    }
  }

  console.log('\nJupiter-API-Key kostenlos von portal.jup.ag. Enter = unverändert.');
  const jk = await askHidden('Jupiter-API-Key (unsichtbar): ');
  if (jk) {
    try {
      const res = await fetch('https://api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112', {
        headers: { 'x-api-key': jk },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401 || res.status === 403) {
        console.log('-> Jupiter lehnt diesen Key ab. Nicht gespeichert.');
      } else {
        save({ JUPITER_API_KEY: jk, JUPITER_RPS: '1' });
        console.log('✔ Jupiter-Key gespeichert.');
      }
    } catch {
      console.log('-> Jupiter nicht erreichbar, Key konnte nicht geprüft werden. Nicht gespeichert.');
    }
  }
}

async function enableLive(): Promise<void> {
  console.log('\n=== Live-Handel einschalten ===');
  const env = currentEnv();
  if (!env.PRIVATE_KEY || !env.EXPECTED_WALLET_ADDRESS) {
    console.log('-> Zuerst die Wallet verbinden (Menüpunkt 1).');
    return;
  }
  try {
    const derived = (await loadKeypair(env.PRIVATE_KEY)).publicKey.toBase58();
    if (derived !== env.EXPECTED_WALLET_ADDRESS) throw new Error('Schlüssel passt nicht zur Adresse');
  } catch (e) {
    console.log(`-> Gespeicherte Wallet ist ungültig (${e instanceof Error ? e.message : String(e)}). Bitte neu verbinden.`);
    return;
  }

  console.log('Empfehlung für den Anfang: kleine Beträge. Enter übernimmt den Vorschlag in [Klammern].');
  // Vorschlag: bereits gespeicherter Wert, sonst vorsichtiger Startwert (statt der Vorlage-Standardwerte).
  const pick = (key: string, templateDefault: string, safe: string) => {
    const v = env[key]?.trim();
    return v && v !== templateDefault ? v : safe;
  };
  const dBuy = pick('BUY_AMOUNT_SOL', '0.05', '0.02');
  const dPos = pick('MAX_OPEN_POSITIONS', '3', '2');
  const dLoss = pick('MAX_DAILY_LOSS_SOL', '0.15', '0.06');
  const buy = (await ask(`SOL pro Kauf [${dBuy}]: `)) || dBuy;
  const maxPos = (await ask(`Maximal gleichzeitig offene Positionen [${dPos}]: `)) || dPos;
  const dayLoss = (await ask(`Tagesverlust-Limit in SOL, danach kein Kauf mehr bis morgen [${dLoss}]: `)) || dLoss;

  const candidate = {
    ...env,
    DRY_RUN: 'false',
    LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE,
    BUY_AMOUNT_SOL: buy.replace(',', '.'),
    MAX_OPEN_POSITIONS: maxPos,
    MAX_DAILY_LOSS_SOL: dayLoss.replace(',', '.'),
  };
  let cfg;
  try {
    cfg = loadConfig(candidate);
  } catch (e) {
    console.log(`-> ${e instanceof ConfigError ? e.message : String(e)}\n   Nichts gespeichert.`);
    return;
  }

  const bal = await balanceOf(env.EXPECTED_WALLET_ADDRESS, cfg.rpcUrl);
  const needed = cfg.buyAmountSol + cfg.minSolReserve;
  if (bal !== null) {
    console.log(`Guthaben des Bot-Kontos: ${bal.toFixed(4)} SOL`);
    if (bal < needed) console.log(`ACHTUNG: Für einen Kauf werden mind. ${needed.toFixed(3)} SOL benötigt. Bitte Bot-Konto in Phantom aufladen.`);
  }

  console.log('\nRISIKO: Meme-Coins können in Minuten wertlos werden. Du kannst das gesamte Guthaben');
  console.log('des Bot-Kontos verlieren. Der Bot kann keine Gewinne garantieren.');
  const confirm = await ask(`Zum Bestätigen exakt ${LIVE_CONFIRM_PHRASE} eintippen: `);
  if (confirm !== LIVE_CONFIRM_PHRASE) {
    console.log('-> Nicht bestätigt. Bleibt im Papiermodus.');
    return;
  }
  save({
    DRY_RUN: 'false',
    LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE,
    BUY_AMOUNT_SOL: candidate.BUY_AMOUNT_SOL,
    MAX_OPEN_POSITIONS: candidate.MAX_OPEN_POSITIONS,
    MAX_DAILY_LOSS_SOL: candidate.MAX_DAILY_LOSS_SOL,
  });
  console.log('✔ LIVE-Handel ist eingeschaltet. Starte den Bot mit 3_BOT_STARTEN.bat bzw. "npm start".');
}

async function configureTrends(): Promise<void> {
  console.log('\n=== Trend-Radar ===');
  console.log('Der Bot durchsucht Google News, Google Trends, Wikipedia, CoinGecko und DexScreener');
  console.log('und bevorzugt Meme-Coins, die zu aktuellen Trends und deinen Stichwörtern passen.');
  console.log('Alle Sicherheitsprüfungen gelten trotzdem – Trend-Coins sind oft Kopien oder Betrug.\n');
  const env = currentEnv();
  const on = await askYesNo('Trend-Radar einschalten?');
  if (!on) {
    save({ TREND_ENABLED: 'false', TREND_ONLY: 'false' });
    console.log('✔ Trend-Radar ausgeschaltet.');
    return;
  }
  const current = env.TREND_KEYWORDS?.trim() || DEFAULT_TREND_KEYWORDS;
  console.log(`\nAktuelle Stichwörter: ${current}`);
  console.log('Neue Stichwörter mit Komma getrennt eingeben (z. B. gta6,gta 6,vice city). Enter = unverändert.');
  const kws = await ask('Stichwörter: ');
  const only = await askYesNo('NUR Trend-Coins kaufen (alle anderen ignorieren)?');
  const values: Record<string, string> = { TREND_ENABLED: 'true', TREND_ONLY: only ? 'true' : 'false' };
  if (kws) {
    values.TREND_KEYWORDS = [...new Set(kws.split(',').map((k) => k.trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean))].join(',');
  }
  try {
    loadConfig({ ...env, ...values });
  } catch (e) {
    console.log(`-> ${e instanceof ConfigError ? e.message : String(e)}\n   Nichts gespeichert.`);
    return;
  }
  save(values);
  console.log('✔ Trend-Radar gespeichert. Mit TRENDS_ANZEIGEN.bat bzw. "npm run trends" siehst du, was er findet.');
}

async function enablePaper(): Promise<void> {
  save({ DRY_RUN: 'true', LIVE_TRADING_CONFIRM: null });
  console.log('✔ Papiermodus eingeschaltet (kein echtes Geld).');
}

async function main(): Promise<void> {
  console.log('==============================================');
  console.log('   Meme-Coin-Trader – Einrichtungsassistent');
  console.log('==============================================');
  readEnvFile();

  for (;;) {
    showStatus();
    console.log(' [1] Phantom-Bot-Konto verbinden');
    console.log(' [2] RPC-URL / Jupiter-API-Key eintragen (optional)');
    console.log(' [3] LIVE-Handel einschalten (echtes Geld)');
    console.log(' [4] Zurück in den Papiermodus');
    console.log(' [5] Wallet-Verbindung entfernen');
    console.log(' [6] Trend-Radar einstellen (z. B. GTA 6)');
    console.log(' [0] Beenden');
    const choice = await ask('Auswahl: ');
    switch (choice) {
      case '1':
        await connectWallet();
        break;
      case '2':
        await setRpcAndKeys();
        break;
      case '3':
        await enableLive();
        break;
      case '4':
        await enablePaper();
        break;
      case '5':
        if (await askYesNo('Schlüssel wirklich aus der .env entfernen?')) {
          save({ PRIVATE_KEY: '', EXPECTED_WALLET_ADDRESS: '', DRY_RUN: 'true', LIVE_TRADING_CONFIRM: null });
          console.log('✔ Wallet entfernt, Papiermodus aktiv.');
        }
        break;
      case '6':
        await configureTrends();
        break;
      case '':
        break;
      case '0':
        console.log('Einstellungen gespeichert in .env. Tschüss!');
        return;
      default:
        console.log('Bitte 0–6 eingeben.');
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
