import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const USERS_PATH =
  process.env.AUTH_USERS_PATH ??
  path.join(process.cwd(), 'config', 'users.json');

const LOG_PATH =
  process.env.AUTH_LOG_PATH ??
  path.join(process.cwd(), 'config', 'auth-log.json');

const MAX_LOG_ENTRIES = 500;
const BCRYPT_ROUNDS = 12;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UserRole = 'admin' | 'user';

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  totpSecret: string | null;   // base32-encoded; null = TOTP disabled
  totpPending: string | null;  // secret generated but not yet confirmed
  totpEnabled: boolean;
  createdAt: string;
}

export interface PublicUser {
  id: string;
  username: string;
  role: UserRole;
  totpEnabled: boolean;
  createdAt: string;
}

export type AuditEvent = 'login' | 'login_failed' | 'logout' | 'user_created' | 'user_deleted' | 'totp_enabled' | 'totp_disabled';

export interface AuditEntry {
  id: string;
  event: AuditEvent;
  username: string;
  ip: string;
  at: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// User store
// ---------------------------------------------------------------------------

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadUsers(): User[] {
  try {
    if (fs.existsSync(USERS_PATH)) {
      return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')) as User[];
    }
  } catch { /* fall through */ }
  return [];
}

function saveUsers(users: User[]): void {
  ensureDir(USERS_PATH);
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
}

export function hasUsers(): boolean {
  return loadUsers().length > 0;
}

export function publicUser(u: User): PublicUser {
  return { id: u.id, username: u.username, role: u.role, totpEnabled: u.totpEnabled, createdAt: u.createdAt };
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export function loadAuditLog(): AuditEntry[] {
  try {
    if (fs.existsSync(LOG_PATH)) {
      return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')) as AuditEntry[];
    }
  } catch { /* fall through */ }
  return [];
}

export function appendAuditLog(entry: Omit<AuditEntry, 'id' | 'at'>): void {
  ensureDir(LOG_PATH);
  const log = loadAuditLog();
  log.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), ...entry });
  if (log.length > MAX_LOG_ENTRIES) log.length = MAX_LOG_ENTRIES;
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) — no external library
// ---------------------------------------------------------------------------

function base32Decode(base32: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = base32.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function base32Encode(buf: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let result = '';
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) result += alphabet[(value << (5 - bits)) & 0x1f];
  return result;
}

function hotpCode(secretBase32: string, counter: number): string {
  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  const hi = Math.floor(counter / 0x100000000);
  const lo = counter >>> 0;
  buf.writeUInt32BE(hi, 0);
  buf.writeUInt32BE(lo, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function verifyTotp(secret: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (const delta of [-1, 0, 1]) {
    if (hotpCode(secret, counter + delta) === code) return true;
  }
  return false;
}

export async function totpQrDataUrl(username: string, secret: string): Promise<string> {
  const label = encodeURIComponent(`git-unas:${username}`);
  const issuer = encodeURIComponent('git-unas');
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
  return QRCode.toDataURL(uri);
}

// ---------------------------------------------------------------------------
// Auth operations
// ---------------------------------------------------------------------------

/** Create a user. Throws if username already exists. */
export async function createUser(
  username: string,
  password: string,
  role: UserRole,
): Promise<User> {
  const users = loadUsers();
  if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    throw new Error('Username already exists');
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user: User = {
    id: crypto.randomUUID(),
    username,
    passwordHash,
    role,
    totpSecret: null,
    totpPending: null,
    totpEnabled: false,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  saveUsers(users);
  return user;
}

/** Verify credentials. Returns user or null. */
export async function verifyCredentials(
  username: string,
  password: string,
): Promise<User | null> {
  const users = loadUsers();
  const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return null;
  const match = await bcrypt.compare(password, user.passwordHash);
  return match ? user : null;
}

export function findUserById(id: string): User | undefined {
  return loadUsers().find((u) => u.id === id);
}

export function deleteUser(id: string): boolean {
  const users = loadUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return false;
  users.splice(idx, 1);
  saveUsers(users);
  return true;
}

// ---------------------------------------------------------------------------
// TOTP management
// ---------------------------------------------------------------------------

/** Begin TOTP setup for a user. Returns QR code data URL + secret. */
export async function beginTotpSetup(
  userId: string,
): Promise<{ secret: string; qrDataUrl: string }> {
  const users = loadUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) throw new Error('User not found');
  const secret = generateTotpSecret();
  user.totpPending = secret;
  saveUsers(users);
  const qrDataUrl = await totpQrDataUrl(user.username, secret);
  return { secret, qrDataUrl };
}

/** Confirm TOTP setup with a valid code. Activates TOTP for the user. */
export function confirmTotpSetup(userId: string, code: string): boolean {
  const users = loadUsers();
  const user = users.find((u) => u.id === userId);
  if (!user || !user.totpPending) return false;
  if (!verifyTotp(user.totpPending, code)) return false;
  user.totpSecret = user.totpPending;
  user.totpPending = null;
  user.totpEnabled = true;
  saveUsers(users);
  return true;
}

/** Disable and clear TOTP for a user. */
export function disableTotp(userId: string): boolean {
  const users = loadUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) return false;
  user.totpSecret = null;
  user.totpPending = null;
  user.totpEnabled = false;
  saveUsers(users);
  return true;
}
