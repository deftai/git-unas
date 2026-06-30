import express from 'express';
import path from 'path';
import { gitRouter } from './routes/git';
import { tarRouter } from './routes/tar';
import { encryptRouter } from './routes/encrypt';
import { scheduleRouter } from './routes/schedule';
import { archiveRouter } from './routes/archive';
import { bitwardenRouter } from './routes/bitwarden';
import { browseRouter } from './routes/browse';
import { loadConfig, startScheduler } from './services/scheduleService';
import { loadArchiveConfig, startArchiveScheduler } from './services/archiveService';
import pkgJson from '../package.json';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 7892;

app.use(express.json());

// API routes
app.use('/api/git', gitRouter);
app.use('/api/tar', tarRouter);
app.use('/api/encrypt', encryptRouter);
app.use('/api/schedule', scheduleRouter);
app.use('/api/archive', archiveRouter);

// Health check
app.get('/api/status', (_req, res) => {
  res.json({ status: 'ok', version: pkgJson.version });
});

app.use('/api/bitwarden', bitwardenRouter);
app.use('/api/browse', browseRouter);

// Serve admin UI
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

export { app };

if (require.main === module) {
  // Auto-start schedulers from persisted config
  startScheduler(loadConfig());
  startArchiveScheduler(loadArchiveConfig());

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`git-unas admin server listening on http://127.0.0.1:${PORT}`);
  });
}
