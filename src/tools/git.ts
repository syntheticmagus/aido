import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Tool, ToolResult, AgentContext } from './types.js';

function runGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    proc.on('error', (err) => resolve({ stdout, stderr: err.message, code: -1 }));
  });
}

function workspaceGit(context: AgentContext): string {
  return path.join(context.workspaceRoot, context.projectName);
}

// ─── git_commit ───────────────────────────────────────────────────────────────

interface GitCommitParams {
  message: string;
  files?: string[];
}

export class GitCommitTool implements Tool {
  readonly name = 'git_commit';
  readonly description = 'Stage files and create a git commit in the project workspace.';
  readonly parameters = {
    type: 'object' as const,
    properties: {
      message: { type: 'string', description: 'Commit message' },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files to stage (omit to stage all changes with git add -A)',
      },
    },
    required: ['message'],
  };

  async execute(params: unknown, context: AgentContext): Promise<ToolResult> {
    const { message, files } = params as GitCommitParams;
    const cwd = workspaceGit(context);

    const stageArgs = files && files.length > 0 ? ['add', '--', ...files] : ['add', '-A'];
    const stageResult = await runGit(stageArgs, cwd);
    if (stageResult.code !== 0) {
      return { success: false, output: stageResult.stderr, error: 'git add failed' };
    }

    const commitResult = await runGit(['commit', '-m', message], cwd);
    if (commitResult.code !== 0) {
      return {
        success: false,
        output: commitResult.stdout + '\n' + commitResult.stderr,
        error: 'git commit failed',
      };
    }

    return { success: true, output: commitResult.stdout };
  }
}

// ─── git_diff ─────────────────────────────────────────────────────────────────

interface GitDiffParams {
  ref?: string;
  staged?: boolean;
}

export class GitDiffTool implements Tool {
  readonly name = 'git_diff';
  readonly description = 'Show git diff of current changes or between refs.';
  readonly parameters = {
    type: 'object' as const,
    properties: {
      ref: { type: 'string', description: 'Git ref to diff against (e.g. HEAD, main)' },
      staged: { type: 'boolean', description: 'Show staged changes only (default: false)' },
    },
    required: [],
  };

  async execute(params: unknown, context: AgentContext): Promise<ToolResult> {
    const { ref, staged = false } = params as GitDiffParams;
    const cwd = workspaceGit(context);

    const args = ['diff'];
    if (staged) args.push('--staged');
    if (ref) args.push(ref);

    const result = await runGit(args, cwd);
    return {
      success: result.code === 0,
      output: result.stdout || '(no changes)',
      error: result.code !== 0 ? result.stderr : undefined,
    };
  }
}

// ─── git_log ──────────────────────────────────────────────────────────────────

interface GitLogParams {
  maxCount?: number;
  oneline?: boolean;
}

export class GitLogTool implements Tool {
  readonly name = 'git_log';
  readonly description = 'View git commit history in the project workspace.';
  readonly parameters = {
    type: 'object' as const,
    properties: {
      maxCount: { type: 'number', description: 'Maximum number of commits to show (default: 20)' },
      oneline: { type: 'boolean', description: 'Show one line per commit (default: true)' },
    },
    required: [],
  };

  async execute(params: unknown, context: AgentContext): Promise<ToolResult> {
    const { maxCount = 20, oneline = true } = params as GitLogParams;
    const cwd = workspaceGit(context);

    const args = ['log', `--max-count=${maxCount}`];
    if (oneline) args.push('--oneline');

    const result = await runGit(args, cwd);
    return {
      success: result.code === 0,
      output: result.stdout || '(no commits yet)',
      error: result.code !== 0 ? result.stderr : undefined,
    };
  }
}

// ─── git_branch (Phase 5) ─────────────────────────────────────────────────────

interface GitBranchParams {
  action: 'create' | 'checkout' | 'merge' | 'delete';
  name: string;
}

export class GitBranchTool implements Tool {
  readonly name = 'git_branch';
  readonly description = 'Create, checkout, merge, or delete a git branch.';
  readonly parameters = {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'checkout', 'merge', 'delete'],
        description: 'Branch action',
      },
      name: { type: 'string', description: 'Branch name' },
    },
    required: ['action', 'name'],
  };

  async execute(params: unknown, context: AgentContext): Promise<ToolResult> {
    const { action, name } = params as GitBranchParams;
    const cwd = workspaceGit(context);

    let args: string[];
    switch (action) {
      case 'create':
        args = ['checkout', '-b', name];
        break;
      case 'checkout':
        args = ['checkout', name];
        break;
      case 'merge':
        args = ['merge', name, '--no-ff', '-m', `Merge branch '${name}'`];
        break;
      case 'delete':
        args = ['branch', '-d', name];
        break;
    }

    const result = await runGit(args, cwd);
    return {
      success: result.code === 0,
      output: result.stdout + result.stderr,
      error: result.code !== 0 ? result.stderr : undefined,
    };
  }
}
