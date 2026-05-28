import fs from 'fs';
import os from 'os';
import path from 'path';
import { encryptFile, decryptFile } from '../src/services/encryptService';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-unas-enc-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// encryptFile
// ---------------------------------------------------------------------------

describe('encryptFile', () => {
  it('creates an output file larger than the input (header + ciphertext)', async () => {
    const src = path.join(tmpDir, 'plain.txt');
    const dst = path.join(tmpDir, 'plain.txt.unas');
    fs.writeFileSync(src, 'hello world');

    const result = await encryptFile({ source: src, destination: dst, passphrase: 'pass' });

    expect(fs.existsSync(dst)).toBe(true);
    expect(result.destination).toBe(dst);
    expect(result.bytesWritten).toBeGreaterThan('hello world'.length);
  });

  it('output starts with the UNAS magic bytes', async () => {
    const src = path.join(tmpDir, 'plain.bin');
    const dst = path.join(tmpDir, 'plain.bin.unas');
    fs.writeFileSync(src, Buffer.from([0xde, 0xad, 0xbe, 0xef]));

    await encryptFile({ source: src, destination: dst, passphrase: 'x' });

    const magic = fs.readFileSync(dst).subarray(0, 4);
    expect(magic.toString('ascii')).toBe('UNAS');
  });

  it('creates the destination directory if it does not exist', async () => {
    const src = path.join(tmpDir, 'plain.txt');
    const dst = path.join(tmpDir, 'nested', 'deep', 'out.unas');
    fs.writeFileSync(src, 'data');

    await encryptFile({ source: src, destination: dst, passphrase: 'abc' });

    expect(fs.existsSync(dst)).toBe(true);
  });

  it('produces different ciphertext each call (random IV + salt)', async () => {
    const src = path.join(tmpDir, 'plain.txt');
    fs.writeFileSync(src, 'same plaintext');

    const dst1 = path.join(tmpDir, 'out1.unas');
    const dst2 = path.join(tmpDir, 'out2.unas');
    await encryptFile({ source: src, destination: dst1, passphrase: 'p' });
    await encryptFile({ source: src, destination: dst2, passphrase: 'p' });

    expect(fs.readFileSync(dst1).equals(fs.readFileSync(dst2))).toBe(false);
  });

  it('rejects with ENOENT when source does not exist', async () => {
    await expect(
      encryptFile({ source: '/nonexistent/file.txt', destination: path.join(tmpDir, 'out.unas'), passphrase: 'x' }),
    ).rejects.toThrow(/ENOENT/);
  });
});

// ---------------------------------------------------------------------------
// decryptFile
// ---------------------------------------------------------------------------

describe('decryptFile', () => {
  it('round-trips: decrypt(encrypt(plaintext)) === plaintext', async () => {
    const plaintext = 'the quick brown fox jumps over the lazy dog';
    const src = path.join(tmpDir, 'plain.txt');
    const enc = path.join(tmpDir, 'enc.unas');
    const dec = path.join(tmpDir, 'dec.txt');
    fs.writeFileSync(src, plaintext);

    await encryptFile({ source: src, destination: enc, passphrase: 'my-passphrase' });
    const result = await decryptFile({ source: enc, destination: dec, passphrase: 'my-passphrase' });

    expect(fs.readFileSync(dec, 'utf8')).toBe(plaintext);
    expect(result.bytesWritten).toBe(Buffer.byteLength(plaintext));
    expect(result.destination).toBe(dec);
  });

  it('round-trips binary data without corruption', async () => {
    const data = Buffer.alloc(256, 0).map((_, i) => i);
    const src = path.join(tmpDir, 'bin.dat');
    const enc = path.join(tmpDir, 'bin.dat.unas');
    const dec = path.join(tmpDir, 'bin-out.dat');
    fs.writeFileSync(src, data);

    await encryptFile({ source: src, destination: enc, passphrase: 'key' });
    await decryptFile({ source: enc, destination: dec, passphrase: 'key' });

    expect(fs.readFileSync(dec).equals(data)).toBe(true);
  });

  it('round-trips an empty file', async () => {
    const src = path.join(tmpDir, 'empty.txt');
    const enc = path.join(tmpDir, 'empty.unas');
    const dec = path.join(tmpDir, 'empty-out.txt');
    fs.writeFileSync(src, '');

    await encryptFile({ source: src, destination: enc, passphrase: 'k' });
    await decryptFile({ source: enc, destination: dec, passphrase: 'k' });

    expect(fs.readFileSync(dec).length).toBe(0);
  });

  it('rejects with bad magic bytes for a non-encrypted file', async () => {
    const fake = path.join(tmpDir, 'fake.unas');
    fs.writeFileSync(fake, 'this is not encrypted');

    await expect(
      decryptFile({ source: fake, destination: path.join(tmpDir, 'out'), passphrase: 'x' }),
    ).rejects.toThrow(/bad magic bytes/);
  });

  it('rejects when passphrase is wrong (GCM auth tag mismatch)', async () => {
    const src = path.join(tmpDir, 'plain.txt');
    const enc = path.join(tmpDir, 'enc.unas');
    fs.writeFileSync(src, 'secret data');

    await encryptFile({ source: src, destination: enc, passphrase: 'correct-horse' });

    await expect(
      decryptFile({ source: enc, destination: path.join(tmpDir, 'out.txt'), passphrase: 'wrong-horse' }),
    ).rejects.toThrow();
  });

  it('creates the destination directory if it does not exist', async () => {
    const src = path.join(tmpDir, 'plain.txt');
    const enc = path.join(tmpDir, 'enc.unas');
    const dec = path.join(tmpDir, 'nested', 'out.txt');
    fs.writeFileSync(src, 'hi');

    await encryptFile({ source: src, destination: enc, passphrase: 'p' });
    await decryptFile({ source: enc, destination: dec, passphrase: 'p' });

    expect(fs.existsSync(dec)).toBe(true);
  });
});
