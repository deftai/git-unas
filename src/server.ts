import express from 'express';
import path from 'path';
import { gitRouter } from './routes/git';
import { tarRouter } from './routes/tar';
import { encryptRouter } from './routes/encrypt';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 7892;

app.use(express.json());

// API routes
app.use('/api/git', gitRouter);
app.use('/api/tar', tarRouter);
app.use('/api/encrypt', encryptRouter);

// Health check
app.get('/api/status', (_req, res) => {
  res.json({ status: 'ok', version: process.env.npm_package_version ?? '0.0.0' });
});

// Serve admin UI
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

export { app };

if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`git-unas admin server listening on http://127.0.0.1:${PORT}`);
  });
}
