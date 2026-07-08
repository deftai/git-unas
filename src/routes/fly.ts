import { Router, Request, Response } from 'express';
import {
  loadFlyArchiveConfig,
  saveFlyArchiveConfig,
  maskedFlyArchiveConfig,
  loadFlyArchiveRuns,
  runFlyArchive,
  startFlyArchiveScheduler,
  encryptFlyToken,
  decryptFlyToken,
  getFlyArchiveProgress,
  type FlyArchiveFrequency,
} from '../services/flyArchiveService';
import { verifyFlyToken } from '../services/flyService';

const VALID_FLY_FREQS: FlyArchiveFrequency[] = ['hourly', 'daily', 'weekly', 'monthly'];

export const flyRouter = Router();

// GET /api/fly/archive/config
flyRouter.get('/archive/config', (_req: Request, res: Response) => {
  res.json(maskedFlyArchiveConfig(loadFlyArchiveConfig()));
});

// POST /api/fly/archive/config
flyRouter.post('/archive/config', (req: Request, res: Response) => {
  try {
    const body = req.body as {
      baseDir?: string; orgSlug?: string; frequency?: string;
      retentionDays?: number; enabled?: boolean; token?: string;
    };
    const current = loadFlyArchiveConfig();

    const frequency = (body.frequency ?? current.frequency) as FlyArchiveFrequency;
    if (!VALID_FLY_FREQS.includes(frequency)) {
      res.status(400).json({ error: `frequency must be one of: ${VALID_FLY_FREQS.join(', ')}` }); return;
    }
    const retentionDays = body.retentionDays !== undefined
      ? Number(body.retentionDays) : current.retentionDays;
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 180) {
      res.status(400).json({ error: 'retentionDays must be 1–180' }); return;
    }

    const updated = {
      baseDir: typeof body.baseDir === 'string' ? body.baseDir : current.baseDir,
      orgSlug: typeof body.orgSlug === 'string' ? body.orgSlug.trim() : current.orgSlug,
      frequency,
      retentionDays,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
      encryptedToken: body.token ? encryptFlyToken(body.token) : current.encryptedToken,
    };
    saveFlyArchiveConfig(updated);
    startFlyArchiveScheduler(updated);
    res.json({ success: true, config: maskedFlyArchiveConfig(updated) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/fly/archive/status
// Verifies stored token against Fly API and returns org + app count.
flyRouter.get('/archive/status', async (_req: Request, res: Response) => {
  try {
    const config = loadFlyArchiveConfig();
    if (!config.encryptedToken) {
      res.json({ connected: false, reason: 'no_token' }); return;
    }
    if (!config.orgSlug) {
      res.json({ connected: false, reason: 'no_org' }); return;
    }
    const token = decryptFlyToken(config.encryptedToken);
    const result = await verifyFlyToken(token, config.orgSlug);
    res.json({ connected: true, orgSlug: result.orgSlug, appCount: result.appCount });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.json({ connected: false, reason: 'api_error', error: message });
  }
});

// POST /api/fly/archive/run
flyRouter.post('/archive/run', async (_req: Request, res: Response) => {
  try {
    const run = await runFlyArchive();
    res.json({ success: run.status !== 'error', run });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/fly/archive/runs
flyRouter.get('/archive/runs', (_req: Request, res: Response) => {
  res.json(loadFlyArchiveRuns());
});

// GET /api/fly/archive/progress
flyRouter.get('/archive/progress', (_req: Request, res: Response) => {
  res.json(getFlyArchiveProgress());
});

// ---------------------------------------------------------------------------
// Volume backup routes
// ---------------------------------------------------------------------------
import {
  loadFlyVolBackupConfig,
  saveFlyVolBackupConfig,
  loadFlyVolBackupRuns,
  runFlyVolBackup,
  getFlyVolBackupProgress,
  startFlyVolBackupScheduler,
  type FlyVolBackupConfig,
} from '../services/flyVolBackupService';

const VALID_VOL_FREQS: FlyArchiveFrequency[] = ['hourly', 'daily', 'weekly', 'monthly'];

// GET /api/fly/vol-backup/config
flyRouter.get('/vol-backup/config', (_req: Request, res: Response) => {
  res.json(loadFlyVolBackupConfig());
});

// POST /api/fly/vol-backup/config
flyRouter.post('/vol-backup/config', (req: Request, res: Response) => {
  try {
    const body = req.body as Partial<FlyVolBackupConfig>;
    const current = loadFlyVolBackupConfig();
    const frequency = (body.frequency ?? current.frequency) as FlyArchiveFrequency;
    if (!VALID_VOL_FREQS.includes(frequency)) {
      res.status(400).json({ error: `frequency must be one of: ${VALID_VOL_FREQS.join(', ')}` }); return;
    }
    const retentionDays = body.retentionDays !== undefined ? Number(body.retentionDays) : current.retentionDays;
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 180) {
      res.status(400).json({ error: 'retentionDays must be 1–180' }); return;
    }
    const maxVolumeMb = body.maxVolumeMb !== undefined ? Number(body.maxVolumeMb) : current.maxVolumeMb;
    if (!Number.isInteger(maxVolumeMb) || maxVolumeMb < 1) {
      res.status(400).json({ error: 'maxVolumeMb must be ≥1' }); return;
    }
    const execTimeoutSec = body.execTimeoutSec !== undefined ? Number(body.execTimeoutSec) : current.execTimeoutSec;
    if (!Number.isInteger(execTimeoutSec) || execTimeoutSec < 10 || execTimeoutSec > 300) {
      res.status(400).json({ error: 'execTimeoutSec must be 10–300' }); return;
    }
    const updated: FlyVolBackupConfig = {
      baseDir: typeof body.baseDir === 'string' ? body.baseDir : current.baseDir,
      orgSlug: typeof body.orgSlug === 'string' ? body.orgSlug.trim() : current.orgSlug,
      frequency, retentionDays, maxVolumeMb, execTimeoutSec,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
    };
    saveFlyVolBackupConfig(updated);
    startFlyVolBackupScheduler(updated);
    res.json({ success: true, config: updated });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/fly/vol-backup/run
flyRouter.post('/vol-backup/run', async (_req: Request, res: Response) => {
  try {
    const run = await runFlyVolBackup();
    res.json({ success: run.status !== 'error', run });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/fly/vol-backup/runs
flyRouter.get('/vol-backup/runs', (_req: Request, res: Response) => {
  res.json(loadFlyVolBackupRuns());
});

// GET /api/fly/vol-backup/progress
flyRouter.get('/vol-backup/progress', (_req: Request, res: Response) => {
  res.json(getFlyVolBackupProgress());
});
