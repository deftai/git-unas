import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Install paths
// ---------------------------------------------------------------------------

/** Firmware-survivable directory on UniFi OS — writable across reboots */
const BW_INSTALL_DIR = process.env.BW_INSTALL_DIR ?? '/data/git-unas';
export const BW_INSTALL_PATH = path.join(BW_INSTALL_DIR, 'bw');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BwVaultStatus = 'not_installed' | 'unauthenticated' | 'locked' | 'unlocked';

export interface BwStatusResult {
  status: BwVaultStatus;
  userEmail?: string;
  lastSync?: string;
  serverUrl?: string;
  /** Whether a session key is held in memory (vault can be queried) */
  sessionActive: boolean;
}

export interface BwItem {
  id: string;
  name: string;
  /** 1=login, 2=secureNote, 3=card, 4=identity */
  type: number;
  login?: {
    username?: string;
    password?: string;
    uris?: { uri: string }[];
  };
  notes?: string | null;
}

// ---------------------------------------------------------------------------
// In-memory session — intentionally not persisted for security
// ---------------------------------------------------------------------------

let _sessionKey: string | null = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve the bw binary path: prefer installed copy, fall back to system PATH */
function bwBin(): string {
  return fs.existsSync(BW_INSTALL_PATH) ? BW_INSTALL_PATH : 'bw';
}

/** Run any shell command, capturing stdout */
function runCmd(cmd: string, args: string[], extraEnv?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(extraEnv ?? {}) },
    });
    const out: string[] = [];
    const err: string[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d.toString()));
    proc.stderr.on('data', (d: Buffer) => err.push(d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve(out.join(''));
      else reject(new Error(err.join('').trim() || out.join('').trim() || `${cmd} exited with code ${String(code)}`));
    });
    proc.on('error', (e) => reject(new Error(`Failed to spawn ${cmd}: ${e.message}`)));
  });
}

function runBw(args: string[], extraEnv?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bwBin(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(extraEnv ?? {}) },
    });

    const out: string[] = [];
    const err: string[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d.toString()));
    proc.stderr.on('data', (d: Buffer) => err.push(d.toString()));

    proc.on('close', (code) => {
      const stdout = out.join('');
      const stderr = err.join('');
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || stdout.trim() || `bw exited with code ${String(code)}`));
    });

    proc.on('error', (e) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('bw_not_found'));
      } else {
        reject(new Error(`Failed to spawn bw: ${e.message}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getBwStatus(): Promise<BwStatusResult> {
  try {
    const raw = await runBw(['status'], _sessionKey ? { BW_SESSION: _sessionKey } : {});
    // bw status may prefix the JSON with update-check notices; extract the JSON object
    const match = /\{[\s\S]*\}/.exec(raw);
    if (!match) throw new Error('Unexpected bw status output');
    const parsed = JSON.parse(match[0]) as {
      status?: string;
      userEmail?: string;
      lastSync?: string;
      serverUrl?: string;
    };
    return {
      status: (parsed.status ?? 'unauthenticated') as BwVaultStatus,
      userEmail: parsed.userEmail,
      lastSync: parsed.lastSync,
      serverUrl: parsed.serverUrl,
      sessionActive: _sessionKey !== null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'bw_not_found') {
      return { status: 'not_installed', sessionActive: false };
    }
    // Any other error (e.g. unauthenticated JSON parse fails): treat as unauthenticated
    return { status: 'unauthenticated', sessionActive: false };
  }
}

/** Unlock the vault. Stores the session key in memory. */
export async function unlockVault(password: string): Promise<void> {
  // --raw makes bw output only the session key string
  const output = await runBw(['unlock', '--raw', password]);
  const key = output.trim();
  if (!key) throw new Error('bw unlock returned no session key');
  _sessionKey = key;
}

/** Lock the vault and clear the in-memory session key. */
export async function lockVault(): Promise<void> {
  _sessionKey = null;
  try {
    await runBw(['lock']);
  } catch {
    // best-effort; session is already cleared
  }
}

/** Sync the vault with Bitwarden servers. Requires an unlocked vault. */
export async function syncVault(): Promise<void> {
  if (!_sessionKey) throw new Error('Vault is locked — unlock first');
  await runBw(['sync'], { BW_SESSION: _sessionKey });
}

/** List or search vault items. Requires an unlocked vault. */
export async function searchItems(query?: string): Promise<BwItem[]> {
  if (!_sessionKey) throw new Error('Vault is locked — unlock first');
  const args = ['list', 'items', '--raw'];
  if (query?.trim()) args.push('--search', query.trim());
  const raw = await runBw(args, { BW_SESSION: _sessionKey });
  const parsed = JSON.parse(raw.trim()) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed as BwItem[];
}

/**
 * Download and install the Bitwarden CLI binary to BW_INSTALL_DIR.
 * Detects device architecture; fetches the correct asset from GitHub releases.
 * Uses python3 for zip extraction (unzip is not available on UniFi OS).
 */
export async function installBw(serverUrl?: string): Promise<{ version: string }> {
  const tmpZip = '/tmp/bw-install.zip';
  const tmpDir = '/tmp/bw-extract';

  try {
    // 1. Detect architecture
    const archRaw = await runCmd('uname', ['-m']);
    const isArm64 = archRaw.trim() === 'aarch64' || archRaw.trim() === 'arm64';

    // 2. Query GitHub releases API for the latest CLI release + right asset
    const apiRaw = await runCmd('curl', [
      '-fsSL', '--max-time', '15',
      '-H', 'User-Agent: git-unas',
      'https://api.github.com/repos/bitwarden/clients/releases?per_page=30',
    ]);
    const releases = JSON.parse(apiRaw) as Array<{
      tag_name: string;
      assets: Array<{ name: string; browser_download_url: string }>;
    }>;

    // Find latest cli-v* release that has a Linux asset for our arch
    const archLabel = isArm64 ? 'linux-arm64' : 'linux';
    let downloadUrl = '';
    let version = '';
    for (const rel of releases) {
      if (!rel.tag_name.startsWith('cli-v')) continue;
      // Prefer architecture-specific asset; accept generic linux for amd64
      const asset = rel.assets.find((a) =>
        isArm64
          ? /bw-linux-arm64-.*\.zip$/i.test(a.name)
          : /bw-linux-[^a][^r][^m].*\.zip$/i.test(a.name) || /bw-linux-\d.*\.zip$/i.test(a.name),
      ) ?? rel.assets.find((a) => a.name.includes(archLabel) && a.name.endsWith('.zip'));
      if (asset) {
        downloadUrl = asset.browser_download_url;
        version = rel.tag_name.replace('cli-v', '');
        break;
      }
    }

    if (!downloadUrl) {
      // Fallback: vault.bitwarden.com serves amd64; fail with helpful message for arm64
      if (isArm64) {
        throw new Error(
          'No ARM64 Linux asset found in recent Bitwarden CLI releases. ' +
          'Visit https://github.com/bitwarden/clients/releases and paste the download URL below.',
        );
      }
      downloadUrl = 'https://vault.bitwarden.com/download/?app=cli&platform=linux';
      version = 'latest';
    }

    // 3. Download
    await runCmd('curl', ['-fsSL', '-L', '-o', tmpZip, downloadUrl]);

    // 4. Extract with Python3 (unzip not available on UniFi OS)
    await runCmd('python3', [
      '-c',
      `import zipfile, os; os.makedirs('${tmpDir}', exist_ok=True); ` +
      `zipfile.ZipFile('${tmpZip}').extractall('${tmpDir}')`,
    ]);

    // 5. Install binary
    if (!fs.existsSync(BW_INSTALL_DIR)) {
      fs.mkdirSync(BW_INSTALL_DIR, { recursive: true });
    }
    const candidates = fs.readdirSync(tmpDir);
    const bwFile = candidates.find((f) => f === 'bw' || f.startsWith('bw'));
    if (!bwFile) throw new Error('bw binary not found in downloaded archive');
    const srcPath = path.join(tmpDir, bwFile);
    // Use copy+delete in case /tmp and /data are on different filesystems
    fs.copyFileSync(srcPath, BW_INSTALL_PATH);
    fs.chmodSync(BW_INSTALL_PATH, 0o755);

    // 6. Optionally configure self-hosted server URL
    if (serverUrl?.trim()) {
      await runBw(['config', 'server', serverUrl.trim()]);
    }

    return { version };
  } finally {
    try { fs.rmSync(tmpZip, { force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Log in to Bitwarden and unlock the vault in one step.
 * After a successful login the in-memory session key is populated.
 */
export async function loginBw(
  email: string,
  password: string,
  twoFactorCode?: string,
): Promise<void> {
  const loginArgs = ['login', email, password, '--raw'];
  if (twoFactorCode?.trim()) {
    // Method 0 = authenticator app TOTP
    loginArgs.push('--method', '0', '--code', twoFactorCode.trim());
  }
  try {
    await runBw(loginArgs);
  } catch (err) {
    // If already logged in, bw returns a non-zero exit; try unlocking instead
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.toLowerCase().includes('already logged')) throw err;
  }
  // Unlock to get the session key (login leaves vault locked)
  await unlockVault(password);
}

/** Log out of Bitwarden, clearing the local vault data and session key. */
export async function logoutBw(): Promise<void> {
  _sessionKey = null;
  try {
    await runBw(['logout']);
  } catch {
    // best-effort
  }
}
