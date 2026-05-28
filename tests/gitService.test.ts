import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { cloneRepository } from '../src/services/gitService';

jest.mock('child_process');
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

/** Build a fake child process that emits stdout/stderr data then closes. */
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

describe('cloneRepository', () => {
  it('resolves with destination and combined output on exit code 0', async () => {
    mockSpawn.mockReturnValue(fakeProc(0, 'Cloning into', ' repo...'));
    const result = await cloneRepository({
      url: 'https://github.com/x/y.git',
      destination: '/mnt/nas/repo',
    });
    expect(result.destination).toBe('/mnt/nas/repo');
    expect(result.output).toBe('Cloning into repo...');
  });

  it('calls git with correct base arguments', async () => {
    mockSpawn.mockReturnValue(fakeProc(0));
    await cloneRepository({ url: 'https://github.com/x/y.git', destination: '/dest' });
    expect(mockSpawn).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['clone', '--progress', '--', 'https://github.com/x/y.git', '/dest']),
      expect.any(Object),
    );
  });

  it('includes --branch flag when branch is provided', async () => {
    mockSpawn.mockReturnValue(fakeProc(0));
    await cloneRepository({ url: 'https://github.com/x/y.git', destination: '/dest', branch: 'dev' });
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--branch');
    expect(args).toContain('dev');
  });

  it('omits --branch flag when branch is undefined', async () => {
    mockSpawn.mockReturnValue(fakeProc(0));
    await cloneRepository({ url: 'https://github.com/x/y.git', destination: '/dest' });
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain('--branch');
  });

  it('rejects with error message containing exit code on non-zero exit', async () => {
    mockSpawn.mockReturnValue(fakeProc(128, '', 'repository not found'));
    await expect(
      cloneRepository({ url: 'https://github.com/x/bad.git', destination: '/dest' }),
    ).rejects.toThrow(/exit 128/);
  });

  it('includes stderr output in rejection message', async () => {
    mockSpawn.mockReturnValue(fakeProc(1, '', 'Permission denied'));
    await expect(
      cloneRepository({ url: 'https://github.com/x/bad.git', destination: '/dest' }),
    ).rejects.toThrow(/Permission denied/);
  });

  it('rejects when spawn emits an error event', async () => {
    const proc = new EventEmitter() as ReturnType<typeof spawn>;
    (proc as any).stdout = new EventEmitter();
    (proc as any).stderr = new EventEmitter();
    setImmediate(() => proc.emit('error', new Error('spawn git ENOENT')));
    mockSpawn.mockReturnValue(proc);

    await expect(
      cloneRepository({ url: 'https://github.com/x/y.git', destination: '/dest' }),
    ).rejects.toThrow(/Failed to spawn git/);
  });
});
