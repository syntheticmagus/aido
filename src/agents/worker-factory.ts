import { BaseAgent } from './base-agent.js';
import { ToolRegistry } from '../tools/registry.js';
import {
  FileReadTool,
  FileWriteTool,
  FilePatchTool,
  FileSearchTool,
  DirectoryListTool,
} from '../tools/filesystem.js';
import { ShellTool } from '../tools/shell.js';
import { GitCommitTool, GitDiffTool, GitLogTool } from '../tools/git.js';
import type { LLMProvider } from '../llm/types.js';
import type { ModelConfig, Task, TaskType } from '../config/schema.js';
import type { AgentContext, Tool, ToolResult } from '../tools/types.js';
import type { AgentResult } from './base-agent.js';

const SYSTEM_PROMPTS: Record<TaskType, string> = {
  architecture: `You are a software architect agent. Your job is to design the system architecture for the assigned task.
Produce clear, concrete architectural decisions: file structure, module boundaries, data models, API contracts.
Write your design to files in the workspace. Use report_result when done.`,

  implement: `You are a software developer agent. Implement the code described in your task.
Write clean, correct, well-structured code. Follow existing patterns in the codebase.
Before running build or test commands, install dependencies first (e.g. \`npm install\`, \`pip install -r requirements.txt\`).
Run the code if possible to verify it works. Use report_result when done.`,

  test: `You are a software testing agent. Write comprehensive tests for the assigned code.
Cover happy paths, edge cases, and error scenarios.
Before running tests, install dependencies if node_modules / virtualenv / etc. is missing (e.g. \`npm install\`).
Run the tests and ensure they pass. Use report_result when done, reporting which tests pass and which fail.`,

  review: `You are a code reviewer agent. Review the assigned code for:
- Correctness and bugs
- Code quality and readability
- Security issues
- Missing error handling
- Performance concerns
Provide specific, actionable feedback. Use report_result with success=true if code is acceptable, success=false if rework is needed.`,

  debug: `You are a debugging agent. Diagnose and fix the reported failure.
Read error messages carefully, trace through the code, and identify the root cause.
Make targeted fixes. Verify the fix works. Use report_result when done.`,

  devops: `You are a DevOps agent. Set up build tooling, Docker configs, or CI/CD as described.
Write working configuration files. Test that they work. Use report_result when done.`,

  docs: `You are a documentation agent. Write clear, accurate documentation for the assigned code.
Include usage examples, API descriptions, and important caveats. Use report_result when done.`,

  integrate: `You are an integration agent. Connect the described components and ensure they work together.
Test the integration thoroughly. Use report_result when done.`,

  validate: `You are a validation agent. Perform end-to-end validation of the described functionality.
Test the full user flow. Report what works and what doesn't. Use report_result when done.`,
};

const TOOL_SUBSETS: Record<TaskType, string[]> = {
  architecture: ['file_read', 'file_write', 'file_patch', 'file_search', 'directory_list', 'report_result'],
  implement: ['file_read', 'file_write', 'file_patch', 'file_search', 'directory_list', 'shell_exec', 'git_commit', 'git_diff', 'report_result'],
  test: ['file_read', 'file_write', 'file_patch', 'file_search', 'directory_list', 'shell_exec', 'git_commit', 'report_result'],
  review: ['file_read', 'file_search', 'directory_list', 'git_diff', 'git_log', 'report_result'],
  debug: ['file_read', 'file_write', 'file_patch', 'file_search', 'directory_list', 'shell_exec', 'git_diff', 'git_log', 'report_result'],
  devops: ['file_read', 'file_write', 'file_patch', 'file_search', 'directory_list', 'shell_exec', 'git_commit', 'report_result'],
  docs: ['file_read', 'file_write', 'file_patch', 'file_search', 'directory_list', 'report_result'],
  integrate: ['file_read', 'file_write', 'file_patch', 'file_search', 'directory_list', 'shell_exec', 'git_commit', 'git_diff', 'report_result'],
  validate: ['file_read', 'file_search', 'directory_list', 'shell_exec', 'git_log', 'report_result'],
};

function buildCoreRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new FileReadTool());
  registry.register(new FileWriteTool());
  registry.register(new FilePatchTool());
  registry.register(new FileSearchTool());
  registry.register(new DirectoryListTool());
  registry.register(new ShellTool());
  registry.register(new GitCommitTool());
  registry.register(new GitDiffTool());
  registry.register(new GitLogTool());
  registry.register(makeReportResultTool());
  return registry;
}

function makeReportResultTool(): Tool {
  return {
    name: 'report_result',
    description: 'Signal task completion. Call this when your work is done.',
    parameters: {
      type: 'object',
      properties: {
        success: { type: 'boolean', description: 'Whether the task succeeded' },
        summary: { type: 'string', description: 'Summary of what was done' },
        artifacts: { type: 'array', items: { type: 'string' }, description: 'File paths produced' },
        notes: { type: 'string', description: 'Any notes for the Team Lead' },
      },
      required: ['success', 'summary'],
    },
    async execute(): Promise<ToolResult> {
      return { success: true, output: 'Result reported.' };
    },
  };
}

class WorkerAgent extends BaseAgent {
  private _systemPrompt: string;
  private _tools: ToolRegistry;

  constructor(
    model: ModelConfig,
    provider: LLMProvider,
    context: AgentContext,
    taskType: TaskType,
    maxToolCalls: number,
  ) {
    super(model, provider, context, maxToolCalls);
    this._systemPrompt = SYSTEM_PROMPTS[taskType];
    const allTools = buildCoreRegistry();
    this._tools = allTools.subset(TOOL_SUBSETS[taskType]);
  }

  protected get systemPrompt(): string {
    return this._systemPrompt;
  }

  protected get tools(): ToolRegistry {
    return this._tools;
  }

  protected parseResult(lastTextBlock: string): AgentResult {
    return {
      success: true,
      summary: lastTextBlock.slice(0, 500),
      artifacts: [],
      tokensUsed: { input: 0, output: 0 },
    };
  }
}

export function createWorkerAgent(
  task: Task,
  context: AgentContext,
  model: ModelConfig,
  provider: LLMProvider,
  maxToolCalls: number,
): WorkerAgent {
  return new WorkerAgent(model, provider, context, task.type, maxToolCalls);
}
