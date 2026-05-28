import { Router, Request, Response } from 'express';
import { cloneRepository } from '../services/gitService';

export const gitRouter = Router();

// POST /api/git/clone
// Body: { url: string, destination: string, branch?: string }
gitRouter.post('/clone', async (req: Request, res: Response) => {
  const { url, destination, branch } = req.body as {
    url?: string;
    destination?: string;
    branch?: string;
  };

  if (!url || !destination) {
    res.status(400).json({ error: 'url and destination are required' });
    return;
  }

  try {
    const result = await cloneRepository({ url, destination, branch });
    res.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});
