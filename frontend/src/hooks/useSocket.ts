import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAppStore } from '../stores/appStore.ts';
import type { Task, AgentInfo, BudgetState, LogEntry } from '../types/index.ts';

// Module-level singleton — creating a new socket on every render would reconnect
// on every component mount. This must live outside any React component/hook.
let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });
  }
  return socket;
}

export function useSocket() {
  const store = useAppStore();

  useEffect(() => {
    const s = getSocket();
    const { setConnected, upsertTask, upsertAgent, appendAgentOutput, removeAgent, updateBudget, appendLog, setProjectStatus, setClaudeCodeStatus } = useAppStore.getState();

    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));

    s.on('task:created', (task: Task) => upsertTask(task));
    s.on('task:updated', (task: Task) => upsertTask(task));

    s.on('agent:spawned', (agent: AgentInfo) => upsertAgent(agent));
    s.on('agent:output', (data: { agentId: string; chunk: string }) =>
      appendAgentOutput(data.agentId, data.chunk),
    );
    s.on('agent:completed', (data: { agentId: string; taskId: string }) => {
      removeAgent(data.agentId);
    });
    s.on('agent:terminated', (data: { agentId: string }) => {
      removeAgent(data.agentId);
    });

    s.on('budget:update', (data: BudgetState) => updateBudget(data));

    s.on('project:status', (data: { status: string; projectName?: string }) => {
      setProjectStatus(data.status as any, data.projectName);
    });

    s.on('claude-code:status', (data: { status: string; taskId?: string; cooldownUntil?: string }) => {
      setClaudeCodeStatus(data.status as any, data.taskId, data.cooldownUntil);
    });

    s.on('log', (entry: LogEntry) => appendLog(entry));

    return () => {
      // Don't disconnect — other components may need the socket.
      // Just remove this effect's listeners.
      s.off('connect');
      s.off('disconnect');
      s.off('task:created');
      s.off('task:updated');
      s.off('agent:spawned');
      s.off('agent:output');
      s.off('agent:completed');
      s.off('agent:terminated');
      s.off('budget:update');
      s.off('project:status');
      s.off('claude-code:status');
      s.off('log');
    };
  }, []);

  return { socket: getSocket(), connected: store.connected };
}

export function emitPause() { getSocket().emit('project:pause'); }
export function emitResume() { getSocket().emit('project:resume'); }
export function emitInject(message: string) { getSocket().emit('team-lead:inject', { message }); }
export function emitOverride(taskId: string, action: string) { getSocket().emit('task:override', { taskId, action }); }
