import { Router, Request, Response } from 'express';
import { encryptFile, decryptFile } from '../services/encryptService';

export const encryptRouter = Router();

// POST /api/encrypt/encrypt
// Body: { source: string, destination: string, passphrase: string }
encryptRouter.post('/encrypt', async (req: Request, res: Response) => {
  const { source, destination, passphrase } = req.body as {
    source?: string;
    destination?: string;
    passphrase?: string;
  };

  if (!source || !destination || !passphrase) {
    res.status(400).json({ error: 'source, destination, and passphrase are required' });
    return;
  }

  try {
    const result = await encryptFile({ source, destination, passphrase });
    res.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /api/encrypt/decrypt
// Body: { source: string, destination: string, passphrase: string }
encryptRouter.post('/decrypt', async (req: Request, res: Response) => {
  const { source, destination, passphrase } = req.body as {
    source?: string;
    destination?: string;
    passphrase?: string;
  };

  if (!source || !destination || !passphrase) {
    res.status(400).json({ error: 'source, destination, and passphrase are required' });
    return;
  }

  try {
    const result = await decryptFile({ source, destination, passphrase });
    res.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});
