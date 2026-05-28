import { spawn } from 'child_process';

export interface CloneOptions {
  url: string;
  destination: string;
  branch?: string;
}

export interface CloneResult {
  destination: string;
  output: string;
}

export function cloneRepository(options: CloneOptions): Promise<CloneResult> {
  const { url, destination, branch } = options;

  const args = ['clone', '--progress'];
  if (branch) {
    args.push('--branch', branch);
  }
  args.push('--', url, destination);

  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const output: string[] = [];

    proc.stdout.on('data', (d: Buffer) => output.push(d.toString()));
    proc.stderr.on('data', (d: Buffer) => output.push(d.toString()));

    proc.on('close', (code) => {
      const text = output.join('');
      if (code === 0) {
        resolve({ destination, output: text });
      } else {
        reject(new Error(`git clone failed (exit ${code}): ${text}`));
      }
    });

    proc.on('error', (err) => reject(new Error(`Failed to spawn git: ${err.message}`)));
  });
}
