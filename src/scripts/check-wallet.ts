import { setup } from '../setup.js';
import { lamportsToSol } from '../wallet.js';

/** Prüft nur die Wallet-Verbindung. Handelt NICHT. */
async function main(): Promise<void> {
  const { cfg, wallet } = await setup({ requireWallet: true });
  if (!wallet) return;
  const bal = await wallet.solBalanceLamports();
  console.log('');
  console.log(`Adresse:   ${wallet.address}`);
  console.log(`Guthaben:  ${lamportsToSol(bal).toFixed(6)} SOL`);
  console.log(`RPC:       ${new URL(cfg.rpcUrl).host}`);
  console.log(`Modus:     ${cfg.dryRun ? 'Papier (DRY_RUN=true)' : 'LIVE'}`);
  const needed = cfg.buyAmountSol + cfg.minSolReserve;
  if (lamportsToSol(bal) < needed) {
    console.log(`\nHinweis: Für einen Kauf werden mindestens ${needed} SOL benötigt (Kaufbetrag + Reserve).`);
  }
  console.log('\nVergleiche die Adresse mit dem Bot-Konto in Phantom. Stimmen sie überein, ist die Verbindung korrekt.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
