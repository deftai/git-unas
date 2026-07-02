/**
 * Offline decryption of Bitwarden `encrypted_json` exports.
 *
 * No Bitwarden server or `bw` CLI required — only the master password and
 * the account email used during key derivation.
 *
 * Supports kdfType = 0 (PBKDF2-SHA256) only.
 * kdfType = 1 (Argon2id) is detected and surfaces a clear error.
 *
 * Bitwarden EncString type 2 format:  2.<base64-iv>|<base64-ct>|<base64-mac>
 * Key derivation:
 *   masterKey   = PBKDF2-SHA256(password, email.toLowerCase(), iterations, 32)
 *   encKey      = HKDF-SHA256(masterKey, info="enc", 32)
 *   macKey      = HKDF-SHA256(masterKey, info="mac", 32)
 *   ciphertext  = AES-256-CBC(encKey, iv, data)  +  HMAC-SHA256(macKey, iv‖ct) verified
 */

import crypto from 'crypto';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BwFolder {
  id: string;
  name: string;
}

export interface BwLoginUri {
  uri: string;
  match?: number | null;
}

export interface BwLogin {
  username?: string | null;
  password?: string | null;
  totp?: string | null;
  uris?: BwLoginUri[];
}

export interface BwVaultItem {
  id: string;
  organizationId?: string | null;
  folderId?: string | null;
  /** 1=login, 2=secureNote, 3=card, 4=identity */
  type: number;
  name: string;
  notes?: string | null;
  login?: BwLogin;
  fields?: Array<{ name: string; value: string | null; type: number }>;
  [key: string]: unknown;
}

export interface BwVaultData {
  folders: BwFolder[];
  items: BwVaultItem[];
}

// ---------------------------------------------------------------------------
// Bitwarden export file shape
// ---------------------------------------------------------------------------

interface BwExportFile {
  encrypted: boolean;
  passwordProtected?: boolean;
  /** 0 = PBKDF2-SHA256, 1 = Argon2id */
  kdfType: number;
  kdfIterations?: number;
  kdfMemory?: number | null;
  kdfParallelism?: number | null;
  /** EncString used to verify derived keys before decrypting data */
  encKeyValidation_DO_NOT_EDIT?: string;
  /** EncString containing the entire vault JSON blob */
  data: string;
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Derive the 32-byte master key from master password + account email.
 * Matches Bitwarden's PBKDF2-SHA256 path (kdfType=0).
 */
function deriveMasterKey(password: string, email: string, iterations: number): Buffer {
  return crypto.pbkdf2Sync(
    password,
    email.toLowerCase().trim(),
    iterations,
    32,
    'sha256',
  );
}

/**
 * Stretch the master key into separate enc and mac keys using HKDF-SHA256.
 * Bitwarden uses info strings "enc" and "mac" with an empty salt.
 */
function stretchKey(masterKey: Buffer): { encKey: Buffer; macKey: Buffer } {
  const encKey = Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), 'enc', 32));
  const macKey = Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), 'mac', 32));
  return { encKey, macKey };
}

// ---------------------------------------------------------------------------
// EncString decryption
// ---------------------------------------------------------------------------

/**
 * Parse and decrypt a Bitwarden type-2 EncString.
 * Format:  2.<base64-iv>|<base64-ciphertext>|<base64-mac>
 * Returns the plaintext Buffer on success; throws on verification or decryption failure.
 */
function decryptEncString(encString: string, encKey: Buffer, macKey: Buffer): Buffer {
  const prefix = encString.startsWith('2.') ? encString.slice(2) : encString;
  const parts = prefix.split('|');
  if (parts.length !== 3) {
    throw new Error(`Unsupported EncString format (expected 3 parts separated by |, got ${parts.length})`);
  }

  const iv = Buffer.from(parts[0], 'base64');
  const ct = Buffer.from(parts[1], 'base64');
  const mac = Buffer.from(parts[2], 'base64');

  // Verify HMAC-SHA256 over (iv ‖ ct) with mac key
  const hmac = crypto.createHmac('sha256', macKey);
  hmac.update(iv);
  hmac.update(ct);
  const computedMac = hmac.digest();

  if (!crypto.timingSafeEqual(computedMac, mac)) {
    throw new Error('HMAC verification failed — wrong master password or corrupted export');
  }

  // AES-256-CBC decrypt
  const decipher = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Decrypt a Bitwarden `encrypted_json` export file offline.
 *
 * @param filePath     Absolute path to the .json export file
 * @param masterPassword  Bitwarden master password
 * @param email        Bitwarden account email (used as PBKDF2 salt)
 * @returns Decrypted vault data containing folders and items
 */
export async function decryptBwExport(
  filePath: string,
  masterPassword: string,
  email: string,
): Promise<BwVaultData> {
  // 1. Read and parse the export file
  const raw = fs.readFileSync(filePath, 'utf8');
  const exportFile = JSON.parse(raw) as BwExportFile;

  if (!exportFile.encrypted) {
    // Already a plaintext export — parse directly
    const vault = JSON.parse(raw) as BwVaultData;
    return { folders: vault.folders ?? [], items: vault.items ?? [] };
  }

  // 2. Check KDF type
  if (exportFile.kdfType === 1) {
    throw new Error(
      'This vault export was created with Argon2id key derivation, which is not yet supported for offline decryption. ' +
      'Argon2id support will be added in a future release.',
    );
  }
  if (exportFile.kdfType !== 0) {
    throw new Error(`Unknown kdfType ${String(exportFile.kdfType)} in export file`);
  }

  const iterations = exportFile.kdfIterations ?? 600_000;

  // 3. Derive master key and stretch into enc + mac keys
  const masterKey = deriveMasterKey(masterPassword, email, iterations);
  const { encKey, macKey } = stretchKey(masterKey);

  // 4. Verify derived keys using encKeyValidation_DO_NOT_EDIT (if present)
  if (exportFile.encKeyValidation_DO_NOT_EDIT) {
    try {
      decryptEncString(exportFile.encKeyValidation_DO_NOT_EDIT, encKey, macKey);
    } catch {
      throw new Error('Master password or email is incorrect (key validation failed)');
    }
  }

  // 5. Decrypt the vault data blob
  if (!exportFile.data) {
    throw new Error('Export file has no data field');
  }

  let plaintext: Buffer;
  try {
    plaintext = decryptEncString(exportFile.data, encKey, macKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('HMAC')) {
      throw new Error('Master password or email is incorrect (data decryption failed)');
    }
    throw err;
  }

  // 6. Parse the decrypted JSON
  const vault = JSON.parse(plaintext.toString('utf8')) as BwVaultData;
  return { folders: vault.folders ?? [], items: vault.items ?? [] };
}
