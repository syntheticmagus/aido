# AIDO — Autonomous AI Development Orchestrator

AIDO is a self-hosted server that spawns coordinated teams of AI agents to autonomously build software. You provide a project spec and a models configuration; AIDO handles planning, task decomposition, execution, and review.

## Requirements

- Node.js >= 20
- npm
- Git (in PATH)
- API key(s) for at least one supported LLM provider (Anthropic, OpenAI, Google)
- Optional: `ripgrep` (`rg`) for faster file search inside agents

## Quick Start

```bash
# Install dependencies
npm install
cd frontend && npm install && cd ..

# Build frontend and backend
cd frontend && npm run build && cd ..
npm run build

# Configure your models
cp examples/models.example.yaml models.yaml
# Edit models.yaml and set your API keys (or use ANTHROPIC_API_KEY / OPENAI_API_KEY env vars)

# Start the server
npm start
# Open http://localhost:3000
```

For development (hot-reload):
```bash
# Terminal 1: backend
npm run dev

# Terminal 2: frontend
cd frontend && npm run dev
# Open http://localhost:5173 (proxies API to :3000)
```

## Configuration

### models.yaml

Defines which LLM models are available, their roles, rate limits, and cost budgets. See [`examples/models.example.yaml`](examples/models.example.yaml).

Environment variable interpolation is supported: `apiKey: "${ANTHROPIC_API_KEY}"`.

### Project spec

A markdown file describing what you want built. See [`examples/spec.example.md`](examples/spec.example.md).

## Architecture

```
src/
  index.ts              Entry point: HTTP server, Socket.IO, graceful shutdown
  config/               Zod schemas + YAML loader with env-var interpolation
  llm/                  Provider adapters (Anthropic, OpenAI, Google, local/Ollama)
                        + ModelRouter (token-bucket rate limiting) + cost estimator
  agents/               BaseAgent (tool-use loop) + TeamLead + WorkerAgent factory
  orchestrator/         TaskGraph, BudgetTracker, AgentPool, Orchestrator
  tools/                Shell, filesystem, git, Claude Code bridge
  workspace/            WorkspaceManager (project init) + WorkspaceWatcher (chokidar)
  server/               Express routes (/api, /artifacts) + Socket.IO handlers
  utils/                Logger (pino), ID generation, retry with backoff

frontend/src/
  stores/appStore.ts    Zustand — agent outputs stored as string[] (not concatenated)
  hooks/useSocket.ts    Module-level Socket.IO singleton
  components/           TaskGraph (React Flow + dagre), TerminalView (xterm.js),
                        AgentCard, LogStream, FileExplorer, ConfigUpload, Dashboard
```

## Workspace layout

Each project lives under `/workspace/<project-name>/`:

```
.aido/
  spec.md, models.yaml       — project configuration
  task-graph.json            — live task DAG (persisted synchronously)
  budget.json                — cumulative token/cost tracking
  agents/<agentId>/
    history.json             — full conversation history per agent
  claude-code/
    inbox/, outbox/, signals/ — file-based Claude Code CLI bridge
```

## Supported LLM Providers

| Provider | `provider` value | Notes |
|----------|-----------------|-------|
| Anthropic | `anthropic` | Claude models |
| OpenAI | `openai` | GPT-4o, o1, etc. |
| Google | `google` | Gemini models |
| Local / Ollama | `local` | Any OpenAI-compatible endpoint |

## Claude Code Bridge (optional)

AIDO can escalate tasks to the Claude Code CLI. Enable in `models.yaml`:

```yaml
claudeCode:
  enabled: true
  cooldownMinutes: 60
  timeoutMinutes: 10
```

Requires `claude` CLI in PATH and an active Claude session. The bridge uses a file-based inbox/outbox protocol so AIDO never touches Claude Code's terminal output.

## License

MIT — see [LICENSE](LICENSE).
