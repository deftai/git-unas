import fs from 'fs';
import os from 'os';
import path from 'path';

// Use a temp dir for all config/backup I/O so tests are fully isolated.
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-unas-test-'));
  process.env.SCHEDULE_CONFIG_PATH = path.join(tmpDir, 'schedule.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.SCHEDULE_CONFIG_PATH;
  jest.resetModules();
});

// Re-import after env var is set so the module picks up the test config path.
async function importService() {
  return import('../src/services/scheduleService');
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  it('returns default config when file does not exist', async () => {
    const { loadConfig } = await importService();
    const cfg = loadConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.hour).toBe(6);
    expect(cfg.minute).toBe(0);
    expect(cfg.days).toEqual([]);
    expect(cfg.keepCount).toBe(7);
    expect(cfg.source).toBe('');
    expect(cfg.backupDir).toBe('');
  });

  it('merges persisted values over defaults', async () => {
    const filePath = process.env.SCHEDULE_CONFIG_PATH!;
    fs.writeFileSync(
      filePath,
      JSON.stringify({ enabled: true, hour: 22, minute: 30, days: ['mon', 'fri'], keepCount: 14 }),
    );
    const { loadConfig } = await importService();
    const cfg = loadConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.hour).toBe(22);
    expect(cfg.minute).toBe(30);
    expect(cfg.days).toEqual(['mon', 'fri']);
    expect(cfg.keepCount).toBe(14);
    // defaults still applied for unset keys
    expect(cfg.source).toBe('');
  });

  it('returns default config when file contains invalid JSON', async () => {
    fs.writeFileSync(process.env.SCHEDULE_CONFIG_PATH!, 'not json {{{{');
    const { loadConfig } = await importService();
    expect(loadConfig().enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// saveConfig
// ---------------------------------------------------------------------------

describe('saveConfig', () => {
  it('writes config JSON to the configured path', async () => {
    const { saveConfig, loadConfig } = await importService();
    const cfg = loadConfig();
    cfg.enabled = true;
    cfg.hour = 3;
    cfg.source = '/data';
    saveConfig(cfg);

    const raw = JSON.parse(fs.readFileSync(process.env.SCHEDULE_CONFIG_PATH!, 'utf8'));
    expect(raw.enabled).toBe(true);
    expect(raw.hour).toBe(3);
    expect(raw.source).toBe('/data');
  });

  it('creates the config directory if it does not exist', async () => {
    const nested = path.join(tmpDir, 'deep', 'nested', 'schedule.json');
    process.env.SCHEDULE_CONFIG_PATH = nested;
    jest.resetModules();
    const { saveConfig, loadConfig } = await importService();
    saveConfig(loadConfig());
    expect(fs.existsSync(nested)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listBackups
// ---------------------------------------------------------------------------

describe('listBackups', () => {
  it('returns [] when directory does not exist', async () => {
    const { listBackups } = await importService();
    expect(listBackups('/nonexistent/path/xyz')).toEqual([]);
  });

  it('returns [] when directory is empty', async () => {
    const { listBackups } = await importService();
    expect(listBackups(tmpDir)).toEqual([]);
  });

  it('ignores files that do not match the backup naming pattern', async () => {
    fs.writeFileSync(path.join(tmpDir, 'random.txt'), '');
    fs.writeFileSync(path.join(tmpDir, 'backup.tar.gz'), '');  // missing timestamp
    const { listBackups } = await importService();
    expect(listBackups(tmpDir)).toEqual([]);
  });

  it('lists valid backup files with size info', async () => {
    const name = 'backup-2026-05-28_06-00-00.tar.gz';
    fs.writeFileSync(path.join(tmpDir, name), 'x'.repeat(1024));
    const { listBackups } = await importService();
    const result = listBackups(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe(name);
    expect(result[0].sizeBytes).toBe(1024);
  });

  it('sorts backups newest first', async () => {
    const names = [
      'backup-2026-05-26_06-00-00.tar.gz',
      'backup-2026-05-28_06-00-00.tar.gz',
      'backup-2026-05-27_06-00-00.tar.gz',
    ];
    for (const n of names) fs.writeFileSync(path.join(tmpDir, n), '');
    const { listBackups } = await importService();
    const result = listBackups(tmpDir);
    expect(result.map((r) => r.file)).toEqual([
      'backup-2026-05-28_06-00-00.tar.gz',
      'backup-2026-05-27_06-00-00.tar.gz',
      'backup-2026-05-26_06-00-00.tar.gz',
    ]);
  });
});

// ---------------------------------------------------------------------------
// runBackup
// ---------------------------------------------------------------------------

// Mock tarService so we don't shell out to the real tar binary.
jest.mock('../src/services/tarService', () => ({
  createArchive: jest.fn().mockResolvedValue({ path: 'mocked', output: '' }),
}));

describe('runBackup', () => {
  it('throws when source is empty', async () => {
    const { runBackup, loadConfig } = await importService();
    const cfg = { ...loadConfig(), backupDir: tmpDir };
    await expect(runBackup(cfg)).rejects.toThrow('source and backupDir must be configured');
  });

  it('throws when backupDir is empty', async () => {
    const { runBackup, loadConfig } = await importService();
    const cfg = { ...loadConfig(), source: '/data' };
    await expect(runBackup(cfg)).rejects.toThrow('source and backupDir must be configured');
  });

  it('creates a timestamped archive in backupDir', async () => {
    const { runBackup, listBackups, loadConfig } = await importService();
    const backupDir = path.join(tmpDir, 'backups');
    const cfg = { ...loadConfig(), source: '/data', backupDir };
    const dest = await runBackup(cfg);
    expect(dest).toMatch(/backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.tar\.gz$/);
    expect(dest.startsWith(backupDir)).toBe(true);
    // tarService mock creates no real file, so list will be empty — but
    // the directory itself should have been created.
    expect(fs.existsSync(backupDir)).toBe(true);
  });

  it('rotates old backups beyond keepCount', async () => {
    const { runBackup, loadConfig } = await importService();
    const backupDir = path.join(tmpDir, 'backups');
    fs.mkdirSync(backupDir);

    // Pre-create 3 old backups (real files so listBackups can stat them).
    const old = [
      'backup-2026-05-25_06-00-00.tar.gz',
      'backup-2026-05-26_06-00-00.tar.gz',
      'backup-2026-05-27_06-00-00.tar.gz',
    ];
    for (const n of old) fs.writeFileSync(path.join(backupDir, n), 'data');

    // keepCount = 2: after this run, only the 2 newest survive.
    // The mock doesn't write a real file, so rotation sees 3 old files
    // and deletes the oldest to honour keepCount=2.
    const cfg = { ...loadConfig(), source: '/data', backupDir, keepCount: 2 };
    await runBackup(cfg);

    const remaining = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith('backup-'));
    expect(remaining).toHaveLength(2);
    expect(remaining).not.toContain('backup-2026-05-25_06-00-00.tar.gz');
  });
});

// ---------------------------------------------------------------------------
// nextRunDate
// ---------------------------------------------------------------------------

describe('nextRunDate', () => {
  it('returns null when disabled', async () => {
    const { nextRunDate } = await importService();
    expect(nextRunDate({ enabled: false, hour: 6, minute: 0, days: [], source: '', backupDir: '', keepCount: 7 })).toBeNull();
  });

  it('returns a future date when enabled', async () => {
    const { nextRunDate } = await importService();
    const next = nextRunDate({
      enabled: true, hour: 6, minute: 0, days: [],
      source: '', backupDir: '', keepCount: 7,
    });
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(Date.now());
  });

  it('returns a date matching the configured hour and minute', async () => {
    const { nextRunDate } = await importService();
    const next = nextRunDate({
      enabled: true, hour: 14, minute: 45, days: [],
      source: '', backupDir: '', keepCount: 7,
    });
    expect(next).not.toBeNull();
    expect(next!.getHours()).toBe(14);
    expect(next!.getMinutes()).toBe(45);
  });

  it('only picks days in the days array', async () => {
    const { nextRunDate } = await importService();
    // Only Monday (1).
    const next = nextRunDate({
      enabled: true, hour: 6, minute: 0, days: ['mon'],
      source: '', backupDir: '', keepCount: 7,
    });
    expect(next).not.toBeNull();
    expect(next!.getDay()).toBe(1); // 1 = Monday
  });

  it('treats an empty days array as every day', async () => {
    const { nextRunDate } = await importService();
    const now = new Date();
    const next = nextRunDate({
      enabled: true, hour: 6, minute: 0, days: [],
      source: '', backupDir: '', keepCount: 7,
    });
    // Within 7 days
    expect(next!.getTime() - now.getTime()).toBeLessThan(8 * 24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// startScheduler / stopScheduler
// ---------------------------------------------------------------------------

describe('scheduler lifecycle', () => {
  it('startScheduler does not throw for a valid enabled config', async () => {
    const { startScheduler, stopScheduler } = await importService();
    expect(() =>
      startScheduler({
        enabled: true, hour: 6, minute: 0, days: [],
        source: '/data', backupDir: tmpDir, keepCount: 7,
      }),
    ).not.toThrow();
    stopScheduler();
  });

  it('startScheduler is a no-op when source is empty', async () => {
    const { startScheduler, stopScheduler } = await importService();
    expect(() =>
      startScheduler({ enabled: true, hour: 6, minute: 0, days: [], source: '', backupDir: '', keepCount: 7 }),
    ).not.toThrow();
    stopScheduler();
  });

  it('stopScheduler is idempotent', async () => {
    const { stopScheduler } = await importService();
    expect(() => { stopScheduler(); stopScheduler(); }).not.toThrow();
  });
});
