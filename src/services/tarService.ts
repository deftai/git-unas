import { spawn } from 'child_process';
import path from 'path';

export interface CreateArchiveOptions {
  source: string;
  destination: string;
  compress: boolean;
}

export interface ExtractArchiveOptions {
  archive: string;
  destination: string;
}

export interface ArchiveResult {
  path: string;
  output: string;
}

export function createArchive(options: CreateArchiveOptions): Promise<ArchiveResult> {
  const { source, destination, compress } = options;

  // Resolve source into dir + basename so tar doesn't embed absolute paths
  const sourceDir = path.dirname(source);
  const sourceName = path.basename(source);

  const flags = compress ? '-czf' : '-cf';
  const args = [flags, destination, '-C', sourceDir, '--', sourceName];

  return new Promise((resolve, reject) => {
    const proc = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const output: string[] = [];

    proc.stdout.on('data', (d: Buffer) => output.push(d.toString()));
    proc.stderr.on('data', (d: Buffer) => output.push(d.toString()));

    proc.on('close', (code) => {
      const text = output.join('');
      if (code === 0) {
        resolve({ path: destination, output: text });
      } else {
        reject(new Error(`tar create failed (exit ${code}): ${text}`));
      }
    });

    proc.on('error', (err) => reject(new Error(`Failed to spawn tar: ${err.message}`)));
  });
}

export function extractArchive(options: ExtractArchiveOptions): Promise<ArchiveResult> {
  const { archive, destination } = options;
  const args = ['-xf', archive, '-C', destination];

  return new Promise((resolve, reject) => {
    const proc = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const output: string[] = [];

    proc.stdout.on('data', (d: Buffer) => output.push(d.toString()));
    proc.stderr.on('data', (d: Buffer) => output.push(d.toString()));

    proc.on('close', (code) => {
      const text = output.join('');
      if (code === 0) {
        resolve({ path: destination, output: text });
      } else {
        reject(new Error(`tar extract failed (exit ${code}): ${text}`));
      }
    });

    proc.on('error', (err) => reject(new Error(`Failed to spawn tar: ${err.message}`)));
  });
}
