import express from 'express';
import type { Server } from 'socket.io';
import { createApiRouter } from './routes/api.js';
import { createArtifactsRouter } from './routes/artifacts.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import type { WorkspaceManager } from '../workspace/manager.js';

export function createApp(
  io: Server,
  orchestrator: Orchestrator,
  workspaceManager: WorkspaceManager,
  workspaceRoot: string,
) {
  const app = express();

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // CORS — allow all origins in dev
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    next();
  });

  app.use('/api', createApiRouter(io, orchestrator, workspaceManager));
  app.use('/artifacts', createArtifactsRouter(workspaceRoot));

  return app;
}
