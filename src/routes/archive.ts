import { Router, Request, Response } from 'express';
import {
  loadArchiveConfig,
  saveArchiveConfig,
  maskedConfig,
  startArchiveScheduler,
  runEntryNow,
  runAllNow,
  newEntryId,
  nextRunDate,
  type ArchiveEntry,
  type ArchiveConfig,
  type Frequency,
} from '../services/archiveService';
import {
  listUserOrgs,
  listOrgRepos,
  listUserRepos,
  validateToken,
} from '../services/githubService';

export const archiveRouter = Router();

const VALID_FREQUENCIES: Frequency[] = ['hourly', 'daily', 'weekly', 'monthly'];

// ---------------------------------------------------------------------------
// GET /api/archive/config
// ---------------------------------------------------------------------------
archiveRouter.get('/config', (_req: Request, res: Response) => {
  const config = loadArchiveConfig();
  res.json(maskedConfig(config));
});

// ---------------------------------------------------------------------------
// POST /api/archive/config
// Accepts the full config object. Token/passphrase of "***" means keep existing.
// ---------------------------------------------------------------------------
archiveRouter.post('/config', (req: Request, res: Response) => {
  const body = req.body as Partial<ArchiveConfig>;
  const current = loadArchiveConfig();

  const freq = (body.defaultFrequency ?? current.defaultFrequency) as Frequency;
  if (!VALID_FREQUENCIES.includes(freq)) {
    res.status(400).json({ error: `defaultFrequency must be one of: ${VALID_FREQUENCIES.join(', ')}` });
    return;
  }

  const retentionDays = body.retentionDays !== undefined ? Number(body.retentionDays) : current.retentionDays;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 180) {
    res.status(400).json({ error: 'retentionDays must be an integer between 1 and 180' });
    return;
  }

  const updated: ArchiveConfig = {
    githubToken:
      body.githubToken === '***' || body.githubToken === undefined
        ? current.githubToken
        : body.githubToken,
    passphrase:
      body.passphrase === '***' || body.passphrase === undefined
        ? current.passphrase
        : body.passphrase,
    baseDir: typeof body.baseDir === 'string' ? body.baseDir : current.baseDir,
    defaultFrequency: freq,
    retentionDays,
    encrypt: typeof body.encrypt === 'boolean' ? body.encrypt : current.encrypt,
    entries: Array.isArray(body.entries) ? body.entries : current.entries,
  };

  saveArchiveConfig(updated);
  startArchiveScheduler(updated);

  res.json({ success: true, config: maskedConfig(updated) });
});

// ---------------------------------------------------------------------------
// POST /api/archive/config/validate-token
// ---------------------------------------------------------------------------
archiveRouter.post('/config/validate-token', async (req: Request, res: Response) => {
  const { token } = req.body as { token?: string };
  const resolved = (token && token !== '***') ? token : loadArchiveConfig().githubToken;
  if (!resolved) { res.status(400).json({ error: 'No token supplied' }); return; }
  try {
    const login = await validateToken(resolved);
    res.json({ valid: true, login });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ valid: false, error: message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/archive/orgs  — list orgs accessible to the configured token
// ---------------------------------------------------------------------------
archiveRouter.get('/orgs', async (_req: Request, res: Response) => {
  const { githubToken } = loadArchiveConfig();
  if (!githubToken) { res.status(400).json({ error: 'GitHub token not configured' }); return; }
  try {
    const orgs = await listUserOrgs(githubToken);
    res.json({ orgs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/archive/repos?org=<org>
// Returns org repos when ?org is supplied, user-owned repos otherwise.
// ---------------------------------------------------------------------------
archiveRouter.get('/repos', async (req: Request, res: Response) => {
  const { githubToken } = loadArchiveConfig();
  if (!githubToken) { res.status(400).json({ error: 'GitHub token not configured' }); return; }

  const org = req.query['org'] as string | undefined;
  try {
    const repos = org
      ? await listOrgRepos(githubToken, org)
      : await listUserRepos(githubToken);
    res.json({ repos: repos.map((r) => ({ name: r.name, private: r.private, archived: r.archived, description: r.description })) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/archive/status  — entries with nextRun computed
// ---------------------------------------------------------------------------
archiveRouter.get('/status', (_req: Request, res: Response) => {
  const config = loadArchiveConfig();
  const entries = config.entries.map((e) => {
    const freq = e.frequency ?? config.defaultFrequency;
    const next = e.enabled ? nextRunDate(freq) : null;
    return { ...e, effectiveFrequency: freq, nextRun: next?.toISOString() ?? null };
  });
  res.json({ entries, defaultFrequency: config.defaultFrequency });
});

// ---------------------------------------------------------------------------
// POST /api/archive/entries  — add a new entry
// ---------------------------------------------------------------------------
archiveRouter.post('/entries', (req: Request, res: Response) => {
  const body = req.body as Partial<ArchiveEntry>;

  if (!body.type || !['repo', 'org'].includes(body.type)) {
    res.status(400).json({ error: 'type must be "repo" or "org"' });
    return;
  }
  if (!body.owner) { res.status(400).json({ error: 'owner is required' }); return; }
  if (body.type === 'repo' && !body.repo) {
    res.status(400).json({ error: 'repo is required for type=repo' });
    return;
  }
  if (body.frequency && !VALID_FREQUENCIES.includes(body.frequency)) {
    res.status(400).json({ error: `frequency must be one of: ${VALID_FREQUENCIES.join(', ')}` });
    return;
  }

  let entryRetention: number | null = null;
  if (body.retentionDays !== undefined && body.retentionDays !== null) {
    const r = Number(body.retentionDays);
    if (!Number.isInteger(r) || r < 1 || r > 180) {
      res.status(400).json({ error: 'retentionDays must be an integer between 1 and 180' });
      return;
    }
    entryRetention = r;
  }

  const config = loadArchiveConfig();
  const entry: ArchiveEntry = {
    id: newEntryId(),
    type: body.type,
    owner: body.owner,
    repo: body.type === 'repo' ? body.repo : undefined,
    includeRepos: body.includeRepos ?? ['*'],
    excludeRepos: body.excludeRepos ?? [],
    frequency: body.frequency ?? null,
    retentionDays: entryRetention,
    enabled: body.enabled ?? true,
    lastRun: null,
    lastStatus: null,
    lastMessage: null,
  };

  config.entries.push(entry);
  saveArchiveConfig(config);
  startArchiveScheduler(config);

  res.status(201).json({ success: true, entry });
});

// ---------------------------------------------------------------------------
// PATCH /api/archive/entries/:id  — update an existing entry
// ---------------------------------------------------------------------------
archiveRouter.patch('/entries/:id', (req: Request, res: Response) => {
  const id = req.params['id'] as string;
  const config = loadArchiveConfig();
  const idx = config.entries.findIndex((e) => e.id === id);
  if (idx === -1) { res.status(404).json({ error: 'Entry not found' }); return; }

  const patch = req.body as Partial<ArchiveEntry>;
  config.entries[idx] = { ...config.entries[idx], ...patch, id };
  saveArchiveConfig(config);
  startArchiveScheduler(config);

  res.json({ success: true, entry: config.entries[idx] });
});

// ---------------------------------------------------------------------------
// DELETE /api/archive/entries/:id
// ---------------------------------------------------------------------------
archiveRouter.delete('/entries/:id', (req: Request, res: Response) => {
  const id = req.params['id'] as string;
  const config = loadArchiveConfig();
  const before = config.entries.length;
  config.entries = config.entries.filter((e) => e.id !== id);
  if (config.entries.length === before) {
    res.status(404).json({ error: 'Entry not found' });
    return;
  }
  saveArchiveConfig(config);
  startArchiveScheduler(config);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /api/archive/run  — run all enabled entries immediately
// ---------------------------------------------------------------------------
archiveRouter.post('/run', async (_req: Request, res: Response) => {
  try {
    await runAllNow();
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/archive/run/:id  — run one entry immediately
// ---------------------------------------------------------------------------
archiveRouter.post('/run/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] as string;
  try {
    await runEntryNow(id);
    const config = loadArchiveConfig();
    const entry = config.entries.find((e) => e.id === id);
    res.json({ success: true, entry });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});
