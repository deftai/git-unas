import path from 'path';
import { Router, Request, Response } from 'express';
import {
  getBwStatus,
  unlockVault,
  lockVault,
  syncVault,
  searchItems,
  installBw,
  loginBw,
  logoutBw,
} from '../services/bitwardenService';
import {
  loadBwArchiveConfig,
  saveBwArchiveConfig,
  maskedBwArchiveConfig,
  loadBwArchiveRuns,
  runBwExport,
  startBwArchiveScheduler,
  encryptPassword,
  decryptPassword,
  type BwArchiveFrequency,
} from '../services/bitwardenArchiveService';
import { decryptBwExport } from '../services/bitwardenDecryptService';

const VALID_BW_FREQS: BwArchiveFrequency[] = ['hourly', 'daily', 'weekly', 'monthly'];

export const bitwardenRouter = Router();

// GET /api/bitwarden/status
bitwardenRouter.get('/status', async (_req: Request, res: Response) => {
  const result = await getBwStatus();
  res.json(result);
});

// POST /api/bitwarden/unlock  { password: string }
bitwardenRouter.post('/unlock', async (req: Request, res: Response) => {
  const { password } = req.body as { password?: string };
  if (!password) {
    res.status(400).json({ error: 'password is required' });
    return;
  }
  try {
    await unlockVault(password);
    const status = await getBwStatus();
    res.json({ success: true, status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /api/bitwarden/lock
bitwardenRouter.post('/lock', async (_req: Request, res: Response) => {
  await lockVault();
  res.json({ success: true });
});

// POST /api/bitwarden/sync
bitwardenRouter.post('/sync', async (_req: Request, res: Response) => {
  try {
    await syncVault();
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /api/bitwarden/install  { serverUrl?: string }
bitwardenRouter.post('/install', async (req: Request, res: Response) => {
  // Allow up to 3 minutes — download + extract can be slow on the NAS
  req.socket.setTimeout(180_000);
  const { serverUrl } = req.body as { serverUrl?: string };
  try {
    const result = await installBw(serverUrl);
    const status = await getBwStatus();
    res.json({ success: true, version: result.version, status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /api/bitwarden/login  { email, password, twoFactorCode? }
bitwardenRouter.post('/login', async (req: Request, res: Response) => {
  const { email, password, twoFactorCode } = req.body as {
    email?: string;
    password?: string;
    twoFactorCode?: string;
  };
  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }
  try {
    await loginBw(email, password, twoFactorCode);
    const status = await getBwStatus();
    res.json({ success: true, status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /api/bitwarden/logout
bitwardenRouter.post('/logout', async (_req: Request, res: Response) => {
  await logoutBw();
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Bitwarden Archive
// ---------------------------------------------------------------------------

// GET /api/bitwarden/archive/config
bitwardenRouter.get('/archive/config', (_req: Request, res: Response) => {
  res.json(maskedBwArchiveConfig(loadBwArchiveConfig()));
});

// POST /api/bitwarden/archive/config
bitwardenRouter.post('/archive/config', (req: Request, res: Response) => {
  const body = req.body as {
    baseDir?: string; frequency?: string; retentionDays?: number;
    enabled?: boolean; password?: string;
  };
  const current = loadBwArchiveConfig();
  const frequency = (body.frequency ?? current.frequency) as BwArchiveFrequency;
  if (!VALID_BW_FREQS.includes(frequency)) {
    res.status(400).json({ error: `frequency must be one of: ${VALID_BW_FREQS.join(', ')}` }); return;
  }
  const retentionDays = body.retentionDays !== undefined ? Number(body.retentionDays) : current.retentionDays;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 180) {
    res.status(400).json({ error: 'retentionDays must be 1–180' }); return;
  }
  const updated = {
    baseDir: typeof body.baseDir === 'string' ? body.baseDir : current.baseDir,
    frequency,
    retentionDays,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
    encryptedPassword: body.password ? encryptPassword(body.password) : current.encryptedPassword,
    accountEmail: current.accountEmail,
  };
  saveBwArchiveConfig(updated);
  startBwArchiveScheduler(updated);
  res.json({ success: true, config: maskedBwArchiveConfig(updated) });
});

// POST /api/bitwarden/archive/run
bitwardenRouter.post('/archive/run', async (_req: Request, res: Response) => {
  try {
    const run = await runBwExport();
    res.json({ success: run.status !== 'error', run });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/bitwarden/archive/runs
bitwardenRouter.get('/archive/runs', (_req: Request, res: Response) => {
  res.json(loadBwArchiveRuns());
});

// POST /api/bitwarden/archive/decrypt  { filePath: string }
// Decrypts a Bitwarden encrypted_json export offline using stored credentials.
bitwardenRouter.post('/archive/decrypt', async (req: Request, res: Response) => {
  try {
    const { filePath } = req.body as { filePath?: string };
    if (!filePath) {
      res.status(400).json({ error: 'filePath is required' }); return;
    }

    const config = loadBwArchiveConfig();

    // Path-traversal guard: filePath must resolve within configured baseDir
    if (!config.baseDir) {
      res.status(400).json({ error: 'Archive base directory is not configured' }); return;
    }
    const resolved = path.resolve(filePath);
    const base = path.resolve(config.baseDir);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      res.status(403).json({ error: 'filePath must be within the configured archive directory' }); return;
    }

    if (!config.accountEmail) {
      res.status(400).json({
        error: 'Account email is not stored — run a Vault Archive export first so the email is captured automatically',
      }); return;
    }
    if (!config.encryptedPassword) {
      res.status(400).json({ error: 'Master password is not stored — set it in Vault Archive settings' }); return;
    }

    let masterPassword: string;
    try {
      masterPassword = decryptPassword(config.encryptedPassword);
    } catch {
      res.status(500).json({ error: 'Failed to decrypt stored master password' }); return;
    }

    const vault = await decryptBwExport(resolved, masterPassword, config.accountEmail);
    res.json(vault);
  } catch (err) {
    // Top-level catch: ensures this route always returns JSON, never an Express HTML error page
    const message = err instanceof Error ? err.message : String(err);
    console.error('[decrypt] unhandled error:', message);
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  }
});

// GET /api/bitwarden/items?search=<query>
bitwardenRouter.get('/items', async (req: Request, res: Response) => {
  const search = typeof req.query.search === 'string' ? req.query.search : '';
  try {
    const items = await searchItems(search);
    res.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});
