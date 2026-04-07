import type { Server, Socket } from 'socket.io';
import { logBus } from '../utils/logger.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';

export function setupSocketHandlers(io: Server, orchestrator: Orchestrator): void {
  // Forward structured log entries to all connected browsers.
  logBus.on('log', (entry: Record<string, unknown>) => {
    io.emit('log', entry);
  });

  // Forward all orchestrator events to Socket.IO clients.
  orchestrator.on('task:created', (task) => io.emit('task:created', task));
  orchestrator.on('task:updated', (data) => io.emit('task:updated', data));
  orchestrator.on('agent:spawned', (data) => io.emit('agent:spawned', data));
  orchestrator.on('agent:output', (data) => io.emit('agent:output', data));
  orchestrator.on('agent:completed', (data) => io.emit('agent:completed', data));
  orchestrator.on('agent:terminated', (data) => io.emit('agent:terminated', data));
  orchestrator.on('budget:update', (data) => io.emit('budget:update', data));
  orchestrator.on('project:status', (data) => io.emit('project:status', data));
  orchestrator.on('claude-code:status', (data) => io.emit('claude-code:status', data));
  orchestrator.on('workspace:changed', (data) => io.emit('workspace:changed', data));

  io.on('connection', (socket: Socket) => {
    // Send current state snapshot on connect.
    socket.emit('project:status', { status: orchestrator.getStatus().status });

    socket.on('project:start', async (data: {
      modelsYaml: string;
      specMd: string;
      projectName?: string;
    }) => {
      try {
        const { loadModelsConfig } = await import('../config/loader.js');
        const { generateId } = await import('../utils/id.js');
        const config = await loadModelsConfig(data.modelsYaml, false);
        const name = data.projectName ?? `project-${generateId()}`;
        await orchestrator.start(name, data.specMd, config);
      } catch (err) {
        socket.emit('error', { message: (err as Error).message });
      }
    });

    socket.on('project:pause', () => orchestrator.pause());
    socket.on('project:resume', () => orchestrator.resume());

    socket.on('task:override', (data: { taskId: string; action: string }) => {
      orchestrator.overrideTask(data.taskId, data.action);
    });

    socket.on('team-lead:inject', (data: { message: string }) => {
      orchestrator.injectTeamLeadMessage(data.message);
    });
  });
}
