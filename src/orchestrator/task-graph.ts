import fs from 'node:fs';
import path from 'node:path';
import { generateId, timestamp } from '../utils/id.js';
import type { Task, TaskStatus, TaskType } from '../config/schema.js';

export { Task };

export type TaskCreateInput = Omit<Task, 'id' | 'attempts' | 'status' | 'createdAt' | 'updatedAt'>;

export class TaskGraph {
  private tasks = new Map<string, Task>();
  private persistPath: string | null = null;

  /** Called whenever a task is created. Set by the orchestrator to forward events. */
  onTaskCreated?: (task: Task) => void;
  /** Called whenever a task is updated. Set by the orchestrator to forward events. */
  onTaskUpdated?: (task: Task) => void;

  static fromFile(filePath: string): TaskGraph {
    const graph = new TaskGraph();
    graph.persistPath = filePath;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { tasks: Task[] };
      for (const task of data.tasks) {
        graph.tasks.set(task.id, task);
      }
    } catch {
      // File doesn't exist yet — start fresh
    }
    return graph;
  }

  setPersistPath(filePath: string): void {
    this.persistPath = filePath;
  }

  createTask(input: TaskCreateInput): Task {
    const now = timestamp();
    const task: Task = {
      ...input,
      id: generateId('task'),
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    this.persist();
    this.onTaskCreated?.(task);
    return task;
  }

  updateTask(id: string, updates: Partial<Task>): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task ${id} not found`);
    Object.assign(task, updates, { updatedAt: timestamp() });
    this.persist();
    this.onTaskUpdated?.(task);
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): Task[] {
    return [...this.tasks.values()];
  }

  // Tasks that are pending and whose dependencies are all done.
  getReadyTasks(): Task[] {
    return [...this.tasks.values()].filter((task) => {
      if (task.status !== 'pending') return false;
      return task.dependencies.every((depId) => {
        const dep = this.tasks.get(depId);
        return dep?.status === 'done';
      });
    });
  }

  // Reset in-progress/assigned tasks to pending (used on restart).
  resetInterruptedTasks(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'in-progress' || task.status === 'assigned') {
        task.status = 'pending';
        task.assignedAgent = undefined;
        task.updatedAt = timestamp();
      }
    }
    this.persist();
  }

  hasCycle(): boolean {
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const dfs = (id: string): boolean => {
      if (inStack.has(id)) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      inStack.add(id);
      const task = this.tasks.get(id);
      if (task) {
        for (const dep of task.dependencies) {
          if (dfs(dep)) return true;
        }
      }
      inStack.delete(id);
      return false;
    };

    for (const id of this.tasks.keys()) {
      if (dfs(id)) return true;
    }
    return false;
  }

  toJSON(): { tasks: Task[] } {
    return { tasks: [...this.tasks.values()] };
  }

  persist(): void {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify(this.toJSON(), null, 2), 'utf-8');
    } catch {
      // Non-fatal — best effort persistence
    }
  }
}
