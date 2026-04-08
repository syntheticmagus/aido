import { useAppStore } from '../stores/appStore.ts';
import type { AgentInfo } from '../types/index.ts';

interface AgentCardProps {
  agent: AgentInfo;
  onClick: (agentId: string) => void;
}

const EMPTY_OUTPUTS: string[] = [];

const ROLE_COLORS: Record<string, string> = {
  'team-lead': 'bg-purple-700',
  architect: 'bg-indigo-700',
  developer: 'bg-blue-700',
  reviewer: 'bg-yellow-700',
  tester: 'bg-green-700',
  debugger: 'bg-red-700',
  devops: 'bg-orange-700',
  docs: 'bg-teal-700',
};

export function AgentCard({ agent, onClick }: AgentCardProps) {
  const outputs = useAppStore((s) => s.agentOutputs[agent.agentId] ?? EMPTY_OUTPUTS);
  const lastLines = outputs.slice(-5).join('').split('\n').slice(-5).join('\n');
  const elapsed = Math.round((Date.now() - agent.startTime) / 1000);

  const roleColor = ROLE_COLORS[agent.role] ?? 'bg-gray-700';

  return (
    <div
      className="bg-gray-900 border border-gray-700 rounded-lg p-3 cursor-pointer hover:border-gray-500 transition-colors"
      onClick={() => onClick(agent.agentId)}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className={`${roleColor} text-white text-xs px-2 py-0.5 rounded-full font-medium`}>
          {agent.role}
        </span>
        <span className="text-gray-400 text-xs">{agent.modelId}</span>
        <span className="text-gray-500 text-xs ml-auto">{elapsed}s</span>
      </div>
      <div className="text-gray-500 text-xs mb-2">Task: {agent.taskId}</div>
      <pre className="text-xs text-gray-400 bg-gray-950 rounded p-2 h-16 overflow-hidden font-mono leading-relaxed">
        {lastLines || '(waiting...)'}
      </pre>
    </div>
  );
}
