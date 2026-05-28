import { Router, Request, Response } from 'express';
import { createArchive, extractArchive } from '../services/tarService';

export const tarRouter = Router();

// POST /api/tar/create
// Body: { source: string, destination: string, compress?: boolean }
tarRouter.post('/create', async (req: Request, res: Response) => {
  const { source, destination, compress } = req.body as {
    source?: string;
    destination?: string;
    compress?: boolean;
  };

  if (!source || !destination) {
    res.status(400).json({ error: 'source and destination are required' });
    return;
  }

  try {
    const result = await createArchive({ source, destination, compress: compress ?? true });
    res.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /api/tar/extract
// Body: { archive: string, destination: string }
tarRouter.post('/extract', async (req: Request, res: Response) => {
  const { archive, destination } = req.body as {
    archive?: string;
    destination?: string;
  };

  if (!archive || !destination) {
    res.status(400).json({ error: 'archive and destination are required' });
    return;
  }

  try {
    const result = await extractArchive({ archive, destination });
    res.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});
