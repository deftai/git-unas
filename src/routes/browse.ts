import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

export const browseRouter = Router();

export interface BrowseItem {
  name: string;
  isDir: boolean;
  path: string;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  items: BrowseItem[];
}

// GET /api/browse?path=<dir>
browseRouter.get('/', (req: Request, res: Response) => {
  const reqPath = typeof req.query.path === 'string' ? req.query.path : '/';
  const dirPath = path.resolve(reqPath);

  try {
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: 'Not a directory' });
      return;
    }

    const rawEntries = fs.readdirSync(dirPath, { withFileTypes: true });
    const items: BrowseItem[] = rawEntries
      .filter((e) => !e.name.startsWith('.')) // hide hidden entries
      .map((e) => ({
        name: e.name,
        isDir: e.isDirectory() || e.isSymbolicLink(),
        path: path.join(dirPath, e.name),
      }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    const parent = dirPath !== '/' ? path.dirname(dirPath) : null;

    const result: BrowseResult = { path: dirPath, parent, items };
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});
