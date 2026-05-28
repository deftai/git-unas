import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const ALGORITHM = 'aes-256-gcm';
const SALT_LEN = 32;
const IV_LEN = 12;
const KEY_LEN = 32;
const ITERATIONS = 100_000;
const DIGEST = 'sha256';
// File format: [4-byte magic][32-byte salt][12-byte IV][16-byte auth tag][ciphertext]
const MAGIC = Buffer.from('UNAS');

export interface EncryptOptions {
  source: string;
  destination: string;
  passphrase: string;
}

export interface EncryptResult {
  destination: string;
  bytesWritten: number;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, ITERATIONS, KEY_LEN, DIGEST);
}

export function encryptFile(options: EncryptOptions): Promise<EncryptResult> {
  return new Promise((resolve, reject) => {
    try {
      const { source, destination, passphrase } = options;

      const salt = crypto.randomBytes(SALT_LEN);
      const iv = crypto.randomBytes(IV_LEN);
      const key = deriveKey(passphrase, salt);

      const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
      const plaintext = fs.readFileSync(source);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();

      const outDir = path.dirname(destination);
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

      const outBuf = Buffer.concat([MAGIC, salt, iv, authTag, ciphertext]);
      fs.writeFileSync(destination, outBuf);

      resolve({ destination, bytesWritten: outBuf.length });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function decryptFile(options: EncryptOptions): Promise<EncryptResult> {
  return new Promise((resolve, reject) => {
    try {
      const { source, destination, passphrase } = options;

      const data = fs.readFileSync(source);

      if (!data.subarray(0, 4).equals(MAGIC)) {
        throw new Error('Not a git-unas encrypted file (bad magic bytes)');
      }

      let offset = 4;
      const salt = data.subarray(offset, (offset += SALT_LEN));
      const iv = data.subarray(offset, (offset += IV_LEN));
      const authTag = data.subarray(offset, (offset += 16));
      const ciphertext = data.subarray(offset);

      const key = deriveKey(passphrase, salt);
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);

      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      const outDir = path.dirname(destination);
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

      fs.writeFileSync(destination, plaintext);

      resolve({ destination, bytesWritten: plaintext.length });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
