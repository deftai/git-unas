import * as cron from 'node-cron';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  getFlyApps,
  getFlyMachines,
  getFlySecrets,
  getFlyVolumes,
  type FlyArchiveSnapshot,
} from './flyService';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CONFIG_PATH =
  process.env.FLY_ARCHIVE_CONFIG_PATH ??
  path.join(process.cwd(), 'config', 'fly-archive-config.json');

const RUNS_PATH =
  process.env.FLY_ARCHIVE_RUNS_PATH ??
  path.join(process.cwd(), 'config', 'fly-archive-runs.json');

const MAX_RUNS = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FlyArchiveFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface FlyArchiveConfig {
  baseDir: string;
  orgSlug: string;
  frequency: FlyArchiveFrequency;
  retentionDays: number;
  enabled: boolean;
  /** AES-256-GCM encrypted API token (base64). Empty string = not set. */
  encryptedToken: string;
}

export interface FlyArchiveRun {
  id: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: 'ok' | 'error';
  message: string;
  filePath?: string;
  appCount?: number;
}

// ---------------------------------------------------------------------------
// Token encryption (AES-256-GCM keyed from AUTH_SECRET)
// ---------------------------------------------------------------------------

function deriveKey(): Buffer {
  const secret = process.env.AUTH_SECRET ?? 'change-me-in-production';
  return crypto.createHash('sha256').update(secret).update('fly-archive-v1').digest();
}

export function encryptFlyToken(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptFlyToken(encrypted: string): string {
  const key = deriveKey();
  const buf = Buffer.from(encrypted, 'base64');
  const iv = buf.subarray(0, 16);
  const tag = buf.subarray(16, 32);
  const data = buf.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data).toString('utf8') + decipher.final('utf8');
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: FlyArchiveConfig = {
  baseDir: '',
  orgSlug: '',
  frequency: 'daily',
  retentionDays: 30,
  enabled: false,
  encryptedToken: '',
};

export function loadFlyArchiveConfig(): FlyArchiveConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<FlyArchiveConfig> };
    }
  } catch { /* fall through */ }
  return { ...DEFAULT_CONFIG };
}

export function saveFlyArchiveConfig(config: FlyArchiveConfig): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** Return config safe for API responses (token redacted). */
export function maskedFlyArchiveConfig(
  config: FlyArchiveConfig,
): FlyArchiveConfig & { tokenSet: boolean } {
  return { ...config, encryptedToken: '', tokenSet: config.encryptedToken !== '' };
}

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------

export function loadFlyArchiveRuns(): FlyArchiveRun[] {
  try {
    if (fs.existsSync(RUNS_PATH)) {
      return JSON.parse(fs.readFileSync(RUNS_PATH, 'utf8')) as FlyArchiveRun[];
    }
  } catch { /* fall through */ }
  return [];
}

function saveFlyArchiveRun(run: FlyArchiveRun): void {
  const dir = path.dirname(RUNS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const runs = loadFlyArchiveRuns();
  runs.unshift(run);
  if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
  fs.writeFileSync(RUNS_PATH, JSON.stringify(runs, null, 2));
}

// ---------------------------------------------------------------------------
// Retention pruning
// ---------------------------------------------------------------------------

function pruneOldArchives(baseDir: string, retentionDays: number): void {
  if (!baseDir || !fs.existsSync(baseDir)) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  try {
    for (const entry of fs.readdirSync(baseDir)) {
      if (!entry.startsWith('fly-archive-')) continue;
      const fullPath = path.join(baseDir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs < cutoff) {
        try { fs.unlinkSync(fullPath); } catch { /* best-effort */ }
      }
    }
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Archive logic
// ---------------------------------------------------------------------------

function frequencyToCron(freq: FlyArchiveFrequency): string {
  switch (freq) {
    case 'hourly':  return '0 * * * *';
    case 'daily':   return '0 3 * * *';
    case 'weekly':  return '0 3 * * 0';
    case 'monthly': return '0 3 1 * *';
  }
}

function makeArchivePath(baseDir: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return path.join(baseDir, `fly-archive-${ts}.json`);
}

/** Small delay to avoid hitting Fly.io rate limits between per-app requests. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run a Fly.io archive: fetch all apps in the org plus per-app
 * machines, secrets (names only), and volumes, then write to disk.
 */
export async function runFlyArchive(): Promise<FlyArchiveRun> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const config = loadFlyArchiveConfig();

  const fail = (message: string): FlyArchiveRun => {
    const run: FlyArchiveRun = {
      id: crypto.randomUUID(), startedAt,
      completedAt: new Date().toISOString(), durationMs: Date.now() - startMs,
      status: 'error', message,
    };
    saveFlyArchiveRun(run);
    return run;
  };

  if (!config.baseDir) return fail('baseDir is not configured');
  if (!config.orgSlug) return fail('orgSlug is not configured');
  if (!config.encryptedToken) return fail('API token is not configured');

  let token: string;
  try {
    token = decryptFlyToken(config.encryptedToken);
  } catch {
    return fail('Failed to decrypt stored API token');
  }

  try {
    const apps = await getFlyApps(token, config.orgSlug);

    const appSnapshots = [];
    for (const app of apps) {
      await sleep(200); // 200ms between apps to stay within rate limits
      const [machines, secrets, volumes] = await Promise.all([
        getFlyMachines(token, app.name),
        getFlySecrets(token, app.name),
        getFlyVolumes(token, app.name),
      ]);
      appSnapshots.push({
        name: app.name,
        status: app.status,
        machineCount: machines.length,
        volumeCount: volumes.length,
        machines,
        secrets,
        volumes,
      });
    }

    const snapshot: FlyArchiveSnapshot = {
      timestamp: new Date().toISOString(),
      orgSlug: config.orgSlug,
      appCount: apps.length,
      apps: appSnapshots,
    };

    if (!fs.existsSync(config.baseDir)) fs.mkdirSync(config.baseDir, { recursive: true });
    const outputPath = makeArchivePath(config.baseDir);
    fs.writeFileSync(outputPath, JSON.stringify(snapshot, null, 2));

    pruneOldArchives(config.baseDir, config.retentionDays);

    const run: FlyArchiveRun = {
      id: crypto.randomUUID(), startedAt,
      completedAt: new Date().toISOString(), durationMs: Date.now() - startMs,
      status: 'ok',
      message: path.basename(outputPath),
      filePath: outputPath,
      appCount: apps.length,
    };
    saveFlyArchiveRun(run);
    return run;

  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let _task: cron.ScheduledTask | null = null;

export function startFlyArchiveScheduler(config: FlyArchiveConfig): void {
  _task?.stop();
  _task = null;
  if (!config.enabled || !config.baseDir || !config.orgSlug || !config.encryptedToken) return;
  const expr = frequencyToCron(config.frequency);
  _task = cron.schedule(expr, () => {
    const latest = loadFlyArchiveConfig();
    if (!latest.enabled) return;
    void runFlyArchive();
  });
}

export function stopFlyArchiveScheduler(): void {
  _task?.stop();
  _task = null;
}
