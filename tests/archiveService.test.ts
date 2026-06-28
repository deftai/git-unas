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
      baseDir: '/a', defaultFrequency: 'daily', encrypt: false, entries: [],
    });
    expect(masked.githubToken).toBe('***');
    expect(masked.passphrase).toBe('***');
  });

  it('keeps empty token as empty', async () => {
    const { maskedConfig } = await imp();
    const masked = maskedConfig({
      githubToken: '', passphrase: '',
      baseDir: '/a', defaultFrequency: 'daily', encrypt: false, entries: [],
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

    expect(dest).toMatch(/owner__repo__\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.tar\.gz$/);
    expect(dest.startsWith(tmpDir)).toBe(true);
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
        encrypt: false, passphrase: '', entries: [],
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
