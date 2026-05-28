import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { createArchive, extractArchive } from '../src/services/tarService';

jest.mock('child_process');
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

function fakeProc(exitCode: number, stdout = '', stderr = '') {
  const proc = new EventEmitter() as ReturnType<typeof spawn>;
  (proc as any).stdout = new EventEmitter();
  (proc as any).stderr = new EventEmitter();

  setImmediate(() => {
    if (stdout) (proc as any).stdout.emit('data', Buffer.from(stdout));
    if (stderr) (proc as any).stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', exitCode);
  });

  return proc;
}

beforeEach(() => {
  mockSpawn.mockReset();
});

// ---------------------------------------------------------------------------
// createArchive
// ---------------------------------------------------------------------------

describe('createArchive', () => {
  it('resolves with destination path on exit code 0', async () => {
    mockSpawn.mockReturnValue(fakeProc(0));
    const result = await createArchive({
      source: '/data/files',
      destination: '/out/archive.tar.gz',
      compress: true,
    });
    expect(result.path).toBe('/out/archive.tar.gz');
    expect(result.output).toBe('');
  });

  it('uses -czf flag when compress is true', async () => {
    mockSpawn.mockReturnValue(fakeProc(0));
    await createArchive({ source: '/data/files', destination: '/out/a.tar.gz', compress: true });
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args[0]).toBe('-czf');
  });

  it('uses -cf flag when compress is false', async () => {
    mockSpawn.mockReturnValue(fakeProc(0));
    await createArchive({ source: '/data/files', destination: '/out/a.tar', compress: false });
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args[0]).toBe('-cf');
  });

  it('passes -C <dir> and basename to avoid absolute paths in archive', async () => {
    mockSpawn.mockReturnValue(fakeProc(0));
    await createArchive({ source: '/data/mydir', destination: '/out/a.tar.gz', compress: true });
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('-C');
    expect(args).toContain('/data');  // dirname
    expect(args).toContain('mydir'); // basename
  });

  it('rejects with error message on non-zero exit', async () => {
    mockSpawn.mockReturnValue(fakeProc(1, '', 'No such file'));
    await expect(
      createArchive({ source: '/data/files', destination: '/out/a.tar.gz', compress: true }),
    ).rejects.toThrow(/tar create failed.*exit 1/);
  });

  it('includes stderr in rejection message', async () => {
    mockSpawn.mockReturnValue(fakeProc(2, '', 'permission denied'));
    await expect(
      createArchive({ source: '/data/files', destination: '/out/a.tar.gz', compress: true }),
    ).rejects.toThrow(/permission denied/);
  });

  it('rejects on spawn error event', async () => {
    const proc = new EventEmitter() as ReturnType<typeof spawn>;
    (proc as any).stdout = new EventEmitter();
    (proc as any).stderr = new EventEmitter();
    setImmediate(() => proc.emit('error', new Error('spawn tar ENOENT')));
    mockSpawn.mockReturnValue(proc);

    await expect(
      createArchive({ source: '/data', destination: '/out/a.tar.gz', compress: true }),
    ).rejects.toThrow(/Failed to spawn tar/);
  });
});

// ---------------------------------------------------------------------------
// extractArchive
// ---------------------------------------------------------------------------

describe('extractArchive', () => {
  it('resolves with destination path on exit code 0', async () => {
    mockSpawn.mockReturnValue(fakeProc(0));
    const result = await extractArchive({ archive: '/data/archive.tar.gz', destination: '/out' });
    expect(result.path).toBe('/out');
  });

  it('calls tar with -xf and -C flags', async () => {
    mockSpawn.mockReturnValue(fakeProc(0));
    await extractArchive({ archive: '/data/archive.tar.gz', destination: '/out' });
    expect(mockSpawn).toHaveBeenCalledWith(
      'tar',
      ['-xf', '/data/archive.tar.gz', '-C', '/out'],
      expect.any(Object),
    );
  });

  it('captures stdout in the result output', async () => {
    mockSpawn.mockReturnValue(fakeProc(0, 'extracting...', ''));
    const result = await extractArchive({ archive: '/a.tar.gz', destination: '/out' });
    expect(result.output).toContain('extracting...');
  });

  it('rejects with error message on non-zero exit', async () => {
    mockSpawn.mockReturnValue(fakeProc(2, '', 'corrupt archive'));
    await expect(
      extractArchive({ archive: '/bad.tar.gz', destination: '/out' }),
    ).rejects.toThrow(/tar extract failed.*exit 2/);
  });

  it('rejects on spawn error event', async () => {
    const proc = new EventEmitter() as ReturnType<typeof spawn>;
    (proc as any).stdout = new EventEmitter();
    (proc as any).stderr = new EventEmitter();
    setImmediate(() => proc.emit('error', new Error('spawn tar ENOENT')));
    mockSpawn.mockReturnValue(proc);

    await expect(
      extractArchive({ archive: '/a.tar.gz', destination: '/out' }),
    ).rejects.toThrow(/Failed to spawn tar/);
  });
});
