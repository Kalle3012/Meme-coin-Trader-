import { Connection } from '@solana/web3.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { errMsg, log, setLogDir } from './logger.js';
import { Wallet, loadKeypair } from './wallet.js';

/** Gemeinsamer Start für Bot und Skripte: Konfiguration + Wallet laden und prüfen. */
export async function setup(opts: { requireWallet?: boolean } = {}): Promise<{ cfg: Config; wallet: Wallet | undefined }> {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`Konfigurationsfehler: ${e.message}\nBitte .env prüfen (Vorlage: .env.example).`);
      process.exit(1);
    }
    throw e;
  }
  setLogDir(cfg.dataDir);

  let wallet: Wallet | undefined;
  if (cfg.privateKey) {
    try {
      const kp = await loadKeypair(cfg.privateKey);
      wallet = new Wallet(kp, new Connection(cfg.rpcUrl, 'confirmed'));
    } catch (e) {
      console.error(`Wallet-Fehler: ${errMsg(e)}`);
      process.exit(1);
    }
    if (cfg.expectedWalletAddress && cfg.expectedWalletAddress !== wallet.address) {
      console.error(
        `Wallet-Fehler: Der Schlüssel gehört zu ${wallet.address}, erwartet war EXPECTED_WALLET_ADDRESS=${cfg.expectedWalletAddress}.`,
      );
      process.exit(1);
    }
  } else if (opts.requireWallet || !cfg.dryRun) {
    console.error('PRIVATE_KEY fehlt in der .env-Datei.');
    process.exit(1);
  }

  if (wallet) log.info(`Wallet: ${wallet.address} (vergleiche diese Adresse mit deinem Bot-Konto in Phantom)`);
  return { cfg, wallet };
}
