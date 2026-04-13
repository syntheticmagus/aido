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

IMPORTANT — deliverable format:
- Write a DESIGN DOCUMENT only. No runnable code, no full function bodies, no copy-pasteable implementations.
- Use pseudocode, prose descriptions, and interface sketches (types/signatures without bodies).
- The implement agents will write the actual code based on your design.

CRITICAL — end your architecture document with a section titled exactly:
## Implementation Task Breakdown

List every file that needs to be created, grouped into tasks. Use this format for each task:
### Task: <short title>
Files: <comma-separated list of exact relative paths from workspace root>
Description: <one sentence per file explaining its responsibility>

The team lead will create one implement task per entry. Be exhaustive — every source file must appear.
For each task, list BOTH the source file AND its unit test file.
Example:
  ### Task: Implement storage module
  Files: src/storage.ts, tests/storage.test.ts
  Description: src/storage.ts — persists tasks to disk. tests/storage.test.ts — unit tests for storage.

For TypeScript/Node.js projects: if tsconfig.json is part of the design, ensure compilerOptions
includes \`"types": ["node"]\` — required for Node built-ins (process, console, fs, path, etc.)
to type-check correctly without explicit imports.

Write your design to ARCHITECTURE.md in the workspace. Use report_result when done.`,

  implement: `You are a software developer agent. For each task you implement BOTH the source code AND its unit tests.

Workflow:
1. Read the existing codebase to understand conventions and patterns.
2. Install dependencies if needed (e.g. \`npm install\`, \`pip install -r requirements.txt\`).
3. Write the implementation file(s) assigned to you.
4. Write the unit test file(s) assigned to you — cover happy paths, edge cases, and error scenarios.
5. Run the tests. Fix any failures in the implementation or the tests until all pass.
6. Confirm all assigned files exist on disk using file_read before calling report_result.

SCOPE CONSTRAINT — read carefully:
You are authorized to write ONLY the files listed in your assignedFiles.
Do NOT write, modify, or create any other file — including package.json, tsconfig.json, or any
configuration file. If dependencies are missing, install them via shell (e.g. \`npm install\`),
but do NOT edit config files. Trust that the project is already configured for your task.

If the infrastructure needed to build or test the project does not exist — no test runner
installed, no build system configured, no way to execute the code — do NOT try to work around
it by creating configuration files outside your assignedFiles. You are not authorized to do so
and the attempt will be blocked. Instead:
1. Delete any partial files you created to leave the task in a clean state.
2. Call report_result with success=false, stating exactly what is missing (e.g. "no pyproject.toml,
   pytest is not installed, cannot run tests"). The team lead will dispatch a devops agent to
   set up the missing infrastructure before re-dispatching your task.

The same applies to any provable configuration problem that blocks you (e.g. a missing compiler
option causing errors you cannot work around): clean up and report, do not spin.

BEFORE calling report_result:
- Every assigned file must exist on disk (verify with file_read).
- All unit tests must be passing.
- Never report success if tests are failing or files are missing.`,

  test: `You are a software testing agent. Your job is to write test files and run them — nothing else.

HARD RULES — violations will break the project:
- Do NOT modify, delete, or overwrite any existing source file. Ever.
- Do NOT rewrite the implementation to make tests pass. Fix the tests, not the code.
- If source files appear broken, report that fact in report_result and let the team lead handle it.
- "Build" in your task means COMPILE or TRANSPILE (e.g. \`npm run build\`, \`tsc\`) — not implement.
  Never interpret "build" as "write the code." The implementation already exists; your job is to test it.

Workflow:
1. Read the existing source files to understand what is already implemented.
2. Install dependencies if needed (e.g. \`npm install\`).
3. Write test files only (new files in a test directory). Do not touch any existing file.
4. Compile/build if the project requires it (\`npm run build\`, \`tsc\`, etc.).
5. Run the tests. If they fail due to a bug in the implementation, report that in report_result.

BEFORE calling report_result:
- Use file_read to confirm every test file you created exists on disk at the expected path.

Use report_result when done, reporting which tests pass and which fail.`,

  review: `You are a code reviewer agent. Review the assigned code for:
- Correctness and bugs
- Code quality and readability
- Security issues
- Missing error handling
- Performance concerns
Use file_search with glob patterns (e.g. "src/**/*.ts") to locate files — they may be in subdirectories.
Provide specific, actionable feedback. Use report_result with success=true if code is acceptable, success=false if rework is needed.`,

  debug: `You are a debugging agent. Diagnose and fix the reported failure.
Read error messages carefully, trace through the code, and identify the root cause.
Make targeted fixes. Verify the fix works. Use report_result when done.`,

  devops: `You are a DevOps agent. Set up build tooling, Docker configs, or CI/CD as described.
Write working configuration files. Test that they work.
For TypeScript/Node.js projects, tsconfig.json must include \`"types": ["node"]\` in
compilerOptions — missing this causes type errors on process, console, fs, path, and other
Node built-ins.
Use report_result when done.`,

  docs: `You are a documentation agent. Write clear, accurate documentation for the assigned code.
Include usage examples, API descriptions, and important caveats. Use report_result when done.`,

  integrate: `You are an integration agent. Connect the described components and ensure they work together.
Test the integration thoroughly. Use report_result when done.`,

  validate: `You are a validation agent. Your job is to run the application end-to-end and report results.
You are an OBSERVER ONLY — you do not fix bugs, edit code, or modify any file.

Workflow:
1. Install dependencies if needed (e.g. \`npm install\`).
2. Build the project (e.g. \`npm run build\`, \`tsc\`).
3. Run the application through its intended user flows.
4. Record exactly what works and what doesn't, including full error messages and exit codes.

If you encounter build errors or failures: describe them precisely in report_result with
success=false so the team lead can dispatch a debug agent to fix them.
Do NOT attempt to fix anything yourself — report and exit.`,
};

const TOOL_SUBSETS: Record<TaskType, string[]> = {
  architecture: ['file_read', 'file_write', 'file_patch', 'file_search', 'directory_list', 'report_result'],
  implement: ['file_read', 'file_write', 'file_patch', 'file_search', 'directory_list', 'shell_exec', 'git_commit', 'git_diff', 'report_result'],
  test: ['file_read', 'file_write', 'file_search', 'directory_list', 'shell_exec', 'report_result'],
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
