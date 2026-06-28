import * as cron from 'node-cron';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { listOrgRepos } from './githubService';
import { encryptFile } from './encryptService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Frequency = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface ArchiveEntry {
  id: string;
  type: 'repo' | 'org';
  /** GitHub owner (user or org name) — used for type=repo */
  owner: string;
  /** Repo name — only for type=repo */
  repo?: string;
  /** Only for type=org: ["*"] means all repos */
  includeRepos: string[];
  /** Only for type=org: repos to skip */
  excludeRepos: string[];
  /** null → use config.defaultFrequency */
  frequency: Frequency | null;
  /** null → use config.retentionDays */
  retentionDays: number | null;
  enabled: boolean;
  lastRun: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastMessage: string | null;
}

export interface ArchiveConfig {
  githubToken: string;
  baseDir: string;
  defaultFrequency: Frequency;
  /** How many days to retain archive files. 1–180. */
  retentionDays: number;
  encrypt: boolean;
  passphrase: string;
  entries: ArchiveEntry[];
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

const CONFIG_PATH =
  process.env.ARCHIVE_CONFIG_PATH ??
  path.join(process.cwd(), 'config', 'archive-config.json');

const DEFAULT_CONFIG: ArchiveConfig = {
  githubToken: '',
  baseDir: '',
  defaultFrequency: 'daily',
  retentionDays: 30,
  encrypt: false,
  passphrase: '',
  entries: [],
};

export function loadArchiveConfig(): ArchiveConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<ArchiveConfig>) };
    }
  } catch {
    // fall through to default
  }
  return { ...DEFAULT_CONFIG };
}

export function saveArchiveConfig(config: ArchiveConfig): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** Return config with token masked for API responses. */
export function maskedConfig(config: ArchiveConfig): ArchiveConfig {
  return {
    ...config,
    githubToken: config.githubToken ? '***' : '',
    passphrase: config.passphrase ? '***' : '',
  };
}

// ---------------------------------------------------------------------------
// Cron helpers
// ---------------------------------------------------------------------------

export function frequencyToCron(freq: Frequency): string {
  switch (freq) {
    case 'hourly':  return '0 * * * *';
    case 'daily':   return '0 2 * * *';
    case 'weekly':  return '0 2 * * 0';
    case 'monthly': return '0 2 1 * *';
  }
}

/** Next fire time for a cron expression (within the next 7 days). */
export function nextRunDate(freq: Frequency): Date | null {
  const now = new Date();
  const candidate = new Date(now);

  switch (freq) {
    case 'hourly': {
      candidate.setMinutes(0, 0, 0);
      candidate.setHours(candidate.getHours() + 1);
      return candidate;
    }
    case 'daily': {
      candidate.setHours(2, 0, 0, 0);
      if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
      return candidate;
    }
    case 'weekly': {
      candidate.setHours(2, 0, 0, 0);
      const daysUntilSunday = (7 - candidate.getDay()) % 7 || 7;
      candidate.setDate(candidate.getDate() + daysUntilSunday);
      return candidate;
    }
    case 'monthly': {
      candidate.setHours(2, 0, 0, 0);
      candidate.setDate(1);
      if (candidate <= now) {
        candidate.setMonth(candidate.getMonth() + 1);
        candidate.setDate(1);
      }
      return candidate;
    }
  }
}

// ---------------------------------------------------------------------------
// Retention / pruning
// ---------------------------------------------------------------------------

// Matches: owner__repo__YYYY-MM-DD_HH-MM-SS.tar.gz  or  ...tar.gz.unas
const ARCHIVE_FILE_RE = /^(.+)__(.+)__(\d{4}-\d{2}-\d{2})_\d{2}-\d{2}-\d{2}\.tar\.gz(\.unas)?$/;

/**
 * Parse the date embedded in an archive filename.
 * Returns null if the filename doesn't match the expected pattern.
 */
export function parseDateFromFilename(filename: string): Date | null {
  const m = ARCHIVE_FILE_RE.exec(filename);
  if (!m) return null;
  const [, , , dateStr] = m; // YYYY-MM-DD
  const d = new Date(`${dateStr}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Delete archive files for owner/repo that are older than retentionDays.
 * Best-effort: individual delete failures are silently ignored.
 */
export function pruneOldArchives(
  owner: string,
  repo: string,
  baseDir: string,
  retentionDays: number,
): void {
  if (!baseDir || !fs.existsSync(baseDir)) return;

  const prefix = `${owner}__${repo}__`;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  const files = fs.readdirSync(baseDir).filter((f) => f.startsWith(prefix));
  for (const file of files) {
    const fileDate = parseDateFromFilename(file);
    if (fileDate && fileDate.getTime() < cutoff) {
      try {
        fs.unlinkSync(path.join(baseDir, file));
      } catch {
        // best-effort
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Archive operations
// ---------------------------------------------------------------------------

function runCommand(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
    });
    const out: string[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d.toString()));
    proc.stderr.on('data', (d: Buffer) => out.push(d.toString()));
    proc.on('close', (code) => {
      const text = out.join('');
      if (code === 0) resolve(text);
      else reject(new Error(`${cmd} exited ${code}: ${text}`));
    });
    proc.on('error', (err) => reject(new Error(`Failed to spawn ${cmd}: ${err.message}`)));
  });
}

/**
 * Archive a single repository.
 * Process: git clone --mirror → tar.gz → optional encrypt → rm clone dir → prune old
 * Archive filename: <owner>__<repo>__<timestamp>.tar.gz[.unas]
 */
export async function archiveRepo(
  owner: string,
  repo: string,
  config: ArchiveConfig,
  retentionOverride?: number,
): Promise<string> {
  if (!config.baseDir) throw new Error('baseDir is not configured');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-unas-archive-'));
  const cloneDir = path.join(tmpDir, `${repo}.git`);

  try {
    const repoUrl = `https://x-access-token:${config.githubToken}@github.com/${owner}/${repo}.git`;
    await runCommand('git', ['clone', '--mirror', '--', repoUrl, cloneDir]);

    if (!fs.existsSync(config.baseDir)) {
      fs.mkdirSync(config.baseDir, { recursive: true });
    }

    const pad = (n: number) => String(n).padStart(2, '0');
    const now = new Date();
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const tarName = `${owner}__${repo}__${stamp}.tar.gz`;
    const tarPath = path.join(config.baseDir, tarName);

    await runCommand('tar', ['-czf', tarPath, '-C', tmpDir, `${repo}.git`]);

    const retention = retentionOverride ?? config.retentionDays;
    pruneOldArchives(owner, repo, config.baseDir, retention);

    if (config.encrypt && config.passphrase) {
      const encPath = `${tarPath}.unas`;
      await encryptFile({ source: tarPath, destination: encPath, passphrase: config.passphrase });
      fs.unlinkSync(tarPath);
      return encPath;
    }

    return tarPath;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Archive all repos for an org entry, respecting includeRepos / excludeRepos.
 */
export async function archiveOrgEntry(
  entry: ArchiveEntry,
  config: ArchiveConfig,
): Promise<{ repo: string; status: 'ok' | 'error'; message: string }[]> {
  if (entry.type !== 'org') throw new Error('entry is not type=org');

  const allRepos = await listOrgRepos(config.githubToken, entry.owner);
  const includeAll =
    entry.includeRepos.length === 0 || entry.includeRepos.includes('*');

  const repos = allRepos
    .filter((r) => !r.archived)
    .filter((r) => includeAll || entry.includeRepos.includes(r.name))
    .filter((r) => !entry.excludeRepos.includes(r.name));

  const results: { repo: string; status: 'ok' | 'error'; message: string }[] = [];

  for (const r of repos) {
    try {
      const retention = entry.retentionDays ?? config.retentionDays;
      const dest = await archiveRepo(entry.owner, r.name, config, retention);
      results.push({ repo: r.name, status: 'ok', message: dest });
    } catch (err) {
      results.push({
        repo: r.name,
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Scheduler singleton
// ---------------------------------------------------------------------------

const _tasks = new Map<string, cron.ScheduledTask>();

function updateEntryStatus(
  id: string,
  status: 'ok' | 'error',
  message: string,
): void {
  const cfg = loadArchiveConfig();
  const entry = cfg.entries.find((e) => e.id === id);
  if (entry) {
    entry.lastRun = new Date().toISOString();
    entry.lastStatus = status;
    entry.lastMessage = message;
    saveArchiveConfig(cfg);
  }
}

async function runEntry(entry: ArchiveEntry, config: ArchiveConfig): Promise<void> {
  try {
    if (entry.type === 'repo') {
      const retention = entry.retentionDays ?? config.retentionDays;
      const dest = await archiveRepo(entry.owner, entry.repo!, config, retention);
      updateEntryStatus(entry.id, 'ok', dest);
    } else {
      const results = await archiveOrgEntry(entry, config);
      const errors = results.filter((r) => r.status === 'error');
      if (errors.length === 0) {
        updateEntryStatus(entry.id, 'ok', `${results.length} repos archived`);
      } else {
        updateEntryStatus(
          entry.id,
          'error',
          `${errors.length} errors: ${errors.map((e) => e.repo).join(', ')}`,
        );
      }
    }
  } catch (err) {
    updateEntryStatus(
      entry.id,
      'error',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function startArchiveScheduler(config: ArchiveConfig): void {
  // Stop all existing tasks.
  for (const task of _tasks.values()) task.stop();
  _tasks.clear();

  if (!config.githubToken || !config.baseDir) return;

  for (const entry of config.entries) {
    if (!entry.enabled) continue;
    const freq = entry.frequency ?? config.defaultFrequency;
    const expr = frequencyToCron(freq);
    const task = cron.schedule(expr, () => {
      const latest = loadArchiveConfig();
      const latestEntry = latest.entries.find((e) => e.id === entry.id);
      if (!latestEntry?.enabled) return;
      void runEntry(latestEntry, latest);
    });
    _tasks.set(entry.id, task);
  }
}

export function stopArchiveScheduler(): void {
  for (const task of _tasks.values()) task.stop();
  _tasks.clear();
}

/** Run one entry immediately outside the scheduler (for manual trigger). */
export async function runEntryNow(id: string): Promise<void> {
  const config = loadArchiveConfig();
  const entry = config.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`No archive entry with id=${id}`);
  await runEntry(entry, config);
}

/** Run all enabled entries immediately. */
export async function runAllNow(): Promise<void> {
  const config = loadArchiveConfig();
  for (const entry of config.entries.filter((e) => e.enabled)) {
    await runEntry(entry, config);
  }
}

/** Generate a new entry ID. */
export function newEntryId(): string {
  return crypto.randomUUID();
}
