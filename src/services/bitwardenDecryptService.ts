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
 *
 * Key derivation (two-step, matching Bitwarden's implementation):
 *   masterKey        = PBKDF2-SHA256(password, email.toLowerCase(), iterations, 32)
 *   stretchedEncKey  = HKDF-Expand(masterKey, info="enc", 32)  — EXPAND ONLY, not full HKDF
 *   stretchedMacKey  = HKDF-Expand(masterKey, info="mac", 32)
 *   userKey (64 B)   = decrypt(encKeyValidation_DO_NOT_EDIT, stretchedEncKey, stretchedMacKey)
 *   dataEncKey       = userKey[0:32]
 *   dataMacKey       = userKey[32:64]
 *   vault JSON       = decrypt(data, dataEncKey, dataMacKey)
 *
 * HKDF-Expand T(1) = HMAC-SHA256(prk, info || 0x01)  [output ≤ 32 bytes → T(1) only]
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
 * Uses the async variant to avoid blocking the event loop during PBKDF2.
 */
function deriveMasterKey(password: string, email: string, iterations: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(
      password,
      email.toLowerCase().trim(),
      iterations,
      32,
      'sha256',
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/**
 * HKDF-Expand only (no extract phase) — matches Bitwarden's hkdfExpand implementation.
 * T(1) = HMAC-SHA256(prk, info || 0x01)  (sufficient for output ≤ 32 bytes)
 */
function hkdfExpand(prk: Buffer, info: string, length: number): Buffer {
  const hmac = crypto.createHmac('sha256', prk);
  hmac.update(Buffer.from(info, 'utf8'));
  hmac.update(Buffer.from([0x01]));
  return hmac.digest().slice(0, length);
}

/**
 * Stretch the master key into enc + mac keys using HKDF-Expand.
 * These are used to decrypt the account enc key (encKeyValidation_DO_NOT_EDIT).
 */
function stretchMasterKey(masterKey: Buffer): { encKey: Buffer; macKey: Buffer } {
  return {
    encKey: hkdfExpand(masterKey, 'enc', 32),
    macKey: hkdfExpand(masterKey, 'mac', 32),
  };
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
 * @param filePath       Absolute path to the .json export file
 * @param masterPassword Bitwarden master password
 * @param email          Bitwarden account email (used as PBKDF2 salt)
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

  // 3. Derive master key (async — does not block event loop)
  const iterations = exportFile.kdfIterations ?? 600_000;
  const masterKey = await deriveMasterKey(masterPassword, email, iterations);

  // 4. Stretch into enc + mac keys using HKDF-Expand (Bitwarden's stretchKey)
  const { encKey: stretchedEncKey, macKey: stretchedMacKey } = stretchMasterKey(masterKey);

  // 5. Decrypt encKeyValidation_DO_NOT_EDIT → 64-byte account enc key
  //    The stretched master key encrypts the account's symmetric key;
  //    that symmetric key is what actually encrypts the vault data.
  if (!exportFile.encKeyValidation_DO_NOT_EDIT) {
    throw new Error(
      'Export file is missing encKeyValidation_DO_NOT_EDIT — ' +
      'cannot derive the account encryption key for offline decryption.',
    );
  }

  let userKeyBytes: Buffer;
  try {
    userKeyBytes = decryptEncString(exportFile.encKeyValidation_DO_NOT_EDIT, stretchedEncKey, stretchedMacKey);
  } catch {
    throw new Error('Master password or email is incorrect (account key decryption failed)');
  }

  if (userKeyBytes.length !== 64) {
    throw new Error(
      `Unexpected account key length: ${String(userKeyBytes.length)} bytes (expected 64). ` +
      'The export format may be unsupported.',
    );
  }

  // Split the 64-byte user key into enc (0–31) and mac (32–63)
  const userEncKey = userKeyBytes.subarray(0, 32);
  const userMacKey = userKeyBytes.subarray(32, 64);

  // 6. Decrypt vault data blob using the account enc key
  if (!exportFile.data) {
    throw new Error('Export file has no data field');
  }

  let plaintext: Buffer;
  try {
    plaintext = decryptEncString(exportFile.data, userEncKey, userMacKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('HMAC')) {
      throw new Error('Vault data HMAC verification failed — the export may be corrupted');
    }
    throw err;
  }

  // 7. Parse decrypted JSON
  const vault = JSON.parse(plaintext.toString('utf8')) as BwVaultData;
  return { folders: vault.folders ?? [], items: vault.items ?? [] };
}
