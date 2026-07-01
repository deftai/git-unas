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
