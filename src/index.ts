import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { logger } from './utils/logger.js';
import { WorkspaceManager } from './workspace/manager.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { createApp } from './server/app.js';
import { setupSocketHandlers } from './server/ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const WORKSPACE_ROOT = process.env['WORKSPACE_ROOT'] ?? '/workspace';

async function main(): Promise<void> {
  const workspaceManager = new WorkspaceManager(WORKSPACE_ROOT);
  const orchestrator = new Orchestrator(workspaceManager);

  // Create HTTP server and attach Socket.IO
  const app = express();
  const httpServer = http.createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: { origin: '*' },
  });

  // Build the Express app (routes, middleware)
  const expressApp = createApp(io, orchestrator, workspaceManager, WORKSPACE_ROOT);
  app.use(expressApp);

  // Serve built frontend if available
  const publicDir = path.join(__dirname, 'server', 'public');
  app.use(express.static(publicDir));
  // SPA fallback — serve index.html for any unmatched route
  app.get('*', (_req, res) => {
    const indexPath = path.join(publicDir, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) res.status(404).send('Frontend not built. Run: cd frontend && npm run build');
    });
  });

  setupSocketHandlers(io, orchestrator);

  httpServer.listen(PORT, () => {
    logger.info({ port: PORT, workspaceRoot: WORKSPACE_ROOT }, 'AIDO server started');
    logger.info(`Open http://localhost:${PORT} in your browser`);
  });

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    orchestrator.stop();
    httpServer.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error during startup');
  process.exit(1);
});
