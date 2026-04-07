import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';

export function createArtifactsRouter(workspaceRoot: string) {
  const router = Router();

  // GET /artifacts/:projectName/*path
  router.get('/:projectName/*', async (req, res) => {
    const { projectName } = req.params;
    // Express wildcard param — access via req.params[0]
    const filePath = (req.params as unknown as Record<string, string>)['0'] ?? '';

    // Reject access to .aido internals
    if (filePath.startsWith('.aido/') || filePath.includes('/.aido/')) {
      res.status(403).json({ error: 'Access to .aido directory is forbidden' });
      return;
    }

    const resolved = path.resolve(workspaceRoot, projectName, filePath);
    const projectRoot = path.resolve(workspaceRoot, projectName);

    // Clamp to project root
    if (!resolved.startsWith(projectRoot)) {
      res.status(403).json({ error: 'Path is outside project root' });
      return;
    }

    try {
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) {
        const entries = await fs.readdir(resolved);
        res.json({ type: 'directory', entries });
        return;
      }
      const content = await fs.readFile(resolved, 'utf-8');
      res.type('text/plain').send(content);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' });
      } else {
        res.status(500).json({ error: (err as Error).message });
      }
    }
  });

  return router;
}
