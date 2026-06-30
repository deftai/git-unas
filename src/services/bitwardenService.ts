import { spawn } from 'child_process';

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

function runBw(args: string[], extraEnv?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bw', args, {
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
