import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Wallet-Anbindung.
 *
 * Phantom ist eine Browser-/App-Wallet: Jede Transaktion muss dort per Klick
 * bestätigt werden. Ein Bot, der rund um die Uhr selbstständig handelt, kann
 * deshalb nicht "über" die Phantom-Erweiterung signieren. Der übliche Weg
 * (so arbeiten auch alle seriösen Open-Source-Bots) ist:
 *   1. In Phantom ein NEUES, separates Konto anlegen ("Konto hinzufügen").
 *   2. Nur so viel SOL darauf überweisen, wie der Bot maximal verlieren darf.
 *   3. Für genau dieses Konto "Privaten Schlüssel anzeigen" -> in die .env kopieren.
 * Das Konto bleibt in Phantom sichtbar: Du siehst dort jeden Trade des Bots live.
 */

export async function loadKeypair(secret: string): Promise<Keypair> {
  const trimmed = secret.trim();
  if (/\s/.test(trimmed) && trimmed.split(/\s+/).length >= 12) {
    throw new Error(
      'PRIVATE_KEY sieht aus wie eine Seed-Phrase (Wiederherstellungsphrase). ' +
        'Bitte NIEMALS die Seed-Phrase verwenden! Exportiere in Phantom nur den privaten Schlüssel des separaten Bot-Kontos.',
    );
  }

  let bytes: Uint8Array;
  if (trimmed.startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(trimmed);
    } catch {
      throw new Error('PRIVATE_KEY: ungültiges JSON-Array.');
    }
    if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error('PRIVATE_KEY: JSON-Array muss aus Bytes (0-255) bestehen.');
    }
    bytes = Uint8Array.from(arr as number[]);
  } else {
    try {
      bytes = bs58.decode(trimmed);
    } catch {
      throw new Error('PRIVATE_KEY: kein gültiger Base58-Schlüssel (so wie Phantom ihn exportiert).');
    }
  }

  if (bytes.length !== 64) {
    throw new Error(`PRIVATE_KEY hat ${bytes.length} Bytes, erwartet werden 64. Bitte den kompletten Schlüssel aus Phantom kopieren.`);
  }
  try {
    return await Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error('PRIVATE_KEY ist ungültig (öffentlicher und privater Teil passen nicht zusammen).');
  }
}

export class Wallet {
  constructor(
    readonly keypair: Keypair,
    readonly connection: Connection,
  ) {}

  get address(): string {
    return this.keypair.publicKey.toBase58();
  }

  async solBalanceLamports(): Promise<bigint> {
    const v = await this.connection.getBalance(this.keypair.publicKey, 'confirmed');
    return BigInt(v);
  }

  /** Summe aller Token-Konten dieses Mints (SPL Token und Token-2022) in Roh-Einheiten. */
  async tokenBalanceRaw(mint: string): Promise<bigint> {
    const res = await this.connection.getParsedTokenAccountsByOwner(
      this.keypair.publicKey,
      { mint: new PublicKey(mint) },
      'confirmed',
    );
    let total = 0n;
    for (const acc of res.value) {
      const data = acc.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } };
      const amount = data.parsed?.info?.tokenAmount?.amount;
      if (amount) total += BigInt(amount);
    }
    return total;
  }

  /** Jupiter-Transaktion (base64) signieren und wieder als base64 zurückgeben. */
  async signBase64(txBase64: string): Promise<string> {
    const tx = VersionedTransaction.deserialize(Uint8Array.from(Buffer.from(txBase64, 'base64')));
    await tx.sign([this.keypair]);
    return Buffer.from(tx.serialize()).toString('base64');
  }
}

export function lamportsToSol(l: bigint | number): number {
  return Number(l) / 1e9;
}

export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}
