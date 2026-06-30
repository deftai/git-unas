import { Router, Request, Response } from 'express';
import {
  getBwStatus,
  unlockVault,
  lockVault,
  syncVault,
  searchItems,
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
