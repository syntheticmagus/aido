import { useMemo, useCallback } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeTypes,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import type { Task, TaskStatus } from '../types/index.ts';

const STATUS_COLORS: Record<TaskStatus, string> = {
  pending: 'bg-gray-600 border-gray-500',
  blocked: 'bg-orange-800 border-orange-600',
  assigned: 'bg-blue-800 border-blue-600 animate-pulse',
  'in-progress': 'bg-blue-700 border-blue-500 animate-pulse',
  review: 'bg-yellow-700 border-yellow-500',
  done: 'bg-green-800 border-green-600',
  failed: 'bg-red-800 border-red-600',
};

interface TaskNodeData {
  task: Task;
  onSelect: (id: string) => void;
  [key: string]: unknown;
}

function TaskNode({ data }: { data: TaskNodeData }) {
  const { task, onSelect } = data;
  const colorClass = STATUS_COLORS[task.status];
  return (
    <div
      className={`${colorClass} border-2 rounded-lg px-3 py-2 min-w-32 cursor-pointer text-white`}
      onClick={() => onSelect(task.id)}
    >
      <Handle type="target" position={Position.Left} className="!bg-gray-400" />
      <div className="text-xs font-medium truncate max-w-36">{task.title}</div>
      <div className="text-xs text-gray-300 mt-0.5">{task.status}</div>
      <Handle type="source" position={Position.Right} className="!bg-gray-400" />
    </div>
  );
}

const nodeTypes: NodeTypes = { task: TaskNode };

const NODE_W = 180;
const NODE_H = 60;

function layoutGraph(tasks: Task[]): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', ranksep: 80, nodesep: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const task of tasks) {
    g.setNode(task.id, { width: NODE_W, height: NODE_H });
  }
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (g.hasNode(dep)) {
        g.setEdge(dep, task.id);
      }
    }
  }

  dagre.layout(g);

  const nodes: Node[] = tasks.map((task) => {
    const pos = g.node(task.id);
    return {
      id: task.id,
      type: 'task',
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      data: { task } as unknown as TaskNodeData,
    };
  });

  const edges: Edge[] = tasks.flatMap((task) =>
    task.dependencies
      .filter((dep) => g.hasNode(dep))
      .map((dep) => ({
        id: `${dep}->${task.id}`,
        source: dep,
        target: task.id,
        style: { stroke: '#6b7280' },
      })),
  );

  return { nodes, edges };
}

interface TaskGraphProps {
  tasks: Task[];
  onTaskSelect: (id: string) => void;
}

export function TaskGraph({ tasks, onTaskSelect }: TaskGraphProps) {
  const { nodes: rawNodes, edges } = useMemo(
    () => layoutGraph(tasks),
    [tasks],
  );

  // Inject onSelect callback into each node's data
  const nodes = useMemo(
    () =>
      rawNodes.map((n) => ({
        ...n,
        data: { ...(n.data as object), onSelect: onTaskSelect },
      })),
    [rawNodes, onTaskSelect],
  );

  if (tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        No tasks yet. Team Lead will create tasks after you start the project.
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      attributionPosition="bottom-left"
      className="bg-gray-950"
    >
      <Background color="#374151" />
      <Controls className="[&>button]:bg-gray-800 [&>button]:border-gray-600 [&>button]:text-gray-300" />
    </ReactFlow>
  );
}
