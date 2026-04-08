import { useState } from 'react';
import { useAppStore } from '../stores/appStore.ts';
import { TaskGraph } from './TaskGraph.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { AgentCard } from './AgentCard.tsx';
import { TerminalView } from './TerminalView.tsx';
import { LogStream } from './LogStream.tsx';
import { FileExplorer } from './FileExplorer.tsx';
import { emitPause, emitResume, emitInject } from '../hooks/useSocket.ts';

export function Dashboard() {
  const tasks = Object.values(useAppStore((s) => s.tasks));
  const agents = Object.values(useAppStore((s) => s.agents));
  const budget = useAppStore((s) => s.budget);
  const projectStatus = useAppStore((s) => s.projectStatus);
  const projectName = useAppStore((s) => s.projectName) ?? '';
  const claudeCodeStatus = useAppStore((s) => s.claudeCodeStatus);
  const claudeCodeTaskId = useAppStore((s) => s.claudeCodeTaskId);
  const connected = useAppStore((s) => s.connected);

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'logs' | 'files'>('logs');
  const [injectMsg, setInjectMsg] = useState('');

  const paused = projectStatus === 'paused';

  const sendInject = () => {
    if (!injectMsg.trim()) return;
    emitInject(injectMsg.trim());
    setInjectMsg('');
  };

  const budgetPct = budget?.percentUsed ?? 0;
  const budgetColor = budgetPct > 90 ? 'bg-red-500' : budgetPct > 70 ? 'bg-yellow-500' : 'bg-green-500';

  const ccStatusColor: Record<string, string> = {
    idle: 'bg-green-800 text-green-300',
    busy: 'bg-blue-800 text-blue-300',
    'rate-limited': 'bg-orange-800 text-orange-300',
    unavailable: 'bg-red-800 text-red-300',
  };

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100 overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-gray-800 bg-gray-900">
        <span className="font-bold text-white">AIDO</span>
        <span className="text-gray-400 text-sm">{projectName}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full ${connected ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'}`}>
          {connected ? 'connected' : 'disconnected'}
        </span>
        <span className={`text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-300`}>
          {projectStatus}
        </span>

        {/* Claude Code status */}
        {claudeCodeStatus !== 'idle' && (
          <span className={`text-xs px-2 py-0.5 rounded-full ${ccStatusColor[claudeCodeStatus] ?? ccStatusColor.idle}`}>
            CC: {claudeCodeStatus}{claudeCodeTaskId ? ` (${claudeCodeTaskId.slice(0, 8)})` : ''}
          </span>
        )}

        {/* Controls */}
        <div className="flex items-center gap-2 ml-auto">
          <button
            onClick={paused ? emitResume : emitPause}
            className="px-3 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 transition-colors"
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <input
            className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 w-64 focus:outline-none focus:border-blue-500"
            placeholder="Inject instruction to Team Lead..."
            value={injectMsg}
            onChange={(e) => setInjectMsg(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendInject()}
          />
          <button
            onClick={sendInject}
            disabled={!injectMsg.trim()}
            className="px-3 py-1 text-xs rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50 transition-colors"
          >
            Send
          </button>
        </div>
      </div>

      {/* Budget bar */}
      {budget && (
        <div className="flex items-center gap-3 px-4 py-1.5 border-b border-gray-800 bg-gray-900/50 text-xs text-gray-400">
          <span>Budget</span>
          <div className="flex-1 max-w-xs bg-gray-700 rounded-full h-1.5">
            <div
              className={`${budgetColor} h-1.5 rounded-full transition-all`}
              style={{ width: `${Math.min(100, budgetPct)}%` }}
            />
          </div>
          <span>${budget.totalCost.toFixed(4)} / ${(budget.totalCost + budget.remaining).toFixed(2)}</span>
          <span>({budgetPct.toFixed(1)}%)</span>
        </div>
      )}

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Task graph — 60% */}
        <div className="flex-[3] border-r border-gray-800 overflow-hidden">
          <ErrorBoundary>
            <TaskGraph tasks={tasks} onTaskSelect={setSelectedTaskId} />
          </ErrorBoundary>
        </div>

        {/* Right panel — 40% */}
        <div className="flex-[2] flex flex-col overflow-hidden">
          {/* Agent cards */}
          <div className="border-b border-gray-800 p-3 overflow-y-auto max-h-64">
            <div className="text-xs text-gray-500 mb-2">Active Agents ({agents.length})</div>
            {agents.length === 0 ? (
              <div className="text-xs text-gray-600">No agents running</div>
            ) : (
              <div className="space-y-2">
                {agents.map((agent) => (
                  <AgentCard
                    key={agent.agentId}
                    agent={agent}
                    onClick={setSelectedAgentId}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Terminal / logs / files */}
          <div className="flex-1 flex flex-col overflow-hidden p-3">
            {selectedAgentId && (
              <div className="mb-3">
                <div className="text-xs text-gray-500 mb-1">
                  Agent: {selectedAgentId}
                  <button
                    className="ml-2 text-gray-600 hover:text-gray-400"
                    onClick={() => setSelectedAgentId(null)}
                  >
                    ✕
                  </button>
                </div>
                <TerminalView agentId={selectedAgentId} />
              </div>
            )}

            <div className="flex gap-2 mb-2">
              <button
                onClick={() => setActiveTab('logs')}
                className={`text-xs px-3 py-1 rounded ${activeTab === 'logs' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
              >
                Logs
              </button>
              <button
                onClick={() => setActiveTab('files')}
                className={`text-xs px-3 py-1 rounded ${activeTab === 'files' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
              >
                Files
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              {activeTab === 'logs' ? (
                <LogStream />
              ) : (
                <FileExplorer projectName={projectName} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
