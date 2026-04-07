# AIDO — Autonomous AI Development Orchestrator

## Implementation Plan

---

## 1. Concept Summary

AIDO is a Node.js/TypeScript tool that turns a disposable VM into an autonomous software development environment. A user provides a project specification and a models configuration, then AIDO spawns a coordinated team of AI agents — led by a persistent "Team Lead" agent — that architect, implement, test, debug, and deliver a complete software product with no human intervention beyond the initial inputs.

The tool is designed for **rapid setup and teardown**: clone the repo, `npm install`, `npm start`, point a browser at the Web UI, upload your spec, and walk away. When the project is done (or the budget is exhausted), tear down the VM.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Browser (Web UI)                                       │
│  - Upload spec & models config                          │
│  - Live dashboard: task graph, agent status, logs        │
│  - Terminal views into agent sessions                    │
│  - Manual intervention / override controls               │
└────────────────┬────────────────────────────────────────┘
                 │ WebSocket + REST
┌────────────────▼────────────────────────────────────────┐
│  AIDO Server (Node.js / TypeScript)                     │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │  Web Server  │  │  Orchestrator │  │  Model Router  │ │
│  │  (Express +  │  │  (Event Loop) │  │  (Multi-LLM)   │ │
│  │   Socket.IO) │  │              │  │                │ │
│  └─────────────┘  └──────┬───────┘  └───────┬────────┘ │
│                          │                   │          │
│  ┌───────────────────────▼───────────────────▼────────┐ │
│  │                   Agent Pool                        │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐           │ │
│  │  │Team Lead │ │ Worker 1 │ │ Worker N │  ...       │ │
│  │  │(persistent│ │(ephemeral│ │(ephemeral│           │ │
│  │  │ agent)   │ │ agent)   │ │ agent)   │           │ │
│  │  └──────────┘ └──────────┘ └──────────┘           │ │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Sandbox Exec │  │ Claude Code  │  │  Artifact    │  │
│  │ (shell, fs)  │  │  Bridge      │  │  Store       │  │
│  │              │  │  (file I/O + │  │  (workspace) │  │
│  │              │  │   tmux/pty)  │  │              │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
                         │
                   VM filesystem
              (the project workspace)
```

---

## 3. Project Structure

```
aido/
├── package.json
├── tsconfig.json
├── README.md
├── scripts/
│   └── setup.sh                  # Optional: installs tmux, build-essential, etc.
├── src/
│   ├── index.ts                  # Entry point — starts server + orchestrator
│   ├── config/
│   │   ├── schema.ts             # Zod schemas for models.yaml, spec, etc.
│   │   └── loader.ts             # Loads and validates user-supplied configs
│   ├── server/
│   │   ├── app.ts                # Express app setup
│   │   ├── routes/
│   │   │   ├── api.ts            # REST endpoints (upload spec, query status)
│   │   │   └── artifacts.ts      # Serve workspace files
│   │   ├── ws.ts                 # Socket.IO event handlers
│   │   └── public/               # Static frontend assets (built separately)
│   ├── orchestrator/
│   │   ├── orchestrator.ts       # Main event loop
│   │   ├── task-graph.ts         # DAG of tasks with dependencies + statuses
│   │   ├── agent-pool.ts         # Lifecycle management for agents
│   │   └── budget-tracker.ts     # Token/cost/time accounting
│   ├── agents/
│   │   ├── base-agent.ts         # Abstract agent with tool-use loop
│   │   ├── team-lead.ts          # Persistent planning/review agent
│   │   ├── architect.ts          # System design, tech stack decisions
│   │   ├── developer.ts          # Code generation agent
│   │   ├── reviewer.ts           # Code review agent
│   │   ├── tester.ts             # Test writing + execution agent
│   │   ├── debugger.ts           # Failure analysis + fix agent
│   │   ├── devops.ts             # Build config, Docker, CI/CD agent
│   │   └── docs.ts               # Documentation agent
│   ├── llm/
│   │   ├── router.ts             # Dispatches to the right provider
│   │   ├── providers/
│   │   │   ├── anthropic.ts      # Claude API (Messages API)
│   │   │   ├── openai.ts         # OpenAI / compatible APIs
│   │   │   ├── google.ts         # Gemini API
│   │   │   └── local.ts          # Ollama / vLLM / LM Studio
│   │   ├── context-manager.ts    # Conversation history, summarization
│   │   └── cost-estimator.ts     # Token counting + cost estimation
│   ├── tools/
│   │   ├── registry.ts           # Central tool registry
│   │   ├── shell.ts              # Execute shell commands
│   │   ├── filesystem.ts         # Read/write/search files
│   │   ├── browser.ts            # Puppeteer for testing web UIs
│   │   ├── git.ts                # Git operations
│   │   └── claude-code.ts        # Claude Code bridge (see §7)
│   ├── workspace/
│   │   ├── manager.ts            # Workspace init, layout, cleanup
│   │   └── watcher.ts            # File change events → UI
│   └── utils/
│       ├── logger.ts             # Structured logging (pino)
│       ├── retry.ts              # Exponential backoff + rate limit handling
│       └── id.ts                 # ULID/nanoid generation
├── frontend/                     # Separate Vite + React app
│   ├── package.json
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── Dashboard.tsx     # Main view: task graph + agent cards
│   │   │   ├── TaskGraph.tsx     # Visual DAG with live status
│   │   │   ├── AgentCard.tsx     # Per-agent: model, status, log tail
│   │   │   ├── TerminalView.tsx  # Embedded xterm.js for agent sessions
│   │   │   ├── FileExplorer.tsx  # Browse workspace
│   │   │   ├── LogStream.tsx     # Filterable log viewer
│   │   │   └── ConfigUpload.tsx  # Initial setup wizard
│   │   ├── hooks/
│   │   │   └── useSocket.ts      # Socket.IO React hook
│   │   └── stores/
│   │       └── appStore.ts       # Zustand state management
│   └── vite.config.ts
└── examples/
    ├── models.example.yaml
    └── spec.example.md
```

---

## 4. Configuration Files

### 4.1 Models Configuration (`models.yaml`)

```yaml
models:
  - id: claude-sonnet
    provider: anthropic
    model: claude-sonnet-4-20250514
    apiKey: ${ANTHROPIC_API_KEY}     # Env var interpolation supported
    baseUrl: https://api.anthropic.com
    maxTokens: 8192
    rateLimit:
      requestsPerMinute: 50
      tokensPerMinute: 400000
    roles: [developer, reviewer, tester, debugger, docs]
    costPer1kInput: 0.003
    costPer1kOutput: 0.015

  - id: claude-opus
    provider: anthropic
    model: claude-opus-4-20250514
    apiKey: ${ANTHROPIC_API_KEY}
    maxTokens: 4096
    rateLimit:
      requestsPerMinute: 20
      tokensPerMinute: 100000
    roles: [team-lead, architect]
    costPer1kInput: 0.015
    costPer1kOutput: 0.075

  - id: gpt4o
    provider: openai
    model: gpt-4o
    apiKey: ${OPENAI_API_KEY}
    roles: [developer, tester]
    costPer1kInput: 0.005
    costPer1kOutput: 0.015

  - id: gemini-flash
    provider: google
    model: gemini-2.0-flash
    apiKey: ${GOOGLE_API_KEY}
    roles: [developer, docs]
    costPer1kInput: 0.0001
    costPer1kOutput: 0.0004

  - id: local-qwen
    provider: local
    baseUrl: http://localhost:11434
    model: qwen2.5-coder:32b
    roles: [developer]
    costPer1kInput: 0        # Free local inference

claudeCode:
  enabled: true
  binaryPath: claude           # Or absolute path
  maxConcurrentSessions: 1
  usageLimitCooldownMinutes: 60
  reserveForRoles: [debugger, architect]   # Only use for hard problems

defaults:
  temperature: 0.2
  retryAttempts: 3
  retryBackoffMs: 1000

budget:
  maxTotalCost: 50.00         # USD — hard stop
  warnAtCost: 40.00
  maxWallClockHours: 8
```

### 4.2 Project Specification (`spec.md`)

A Markdown document authored by the user. No rigid schema — the Team Lead agent parses and interprets it. Recommended structure:

```markdown
# Project: [Name]

## Overview
What this software does, who it's for, core value proposition.

## Technical Requirements
- Language / runtime (e.g., "Node.js 20 + TypeScript")
- Framework preferences (e.g., "Use Next.js App Router")
- Database (e.g., "PostgreSQL via Prisma ORM")
- External APIs / integrations

## Features
### Feature 1: [Name]
Detailed description, acceptance criteria, edge cases.

### Feature 2: [Name]
...

## Non-Functional Requirements
- Performance targets
- Security considerations
- Accessibility standards

## Deliverables
- What the final output should look like
- How it should be runnable (e.g., "docker compose up")

## Constraints
- Things NOT to do
- Libraries to avoid
- Architectural boundaries
```

---

## 5. Orchestration Model

### 5.1 The Team Lead Agent

The Team Lead is the only **persistent, long-running** agent. It operates in a loop:

```
WHILE project not complete AND budget remaining:
  1. Assess current state (read task graph, recent agent outputs, test results)
  2. Decide next actions (plan new tasks, reassign failed tasks, approve PRs)
  3. Dispatch work to worker agents
  4. Wait for events (agent completion, failure, new information)
  5. Review results (accept, reject with feedback, or escalate)
```

The Team Lead's system prompt includes the full project spec, the current task graph state, and a structured tool set for managing agents and tasks.

**Context management:** The Team Lead's conversation grows indefinitely. To handle this:
- Every N turns (configurable, e.g., 20), generate a "state summary" using the same or a cheaper model.
- Replace the conversation history with: system prompt + state summary + last 5 turns.
- Persist full history to disk for debugging/audit.

### 5.2 Task Graph

Tasks are nodes in a directed acyclic graph (DAG):

```typescript
interface Task {
  id: string;
  title: string;
  description: string;
  type: 'architecture' | 'implement' | 'test' | 'review' | 'debug' |
        'devops' | 'docs' | 'integrate' | 'validate';
  status: 'pending' | 'blocked' | 'assigned' | 'in-progress' |
          'review' | 'done' | 'failed';
  dependencies: string[];          // Task IDs that must complete first
  assignedAgent?: string;
  assignedModel?: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  artifacts: string[];             // File paths produced
  result?: TaskResult;
  createdBy: string;               // Usually 'team-lead'
  estimatedTokens?: number;
}
```

The Team Lead creates the initial task graph from the spec, then mutates it as work progresses. Workers cannot modify the graph directly — they report results, and the Team Lead decides what happens next.

### 5.3 Worker Agent Lifecycle

```
1. Team Lead creates a task and requests a worker
2. Orchestrator selects a model (based on task type + model roles + availability)
3. Agent is instantiated with:
   - Role-specific system prompt
   - Task description + relevant context (file contents, prior outputs)
   - Tool set appropriate to the role
4. Agent runs its tool-use loop until it:
   - Declares completion (produces artifacts)
   - Fails (error, gives up)
   - Is terminated (by Team Lead or budget limit)
5. Results are reported to Team Lead
6. Agent is destroyed (conversation state archived to disk)
```

### 5.4 Agent Concurrency

Multiple worker agents can run concurrently on independent tasks. The orchestrator manages:

- **Rate limiting:** Per-model token bucket. If model X is at capacity, queue the request or use an alternative model.
- **Parallelism cap:** Configurable max concurrent agents (default: 5). Prevents runaway costs.
- **Priority scheduling:** Higher-priority tasks (e.g., blocking many downstream tasks) get assigned first.

---

## 6. Agent Tool System

Each agent gets a subset of tools based on its role. Tools follow a standardized interface:

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute(params: unknown, context: AgentContext): Promise<ToolResult>;
}
```

### 6.1 Core Tools (Available to Most Agents)

| Tool | Description |
|------|-------------|
| `shell_exec` | Run a shell command, return stdout/stderr/exit code. Timeout configurable. |
| `file_read` | Read a file (with optional line range). |
| `file_write` | Write/overwrite a file. |
| `file_patch` | Apply a targeted edit (search/replace within a file). |
| `file_search` | Grep/ripgrep across the workspace. |
| `directory_list` | List directory contents. |
| `git_commit` | Stage and commit changes with a message. |
| `git_diff` | Show diff of current changes or between refs. |
| `git_log` | View commit history. |
| `report_result` | Declare task outcome (success/failure) with summary. |

### 6.2 Role-Specific Tools

| Role | Additional Tools |
|------|-----------------|
| Team Lead | `create_task`, `assign_task`, `cancel_task`, `update_task`, `approve_result`, `reject_result`, `spawn_agent`, `query_budget`, `escalate_to_claude_code` |
| Architect | `create_task` (can propose sub-tasks for Team Lead approval) |
| Tester | `run_tests` (wraps test runner with structured output parsing) |
| Debugger | `read_logs`, `attach_debugger` (launch node --inspect, etc.) |
| DevOps | `docker_build`, `docker_run`, `install_package` |

### 6.3 Tool Execution Safety

Even though the VM is disposable, we still want some guardrails:

- **Command timeout:** Default 120s, configurable per-tool. Prevents infinite loops.
- **Working directory:** All agents operate within `/workspace/[project-name]/`. No access to AIDO's own source.
- **Audit log:** Every tool call is logged with full input/output for post-mortem analysis.
- **Kill switch:** The Team Lead (or user via UI) can terminate any agent immediately.

---

## 7. Claude Code Integration

Claude Code is treated as a **specialist oracle** — used sparingly for tasks that benefit from its deep codebase understanding, multi-file reasoning, and interactive debugging.

### 7.1 Bridge Architecture — File-Based Protocol

Instead of parsing terminal output (which is fragile and error-prone), AIDO uses a **file-based communication protocol**. The terminal is treated as a **write-only pipe** — the orchestrator sends commands into it but never reads from it. All responses come back via the filesystem.

```
┌─────────────────────────────────────────────────────────┐
│  claude-code.ts (Bridge)                                │
│                                                         │
│  ┌─────────┐     ┌───────────────────┐                  │
│  │  Queue   │────▶│  Session Manager  │                  │
│  │          │     │  (tmux + node-pty)│                  │
│  └─────────┘     └────────┬──────────┘                  │
│                           │ write-only                   │
│              ┌────────────▼───────────┐                  │
│              │  tmux session          │                  │
│              │  ┌──────────────────┐  │                  │
│              │  │  claude-code CLI │  │                  │
│              │  └────────┬─────────┘  │                  │
│              └───────────│────────────┘                  │
│                          │ writes files                  │
│  ┌───────────────────────▼──────────────────────────┐   │
│  │  /workspace/.aido/claude-code/                    │   │
│  │  ├── inbox/                                       │   │
│  │  │   └── task-{id}.md      ← orchestrator writes  │   │
│  │  ├── outbox/                                      │   │
│  │  │   └── task-{id}.md      ← Claude Code writes   │   │
│  │  └── signals/                                     │   │
│  │      └── task-{id}.done    ← Claude Code writes   │   │
│  └──────────────────────────────────────────────────┘   │
│                          ▲                               │
│              chokidar watches signals/                    │
│              then reads outbox/                           │
└─────────────────────────────────────────────────────────┘
```

**Why this works:** Claude Code is an AI agent that can read and write files natively. Asking it to write its response to a file costs a negligible handful of extra tokens per invocation, but completely eliminates the class of bugs around terminal output parsing — partial reads, ANSI escape codes, prompt detection heuristics, encoding issues, and ambiguous completion states all disappear.

### 7.2 Communication Protocol

The orchestrator and Claude Code communicate through three directories:

| Directory | Writer | Reader | Purpose |
|-----------|--------|--------|---------|
| `inbox/` | Orchestrator | Claude Code | Task descriptions with full context |
| `outbox/` | Claude Code | Orchestrator | Structured response files |
| `signals/` | Claude Code | Orchestrator | Completion/error sentinel files |

**Inbox format** (`inbox/task-{id}.md`):

```markdown
# Task: {id}

## Objective
{description of what needs to be done}

## Context
{relevant code snippets, error logs, prior attempts, etc.}

## Constraints
- Working directory: /workspace/{project}/
- Write your full response to: /workspace/.aido/claude-code/outbox/task-{id}.md
- When completely finished, create the signal file: /workspace/.aido/claude-code/signals/task-{id}.done
- Use the response format specified below.

## Response Format
Write your outbox file with this structure:

### Status
SUCCESS | PARTIAL | FAILED | RATE_LIMITED

### Summary
One-paragraph description of what you did.

### Files Changed
- path/to/file1.ts — description of change
- path/to/file2.ts — description of change

### Issues
Any problems encountered, unresolved questions, or suggestions.

### Details
Full explanation of your approach, decisions made, and anything
the team lead should know.
```

**Signal file** (`signals/task-{id}.done`):

A minimal file whose mere existence indicates completion. Contents are a single keyword for quick status detection without parsing the full outbox file:

```
SUCCESS
```

(or `FAILED`, `PARTIAL`, `RATE_LIMITED`)

### 7.3 Interaction Model

```typescript
class ClaudeCodeBridge {
  private session: TerminalSession;      // tmux (Linux) or node-pty (Windows)
  private watcher: FSWatcher;            // chokidar on signals/
  private state: 'idle' | 'busy' | 'rate-limited' | 'unavailable';
  private cooldownUntil?: Date;
  private pendingTasks: Map<string, {
    resolve: (result: ClaudeCodeResult) => void;
    reject: (err: Error) => void;
    timeout: NodeJS.Timeout;
  }>;

  constructor(private config: ClaudeCodeConfig) {
    // Watch signals directory — this is the ONLY way we detect completion
    this.watcher = chokidar.watch(SIGNALS_DIR, { ignoreInitial: true });
    this.watcher.on('add', (filepath) => this.onSignalFile(filepath));
  }

  async sendTask(taskId: string, prompt: string): Promise<ClaudeCodeResult> {
    // 1. Handle rate limiting
    if (this.state === 'rate-limited') {
      const waitMs = this.cooldownUntil!.getTime() - Date.now();
      if (waitMs > 0) {
        await this.notifyTeamLead('rate-limited', waitMs);
        await sleep(waitMs);
      }
    }

    // 2. Write task file to inbox
    const inboxPath = path.join(INBOX_DIR, `task-${taskId}.md`);
    await fs.writeFile(inboxPath, prompt, 'utf-8');

    // 3. Send command to Claude Code via terminal (write-only — we never read back)
    const command = [
      `claude "Read the task at ${inboxPath}.`,
      `Do the work described. When done, write your response to`,
      `${OUTBOX_DIR}/task-${taskId}.md using the format specified in the task.`,
      `Then create the signal file ${SIGNALS_DIR}/task-${taskId}.done`,
      `containing just the status word (SUCCESS/FAILED/PARTIAL/RATE_LIMITED).`,
      `Work in /workspace/${this.projectName}/."`,
    ].join(' ');

    await this.session.sendKeys(command);

    // 4. Return a promise that resolves when the signal file appears
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingTasks.delete(taskId);
        reject(new Error(`Claude Code task ${taskId} timed out after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);

      this.pendingTasks.set(taskId, { resolve, reject, timeout });
    });
  }

  private async onSignalFile(filepath: string): Promise<void> {
    // Extract task ID from filename: "task-{id}.done"
    const match = path.basename(filepath).match(/^task-(.+)\.done$/);
    if (!match) return;
    const taskId = match[1];

    const pending = this.pendingTasks.get(taskId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingTasks.delete(taskId);

    try {
      // Read the signal for quick status
      const signal = (await fs.readFile(filepath, 'utf-8')).trim();

      if (signal === 'RATE_LIMITED') {
        this.handleRateLimit();
        pending.reject(new Error('Claude Code rate limited'));
        return;
      }

      // Read the full response from outbox
      const outboxPath = path.join(OUTBOX_DIR, `task-${taskId}.md`);
      const response = await fs.readFile(outboxPath, 'utf-8');
      const result = this.parseResponse(taskId, signal, response);

      pending.resolve(result);
    } catch (err) {
      pending.reject(err as Error);
    }
  }

  private parseResponse(
    taskId: string, signal: string, raw: string
  ): ClaudeCodeResult {
    // Parse the structured markdown response into a typed object.
    // Because we control the format, this is straightforward string
    // splitting on known headers — no fragile terminal heuristics.
    return {
      taskId,
      status: signal as ClaudeCodeStatus,
      summary: extractSection(raw, 'Summary'),
      filesChanged: extractSection(raw, 'Files Changed'),
      issues: extractSection(raw, 'Issues'),
      details: extractSection(raw, 'Details'),
      rawResponse: raw,
    };
  }

  private handleRateLimit(): void {
    this.state = 'rate-limited';
    this.cooldownUntil = new Date(
      Date.now() + this.config.usageLimitCooldownMs
    );
    this.notifyTeamLead('rate-limited', this.config.usageLimitCooldownMs);
  }
}
```

### 7.4 Why File-Based Over Terminal Parsing

| Concern | Terminal parsing approach | File-based protocol |
|---------|--------------------------|---------------------|
| **Completion detection** | Heuristic: watch for shell prompt characters (`$`, `❯`). Brittle — prompts vary, Claude Code may print `$` in output. | Deterministic: signal file exists or it doesn't. |
| **Output capture** | Scrape tmux pane buffer. ANSI escape codes, line wrapping, and buffer overflow all corrupt data. | Clean UTF-8 file read. No escape codes, no buffer limits. |
| **Partial reads** | Risk reading mid-output if polling frequency is wrong. | Two-phase write: response file first, then sentinel. Orchestrator only reads after sentinel appears. |
| **Structured data** | Must regex-parse free-form terminal text. | Claude Code writes a known markdown format. Parsing is trivial string splitting on headers. |
| **Rate limit detection** | Scan terminal output for "rate limit" strings — fragile if wording changes. | Signal file contains explicit `RATE_LIMITED` status keyword. |
| **Debugging** | Attach to tmux session, scroll through mixed output. | Read inbox/outbox files directly — complete, clean, timestamped audit trail. |
| **Token overhead** | None. | ~30 extra tokens per prompt for file I/O instructions. Negligible vs. thousands of tokens per task. |

The terminal is reduced to a **write-only command pipe**. We send exactly one command string per task and then ignore the terminal entirely. All intelligence about completion, status, and response content flows through the filesystem.

### 7.5 When to Use Claude Code

The Team Lead decides when to escalate to Claude Code based on rules in its system prompt:

1. **A worker agent has failed the same task 2+ times** with different approaches.
2. **Complex refactoring** that touches many files and needs holistic understanding.
3. **Debugging a subtle issue** where the worker's fix attempts aren't converging.
4. **Architecture validation** — ask Claude Code to review the overall structure.

The Team Lead should NOT use Claude Code for routine implementation, boilerplate, or tasks a standard agent handles well.

### 7.6 Platform Handling (tmux vs node-pty)

The terminal session manager is still needed for **sending** commands to Claude Code. It just no longer needs any output capture logic.

```typescript
// Platform-appropriate session manager — write-only interface
interface TerminalSession {
  start(): Promise<void>;
  sendKeys(command: string): Promise<void>;   // The only operation we need
  kill(): Promise<void>;
}

// Linux: tmux (preferred — session survives if AIDO restarts)
class TmuxSession implements TerminalSession {
  constructor(private name: string, private workingDir: string) {}

  async start(): Promise<void> {
    await exec(
      `tmux new-session -d -s ${this.name} -x 200 -y 50 -c ${this.workingDir}`
    );
  }
  async sendKeys(command: string): Promise<void> {
    // send-keys is the only tmux command we ever call
    await exec(
      `tmux send-keys -t ${this.name} ${shellEscape(command)} Enter`
    );
  }
  async kill(): Promise<void> {
    await exec(`tmux kill-session -t ${this.name}`).catch(() => {});
  }
}

// Windows: node-pty (ConPTY) — write-only, output discarded
class PtySession implements TerminalSession {
  private pty?: IPty;

  constructor(private workingDir: string) {}

  async start(): Promise<void> {
    this.pty = spawn('powershell.exe', [], {
      cwd: this.workingDir,
      cols: 200,
      rows: 50,
    });
    // We intentionally do NOT attach an onData handler.
    // Output goes nowhere — by design.
  }
  async sendKeys(command: string): Promise<void> {
    this.pty!.write(command + '\r');
  }
  async kill(): Promise<void> {
    this.pty?.kill();
  }
}

// Factory
function createSession(name: string, workingDir: string): TerminalSession {
  return process.platform === 'win32'
    ? new PtySession(workingDir)
    : new TmuxSession(name, workingDir);
}
```

Note how much simpler both implementations are compared to the original plan — no `capturePane`, no output parsing, no completion markers. The `sendKeys` method is the entire write interface.

---

## 8. LLM Provider Abstraction

### 8.1 Unified Interface

```typescript
interface LLMProvider {
  chat(request: ChatRequest): Promise<ChatResponse>;
  streamChat(request: ChatRequest): AsyncGenerator<ChatChunk>;
}

interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

interface ChatResponse {
  content: ContentBlock[];          // Text + tool_use blocks
  usage: { inputTokens: number; outputTokens: number };
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
}
```

### 8.2 Model Router Logic

```typescript
class ModelRouter {
  selectModel(taskType: string, preferredId?: string): ModelConfig {
    // 1. If preferred model specified and available, use it
    // 2. Filter models that list this task type in their roles
    // 3. Among eligible models, pick based on:
    //    - Current rate limit headroom (prefer models with more capacity)
    //    - Cost (prefer cheaper for simple tasks)
    //    - Capability tier (prefer stronger for complex tasks)
    // 4. If all eligible models are rate-limited, return the one
    //    with the shortest wait time
  }
}
```

---

## 9. Web Frontend

### 9.1 Technology

- **Vite + React + TypeScript**
- **Tailwind CSS** for styling
- **Socket.IO client** for real-time updates
- **xterm.js** for embedded terminal views
- **@dagrejs/dagre + React Flow** for task graph visualization
- **Zustand** for state management

### 9.2 Views

**Setup Wizard** — shown on first launch:
- Upload `models.yaml` (or paste / edit in-browser)
- Upload `spec.md` (or paste / edit in-browser)
- Validate configs, show detected models and roles
- "Start Project" button

**Dashboard** (main view after project starts):
- **Task Graph** — visual DAG, color-coded by status (green=done, blue=in-progress, yellow=review, red=failed, gray=pending). Click a node to see details.
- **Agent Cards** — one per active agent, showing: role, model, current task, token consumption, streaming output preview.
- **Budget Meter** — cost spent vs. budget, estimated remaining.
- **Timeline** — chronological log of events (task created, agent spawned, result approved, etc.).

**Agent Detail** — click into an agent:
- Full conversation history (collapsible tool calls)
- Terminal view (if the agent has a shell session)
- Artifacts produced

**Settings / Override** — accessible at any time:
- Pause/resume orchestration
- Manually approve/reject a pending review
- Force-reassign a task to a different model
- Adjust budget
- Add new instructions for the Team Lead

### 9.3 Socket Events

| Event (server → client) | Payload |
|--------------------------|---------|
| `task:created` | Task object |
| `task:updated` | Task ID + changed fields |
| `agent:spawned` | Agent ID, role, model, task |
| `agent:output` | Agent ID + content chunk (streamed) |
| `agent:completed` | Agent ID + result summary |
| `agent:terminated` | Agent ID + reason |
| `budget:update` | Current spend, remaining |
| `project:status` | Overall status change |
| `claude-code:status` | idle / busy / rate-limited + ETA, current task ID |

| Event (client → server) | Payload |
|--------------------------|---------|
| `project:start` | Config + spec |
| `project:pause` | — |
| `project:resume` | — |
| `task:override` | Task ID + action |
| `team-lead:inject` | Free-text instruction |

---

## 10. Implementation Phases

### Phase 1: Foundation (Est. 3-5 days of focused AI dev time)

**Goal:** Core infrastructure that can run a single agent on a single task.

1. Project scaffolding (TypeScript, ESLint, build config)
2. Config loader with Zod validation (`models.yaml` + `spec.md`)
3. LLM provider abstraction — Anthropic provider first
4. Tool system: `shell_exec`, `file_read`, `file_write`, `file_patch`, `file_search`, `directory_list`
5. Base agent with tool-use loop (send message → parse tool calls → execute → loop)
6. Workspace manager (create project directory, init git)
7. Structured logger (pino, writes to disk + emits to socket)
8. Basic Express server with REST endpoints for config upload + status

**Milestone:** Can upload a config, spin up one agent, and have it create files via tool use.

### Phase 2: Orchestration (Est. 3-5 days)

**Goal:** Multi-agent coordination with the Team Lead.

1. Task graph data structure + persistence (JSON file on disk)
2. Agent pool manager (spawn, track, terminate agents)
3. Team Lead agent with planning/review system prompt and management tools
4. Model router with rate-limit tracking
5. Budget tracker (token counting, cost estimation, hard stops)
6. Context manager (conversation summarization for long-running agents)
7. Concurrency control (parallel agents, queue when at capacity)

**Milestone:** Team Lead can decompose a spec into tasks, assign them to workers, review results, and iterate.

### Phase 3: Web UI (Est. 3-5 days)

**Goal:** Full monitoring and control dashboard.

1. Vite + React project setup
2. Socket.IO integration (real-time events from server)
3. Setup wizard (config upload + validation)
4. Dashboard layout: task graph, agent cards, budget meter
5. Agent detail view with conversation history
6. Terminal view (xterm.js) for shell session streaming
7. Log stream with filtering
8. Override controls (pause, resume, inject instructions)

**Milestone:** User can monitor the entire development process in real-time through the browser.

### Phase 4: Claude Code Bridge (Est. 2-3 days)

**Goal:** Controlled integration with Claude Code CLI via file-based protocol.

1. Inbox/outbox/signals directory structure and lifecycle management
2. tmux session manager (Linux) + node-pty fallback (Windows) — write-only interface
3. Claude Code bridge: write task to inbox, send terminal command, watch for signal file, read outbox
4. Rate-limit detection via signal file status + cooldown/retry logic
5. Team Lead escalation tools (`escalate_to_claude_code`)
6. UI integration: Claude Code status indicator, inbox/outbox file viewer

**Milestone:** Team Lead can delegate hard problems to Claude Code and incorporate results.

### Phase 5: Additional Providers + Polish (Est. 2-3 days)

**Goal:** Multi-provider support and production hardening.

1. OpenAI provider
2. Google (Gemini) provider
3. Local model provider (Ollama-compatible)
4. Git integration tools (branch per task, merge on approval)
5. Retry/resilience improvements (provider failover)
6. Workspace file watcher → UI file explorer
7. Project completion detection + final summary generation
8. Error recovery: agent crash recovery, orchestrator restart from persisted state

**Milestone:** Full feature set, robust against failures, supports mixed model deployments.

---

## 11. Key Design Decisions

### 11.1 Why event-driven, not pipeline?

A pipeline (design → implement → test → deploy) is too rigid. Real development is iterative — a test failure might require rearchitecting, a review might reject code, a dependency issue might block multiple tasks. The event-driven task graph lets the Team Lead react to reality rather than follow a script.

### 11.2 Why one persistent Team Lead?

Multiple peer agents with no leader leads to coordination chaos. A single Team Lead with a global view can make coherent decisions about priorities, resolve conflicts between agents, and maintain architectural consistency. The trade-off is that the Team Lead becomes a bottleneck — mitigated by keeping it focused on decisions, not implementation.

### 11.3 Why ephemeral workers?

Long-running worker conversations accumulate context noise. A fresh agent for each task gets a clean context window, focused system prompt, and relevant context only. This also means we can use different models for different tasks without awkward model-switching mid-conversation.

### 11.4 Why file-based I/O for Claude Code?

Claude Code is an interactive CLI tool that manages its own state. The naive approach — parsing terminal output to detect completion and extract responses — is deeply fragile: ANSI escape codes, varying prompt styles, buffer overflows, and partial reads all create hard-to-diagnose failures. Instead, we treat the terminal as a **write-only pipe** and route all responses through the filesystem. Claude Code writes its response to a file and drops a sentinel file when done. The orchestrator watches for the sentinel, reads the response file, and never touches terminal output. This costs ~30 extra tokens per invocation (for the file I/O instructions in the prompt) but eliminates an entire class of integration bugs. tmux is still used on Linux because it gives us session persistence — if AIDO restarts, the tmux session (and any in-flight Claude Code work) survives.

### 11.5 Why not containerize each agent?

Overkill for this use case. The whole VM is the sandbox. Running agents in separate Docker containers would add latency (especially for filesystem operations) and complexity (networking, volume mounts) without meaningful safety benefit since the VM itself is disposable.

---

## 12. Risk Mitigation

| Risk | Mitigation |
|------|------------|
| **Runaway costs** | Hard budget cap with automatic shutdown. Cost tracked per-token in real-time. Budget warnings at configurable thresholds. |
| **Agent loops** | Max attempts per task (default: 3). Max consecutive tool calls per turn (default: 50). Team Lead reviews failures and can change strategy. |
| **Context window overflow** | Periodic summarization for Team Lead. Fresh context for each worker. File contents loaded on-demand, not preloaded. |
| **Rate limiting** | Per-model token buckets. Automatic fallback to alternative models. Queue with backoff when all models busy. |
| **State corruption** | Task graph persisted to disk after every mutation. Orchestrator can restart from last persisted state. Git commits at each task completion for code state recovery. |
| **Claude Code hangs** | Hard timeout (10 min default). If signal file doesn't appear, kill tmux session and recreate. Inbox/outbox files provide clean audit trail. Team Lead notified to fall back to normal agents. |
| **Network failures** | Retry with exponential backoff (3 attempts default). Provider failover if one API is down. Local model fallback if configured. |

---

## 13. Dependencies

### Runtime
```json
{
  "dependencies": {
    "express": "^5.0",
    "socket.io": "^4.7",
    "zod": "^3.23",
    "yaml": "^2.4",
    "pino": "^9.0",
    "pino-pretty": "^11.0",
    "nanoid": "^5.0",
    "node-pty": "^1.0",
    "glob": "^11.0",
    "chokidar": "^4.0",
    "p-queue": "^8.0",
    "tiktoken": "^1.0"
  },
  "devDependencies": {
    "typescript": "^5.5",
    "tsx": "^4.0",
    "vite": "^6.0",
    "react": "^19.0",
    "react-dom": "^19.0",
    "@types/express": "^5.0",
    "tailwindcss": "^4.0",
    "xterm": "^5.0",
    "xterm-addon-fit": "^0.10",
    "@xyflow/react": "^12.0",
    "zustand": "^5.0",
    "socket.io-client": "^4.7"
  }
}
```

### System (installed via `scripts/setup.sh`)
- `tmux` (Linux) — for Claude Code bridge
- `git` — workspace version control
- `ripgrep` (`rg`) — fast code search

---

## 14. Getting Started (User Experience)

```bash
# 1. On a fresh VM with Node.js installed:
git clone https://github.com/[you]/aido.git
cd aido
npm install
npm run build

# 2. Start the server
npm start
# → Server running at http://localhost:3000

# 3. Open browser, complete setup wizard:
#    - Upload or paste models.yaml
#    - Upload or paste spec.md
#    - Click "Start Project"

# 4. Watch the AI team work.
#    Output is written to /workspace/[project-name]/

# 5. When done, grab the code and tear down the VM.
```

---

## 15. Future Extensions (Post-MVP)

- **Persistent memory across projects:** Vector DB for lessons learned, reusable patterns.
- **Multi-project support:** Run several projects on one VM.
- **Human-in-the-loop checkpoints:** Configurable approval gates (e.g., require human sign-off before deployment steps).
- **Plugin system:** Custom agent roles, tools, and providers via a plugin API.
- **Metrics dashboard:** Historical cost/time/quality analytics across runs.
- **MCP server integration:** Expose the orchestrator as an MCP server so other tools can interact with it.
- **Self-improvement:** The tool could refine its own prompts based on project outcomes.
