import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock child_process so archiveRepo doesn't actually run git/tar.
jest.mock('child_process');
// Mock encryptService.
jest.mock('../src/services/encryptService', () => ({
  encryptFile: jest.fn().mockResolvedValue({ destination: 'mocked.unas', bytesWritten: 100 }),
}));
// Mock githubService so archiveOrgEntry can be tested without network.
jest.mock('../src/services/githubService', () => ({
  listOrgRepos: jest.fn().mockResolvedValue([
    { name: 'repo-a', archived: false },
    { name: 'repo-b', archived: false },
    { name: 'old-repo', archived: true },
  ]),
}));

import { spawn } from 'child_process';
import { EventEmitter } from 'events';

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

function fakeProc(code: number, out = '', err = '') {
  const p = new EventEmitter() as ReturnType<typeof spawn>;
  (p as any).stdout = new EventEmitter();
  (p as any).stderr = new EventEmitter();
  setImmediate(() => {
    if (out) (p as any).stdout.emit('data', Buffer.from(out));
    if (err) (p as any).stderr.emit('data', Buffer.from(err));
    p.emit('close', code);
  });
  return p;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-unas-arch-test-'));
  process.env.ARCHIVE_CONFIG_PATH = path.join(tmpDir, 'archive-config.json');
  mockSpawn.mockReset();
  jest.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ARCHIVE_CONFIG_PATH;
});

async function imp() {
  return import('../src/services/archiveService');
}

// ---------------------------------------------------------------------------
// loadArchiveConfig / saveArchiveConfig
// ---------------------------------------------------------------------------

describe('loadArchiveConfig', () => {
  it('returns default config when no file exists', async () => {
    const { loadArchiveConfig } = await imp();
    const cfg = loadArchiveConfig();
    expect(cfg.githubToken).toBe('');
    expect(cfg.defaultFrequency).toBe('daily');
    expect(cfg.entries).toEqual([]);
    expect(cfg.encrypt).toBe(false);
  });

  it('merges saved config over defaults', async () => {
    fs.writeFileSync(
      process.env.ARCHIVE_CONFIG_PATH!,
      JSON.stringify({ githubToken: 'tok', defaultFrequency: 'weekly', baseDir: '/arc' }),
    );
    const { loadArchiveConfig } = await imp();
    const cfg = loadArchiveConfig();
    expect(cfg.githubToken).toBe('tok');
    expect(cfg.defaultFrequency).toBe('weekly');
    expect(cfg.baseDir).toBe('/arc');
    expect(cfg.entries).toEqual([]);
  });

  it('returns default on corrupt JSON', async () => {
    fs.writeFileSync(process.env.ARCHIVE_CONFIG_PATH!, '{{{');
    const { loadArchiveConfig } = await imp();
    expect(loadArchiveConfig().githubToken).toBe('');
  });
});

describe('saveArchiveConfig', () => {
  it('writes config to disk and can be read back', async () => {
    const { saveArchiveConfig, loadArchiveConfig } = await imp();
    const cfg = loadArchiveConfig();
    cfg.githubToken = 'mytoken';
    cfg.baseDir = '/archives';
    saveArchiveConfig(cfg);
    const loaded = JSON.parse(fs.readFileSync(process.env.ARCHIVE_CONFIG_PATH!, 'utf8'));
    expect(loaded.githubToken).toBe('mytoken');
    expect(loaded.baseDir).toBe('/archives');
  });
});

describe('maskedConfig', () => {
  it('replaces non-empty token and passphrase with ***', async () => {
    const { maskedConfig } = await imp();
    const masked = maskedConfig({
      githubToken: 'realtoken', passphrase: 'secret',
      baseDir: '/a', defaultFrequency: 'daily', retentionDays: 30, encrypt: false, entries: [],
    });
    expect(masked.githubToken).toBe('***');
    expect(masked.passphrase).toBe('***');
  });

  it('keeps empty token as empty', async () => {
    const { maskedConfig } = await imp();
    const masked = maskedConfig({
      githubToken: '', passphrase: '',
      baseDir: '/a', defaultFrequency: 'daily', retentionDays: 30, encrypt: false, entries: [],
    });
    expect(masked.githubToken).toBe('');
    expect(masked.passphrase).toBe('');
  });
});

// ---------------------------------------------------------------------------
// frequencyToCron
// ---------------------------------------------------------------------------

describe('frequencyToCron', () => {
  it.each([
    ['hourly',  '0 * * * *'],
    ['daily',   '0 2 * * *'],
    ['weekly',  '0 2 * * 0'],
    ['monthly', '0 2 1 * *'],
  ] as const)('%s → %s', async (freq, expected) => {
    const { frequencyToCron } = await imp();
    expect(frequencyToCron(freq)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// nextRunDate
// ---------------------------------------------------------------------------

describe('nextRunDate', () => {
  it('returns a future date for every frequency', async () => {
    const { nextRunDate } = await imp();
    for (const freq of ['hourly', 'daily', 'weekly', 'monthly'] as const) {
      const d = nextRunDate(freq);
      expect(d).not.toBeNull();
      expect(d!.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('hourly next run is at minute 0 of a future hour', async () => {
    const { nextRunDate } = await imp();
    const d = nextRunDate('hourly');
    expect(d!.getMinutes()).toBe(0);
    expect(d!.getSeconds()).toBe(0);
  });

  it('daily next run is at 02:00', async () => {
    const { nextRunDate } = await imp();
    const d = nextRunDate('daily');
    expect(d!.getHours()).toBe(2);
    expect(d!.getMinutes()).toBe(0);
  });

  it('weekly next run is a Sunday', async () => {
    const { nextRunDate } = await imp();
    const d = nextRunDate('weekly');
    expect(d!.getDay()).toBe(0);
  });

  it('monthly next run is on day 1', async () => {
    const { nextRunDate } = await imp();
    const d = nextRunDate('monthly');
    expect(d!.getDate()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// newEntryId
// ---------------------------------------------------------------------------

describe('newEntryId', () => {
  it('returns a uuid-shaped string', async () => {
    const { newEntryId } = await imp();
    const id = newEntryId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns unique ids', async () => {
    const { newEntryId } = await imp();
    expect(newEntryId()).not.toBe(newEntryId());
  });
});

// ---------------------------------------------------------------------------
// parseDateFromFilename
// ---------------------------------------------------------------------------

describe('parseDateFromFilename', () => {
  it('parses a valid archive filename', async () => {
    const { parseDateFromFilename } = await imp();
    const d = parseDateFromFilename('acme__backend__2026-06-01_02-00-00.tar.gz');
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBe(2026);
    expect(d!.getUTCMonth()).toBe(5); // June = 5
    expect(d!.getUTCDate()).toBe(1);
  });

  it('parses an encrypted archive filename (.tar.gz.unas)', async () => {
    const { parseDateFromFilename } = await imp();
    const d = parseDateFromFilename('org__repo__2025-12-31_23-59-59.tar.gz.unas');
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBe(2025);
  });

  it('returns null for unrecognised filenames', async () => {
    const { parseDateFromFilename } = await imp();
    expect(parseDateFromFilename('random.txt')).toBeNull();
    expect(parseDateFromFilename('backup-2026-05-28_06-00-00.tar.gz')).toBeNull();
    expect(parseDateFromFilename('acme__backend.tar.gz')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pruneOldArchives
// ---------------------------------------------------------------------------

describe('pruneOldArchives', () => {
  it('is a no-op when baseDir does not exist', async () => {
    const { pruneOldArchives } = await imp();
    expect(() => pruneOldArchives('owner', 'repo', '/nonexistent/dir', 30)).not.toThrow();
  });

  it('deletes run folders older than retentionDays', async () => {
    const { pruneOldRunDirs } = await imp();

    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const y = sixtyDaysAgo.getUTCFullYear();
    const mo = String(sixtyDaysAgo.getUTCMonth() + 1).padStart(2, '0');
    const d = String(sixtyDaysAgo.getUTCDate()).padStart(2, '0');
    const oldDir = `${y}-${mo}-${d}_02-00-00`;
    fs.mkdirSync(path.join(tmpDir, oldDir));
    fs.writeFileSync(path.join(tmpDir, oldDir, 'owner__repo.tar.gz'), 'old');

    pruneOldRunDirs(tmpDir, 30);

    expect(fs.existsSync(path.join(tmpDir, oldDir))).toBe(false);
  });

  it('keeps run folders within retentionDays', async () => {
    const { pruneOldRunDirs } = await imp();

    const yesterday = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    const y = yesterday.getUTCFullYear();
    const mo = String(yesterday.getUTCMonth() + 1).padStart(2, '0');
    const d = String(yesterday.getUTCDate()).padStart(2, '0');
    const recentDir = `${y}-${mo}-${d}_02-00-00`;
    fs.mkdirSync(path.join(tmpDir, recentDir));

    pruneOldRunDirs(tmpDir, 30);

    expect(fs.existsSync(path.join(tmpDir, recentDir))).toBe(true);
  });

  it('ignores non-dated directories', async () => {
    const { pruneOldRunDirs } = await imp();

    const otherDir = 'some-other-directory';
    fs.mkdirSync(path.join(tmpDir, otherDir));

    pruneOldRunDirs(tmpDir, 30);

    expect(fs.existsSync(path.join(tmpDir, otherDir))).toBe(true);
  });

  it('removes entire old run folder including all repo archives', async () => {
    const { pruneOldRunDirs } = await imp();

    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const y = oldDate.getUTCFullYear();
    const mo = String(oldDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(oldDate.getUTCDate()).padStart(2, '0');
    const oldDir = `${y}-${mo}-${d}_02-00-00`;
    fs.mkdirSync(path.join(tmpDir, oldDir));
    fs.writeFileSync(path.join(tmpDir, oldDir, 'org__repo-a.tar.gz'), 'a');
    fs.writeFileSync(path.join(tmpDir, oldDir, 'org__repo-b.tar.gz.unas'), 'b');

    pruneOldRunDirs(tmpDir, 30);

    expect(fs.existsSync(path.join(tmpDir, oldDir))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// archiveRepo
// ---------------------------------------------------------------------------

describe('archiveRepo', () => {
  it('throws when baseDir is empty', async () => {
    const { archiveRepo, loadArchiveConfig } = await imp();
    const cfg = loadArchiveConfig(); // baseDir = ''
    await expect(archiveRepo('owner', 'repo', cfg)).rejects.toThrow('baseDir is not configured');
  });

  it('calls git clone --mirror then tar', async () => {
    // jest.resetModules() in beforeEach creates a fresh spawn mock; retrieve it
    // via requireMock so we're controlling the same instance archiveService uses.
    const { spawn: freshSpawn } = jest.requireMock('child_process') as { spawn: jest.MockedFunction<typeof spawn> };
    freshSpawn
      .mockReturnValueOnce(fakeProc(0))  // git clone
      .mockReturnValueOnce(fakeProc(0)); // tar

    const { archiveRepo, loadArchiveConfig } = await imp();
    const cfg = { ...loadArchiveConfig(), githubToken: 'tok', baseDir: tmpDir };
    const dest = await archiveRepo('owner', 'repo', cfg);

    expect(freshSpawn).toHaveBeenCalledTimes(2);
    const gitArgs = freshSpawn.mock.calls[0][1] as string[];
    expect(gitArgs).toContain('--mirror');
    const tarArgs = freshSpawn.mock.calls[1][1] as string[];
    expect(tarArgs[0]).toBe('-czf');

    // Archive now lives inside a dated run folder: baseDir/YYYY-MM-DD_HH-MM-SS/owner__repo.tar.gz
    expect(dest).toMatch(/owner__repo\.tar\.gz$/);
    expect(dest.startsWith(tmpDir)).toBe(true);
    // Run folder is a direct child of baseDir
    const runDir = path.dirname(dest);
    expect(path.dirname(runDir)).toBe(tmpDir);
    expect(path.basename(runDir)).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
  });

  it('rejects when git clone fails', async () => {
    const { spawn: freshSpawn } = jest.requireMock('child_process') as { spawn: jest.MockedFunction<typeof spawn> };
    freshSpawn.mockReturnValueOnce(fakeProc(1, '', 'auth failed'));
    const { archiveRepo, loadArchiveConfig } = await imp();
    const cfg = { ...loadArchiveConfig(), githubToken: 'tok', baseDir: tmpDir };
    await expect(archiveRepo('owner', 'repo', cfg)).rejects.toThrow(/auth failed/);
  });
});

// ---------------------------------------------------------------------------
// scheduler lifecycle
// ---------------------------------------------------------------------------

describe('startArchiveScheduler / stopArchiveScheduler', () => {
  it('does not throw for empty entry list', async () => {
    const { startArchiveScheduler, stopArchiveScheduler } = await imp();
    expect(() =>
      startArchiveScheduler({
        githubToken: 'tok', baseDir: tmpDir, defaultFrequency: 'daily',
        retentionDays: 30, encrypt: false, passphrase: '', entries: [],
      }),
    ).not.toThrow();
    stopArchiveScheduler();
  });

  it('does not schedule when token or baseDir is empty', async () => {
    const { startArchiveScheduler, stopArchiveScheduler, loadArchiveConfig } = await imp();
    expect(() => startArchiveScheduler(loadArchiveConfig())).not.toThrow();
    stopArchiveScheduler();
  });

  it('stopArchiveScheduler is idempotent', async () => {
    const { stopArchiveScheduler } = await imp();
    expect(() => { stopArchiveScheduler(); stopArchiveScheduler(); }).not.toThrow();
  });
});
