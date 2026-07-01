import { Router, Request, Response } from 'express';
import {
  hasUsers,
  createUser,
  verifyCredentials,
  findUserById,
  deleteUser,
  loadUsers,
  loadAuditLog,
  appendAuditLog,
  publicUser,
  beginTotpSetup,
  confirmTotpSetup,
  disableTotp,
  verifyTotp,
  type UserRole,
} from '../services/authService';

export const authRouter = Router();

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

// ---------------------------------------------------------------------------
// POST /api/auth/setup — first-run admin creation (disabled once any user exists)
// ---------------------------------------------------------------------------
authRouter.post('/setup', async (req: Request, res: Response) => {
  if (hasUsers()) {
    res.status(409).json({ error: 'Setup already complete' });
    return;
  }
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username?.trim() || !password) {
    res.status(400).json({ error: 'username and password are required' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }
  try {
    const user = await createUser(username.trim(), password, 'admin');
    appendAuditLog({ event: 'user_created', username: user.username, ip: clientIp(req), detail: 'initial admin' });
    res.json({ success: true, user: publicUser(user) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
authRouter.post('/login', async (req: Request, res: Response) => {
  const { username, password, totpCode } = req.body as {
    username?: string;
    password?: string;
    totpCode?: string;
  };
  if (!username || !password) {
    res.status(400).json({ error: 'username and password are required' });
    return;
  }

  const ip = clientIp(req);
  const user = await verifyCredentials(username, password);

  if (!user) {
    appendAuditLog({ event: 'login_failed', username, ip });
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  // If TOTP is enabled, validate code
  if (user.totpEnabled && user.totpSecret) {
    if (!totpCode) {
      // Signal the client that TOTP is required but don't log as failure yet
      res.status(200).json({ requires_totp: true });
      return;
    }
    if (!verifyTotp(user.totpSecret, totpCode)) {
      appendAuditLog({ event: 'login_failed', username, ip, detail: 'invalid TOTP' });
      res.status(401).json({ error: 'Invalid 2FA code' });
      return;
    }
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;

  appendAuditLog({ event: 'login', username: user.username, ip });
  res.json({ success: true, user: publicUser(user) });
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
authRouter.post('/logout', (req: Request, res: Response) => {
  const username = req.session.username ?? 'unknown';
  const ip = clientIp(req);
  req.session.destroy(() => {
    appendAuditLog({ event: 'logout', username, ip });
    res.json({ success: true });
  });
});

// ---------------------------------------------------------------------------
// GET /api/auth/me — current session info (or setup status)
// ---------------------------------------------------------------------------
authRouter.get('/me', (req: Request, res: Response) => {
  if (!hasUsers()) {
    res.json({ setup_required: true });
    return;
  }
  if (!req.session?.userId) {
    res.json({ authenticated: false });
    return;
  }
  const user = findUserById(req.session.userId);
  if (!user) {
    req.session.destroy(() => { /* noop */ });
    res.json({ authenticated: false });
    return;
  }
  res.json({ authenticated: true, user: publicUser(user) });
});

// ---------------------------------------------------------------------------
// Helpers for admin-only routes
// ---------------------------------------------------------------------------
function requireAdmin(req: Request, res: Response): boolean {
  if (!req.session?.userId) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  if (req.session.role !== 'admin') { res.status(403).json({ error: 'Admin required' }); return false; }
  return true;
}

// ---------------------------------------------------------------------------
// GET /api/auth/users — list all users (admin)
// ---------------------------------------------------------------------------
authRouter.get('/users', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  res.json({ users: loadUsers().map(publicUser) });
});

// ---------------------------------------------------------------------------
// POST /api/auth/users — create a user (admin)
// ---------------------------------------------------------------------------
authRouter.post('/users', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const { username, password, role } = req.body as {
    username?: string;
    password?: string;
    role?: string;
  };
  if (!username?.trim() || !password) {
    res.status(400).json({ error: 'username and password are required' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }
  const userRole: UserRole = role === 'admin' ? 'admin' : 'user';
  try {
    const user = await createUser(username.trim(), password, userRole);
    appendAuditLog({ event: 'user_created', username: user.username, ip: clientIp(req) });
    res.status(201).json({ success: true, user: publicUser(user) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/auth/users/:id — delete a user (admin)
// ---------------------------------------------------------------------------
authRouter.delete('/users/:id', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const id = req.params['id'] as string;
  if (id === req.session.userId) {
    res.status(400).json({ error: 'Cannot delete your own account' });
    return;
  }
  const user = findUserById(id);
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  deleteUser(id);
  appendAuditLog({ event: 'user_deleted', username: user.username, ip: clientIp(req) });
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /api/auth/users/:id/totp/setup — begin TOTP setup, returns QR + secret
// ---------------------------------------------------------------------------
authRouter.post('/users/:id/totp/setup', async (req: Request, res: Response) => {
  if (!req.session?.userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const id = req.params['id'] as string;
  // Users can only setup their own TOTP; admins can setup for anyone
  if (id !== req.session.userId && req.session.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  try {
    const result = await beginTotpSetup(id);
    res.json({ success: true, secret: result.secret, qrDataUrl: result.qrDataUrl });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/users/:id/totp/confirm — confirm TOTP with a code
// ---------------------------------------------------------------------------
authRouter.post('/users/:id/totp/confirm', (req: Request, res: Response) => {
  if (!req.session?.userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const id = req.params['id'] as string;
  if (id !== req.session.userId && req.session.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const { code } = req.body as { code?: string };
  if (!code) { res.status(400).json({ error: 'code is required' }); return; }
  const ok = confirmTotpSetup(id, code);
  if (!ok) { res.status(400).json({ error: 'Invalid code — check your authenticator app and try again' }); return; }
  const user = findUserById(id);
  if (user) appendAuditLog({ event: 'totp_enabled', username: user.username, ip: clientIp(req) });
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// DELETE /api/auth/users/:id/totp — disable TOTP
// ---------------------------------------------------------------------------
authRouter.delete('/users/:id/totp', (req: Request, res: Response) => {
  if (!req.session?.userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const id = req.params['id'] as string;
  if (id !== req.session.userId && req.session.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const user = findUserById(id);
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  disableTotp(id);
  appendAuditLog({ event: 'totp_disabled', username: user.username, ip: clientIp(req) });
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /api/auth/log — audit log (admin)
// ---------------------------------------------------------------------------
authRouter.get('/log', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(Number(req.query['limit'] ?? 100), 500);
  const log = loadAuditLog().slice(0, limit);
  res.json({ log });
});
