# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AIDO (Autonomous AI Development Orchestrator) is a Node.js/TypeScript tool that turns a disposable VM into an autonomous software development environment. A user provides a project spec and a models config; AIDO spawns a coordinated AI agent team that architects, implements, tests, debugs, and delivers a complete software product with no human intervention.

**Current state:** The codebase is in pre-implementation planning phase. The authoritative source of design decisions is `AIDO-implementation-plan.md`. Consult it before implementing anything.

---

## Planned Stack

- **Backend:** Node.js + TypeScript, Express, Socket.IO, pino (logging), Zod (config validation), chokidar (file watching), node-pty (Windows terminal sessions)
- **Frontend:** Vite + React + TypeScript, Tailwind CSS, Socket.IO client, xterm.js, @dagrejs/dagre + React Flow, Zustand
- **Linux terminal management:** tmux (preferred — survives AIDO restarts)
- **Windows terminal management:** node-pty (ConPTY)

## Planned Commands

Once scaffolded (`package.json` and `tsconfig.json` created per the plan):

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm start            # Start server + orchestrator
npm test             # Run tests
npm run lint         # ESLint
```

Frontend (in `frontend/`):
```bash
npm install
npm run dev          # Vite dev server
npm run build        # Production build
```

---

## Architecture

### Top-Level Modules (`src/`)

| Module | Responsibility |
|--------|---------------|
| `index.ts` | Entry point — starts Express server + orchestrator |
| `config/` | Zod schemas + loader for `models.yaml` and `spec.md` |
| `server/` | Express app, REST routes (`/api`, `/artifacts`), Socket.IO handlers |
| `orchestrator/` | Main event loop, task DAG, agent pool, budget tracker |
| `agents/` | Team Lead (persistent) + ephemeral worker agents (architect, developer, reviewer, tester, debugger, devops, docs) |
| `llm/` | Provider abstraction (Anthropic, OpenAI, Google, local/Ollama), model router, context manager, cost estimator |
| `tools/` | Tool registry + implementations: shell_exec, file I/O, git, browser (Puppeteer), Claude Code bridge |
| `workspace/` | Workspace init, layout (`/workspace/<project>/`), file watcher |
| `utils/` | Structured logger, retry/backoff, ID generation |

### Orchestration Model

- **Team Lead** is the only persistent, long-running agent. It reads the task graph, decides what to do next, and dispatches work.
- **Worker agents** are ephemeral — fresh context per task, terminated after reporting results. The Team Lead cannot be bypassed.
- **Task graph** is a DAG (`Task` interface in `orchestrator/task-graph.ts`). Workers report results; only the Team Lead mutates the graph.
- **Concurrency:** multiple workers can run in parallel. Model router enforces per-model rate limits via token buckets.
- **Context management:** Team Lead's conversation is summarized every N turns (configurable) to avoid context overflow.

### Claude Code Bridge (`tools/claude-code.ts`)

Claude Code is a **specialist oracle** used sparingly (worker failed 2+ times, complex refactoring, debugging, architecture validation). It is integrated via a **file-based protocol** — the terminal is a write-only command pipe; all responses flow through the filesystem:

- **`/workspace/.aido/claude-code/inbox/task-{id}.md`** — orchestrator writes task descriptions here
- **`/workspace/.aido/claude-code/outbox/task-{id}.md`** — Claude Code writes structured markdown response here
- **`/workspace/.aido/claude-code/signals/task-{id}.done`** — Claude Code writes a single status keyword (`SUCCESS`, `FAILED`, `PARTIAL`, `RATE_LIMITED`) here when done

The bridge writes the inbox file, sends a single command string to the terminal session, then watches `signals/` with chokidar. On signal arrival it reads the outbox file. It never reads terminal output — this eliminates ANSI escape codes, buffer overflows, partial reads, and prompt-detection heuristics entirely.

### LLM Provider Abstraction (`llm/`)

All providers implement `LLMProvider` with `chat()` and `streamChat()`. The model router selects a model based on task type, role assignments in `models.yaml`, rate-limit headroom, cost, and capability tier. Claude Code rate-limiting is signalled via the `RATE_LIMITED` sentinel file, triggering a configurable cooldown.

### Configuration (`models.yaml`)

User-supplied file with per-model configuration (provider, API key, roles, rate limits, cost per 1k tokens) plus a `claudeCode` section and a `budget` section (hard cost cap, wall-clock hour limit). Env var interpolation (`${VAR}`) is supported. See `AIDO-implementation-plan.md §4.1` for the full schema.

### Web Frontend (`frontend/`)

Single-page React app communicating over Socket.IO:
- **Setup Wizard** — upload/paste `models.yaml` and `spec.md`, validate, start project
- **Dashboard** — live task DAG (React Flow), agent cards with streaming output, budget meter, event timeline
- **Agent Detail** — full conversation history, terminal view (xterm.js), artifacts
- **Override panel** — pause/resume, manual approve/reject, force-reassign tasks, inject instructions to Team Lead

---

## Key Design Decisions

- **File-based Claude Code protocol** over terminal output parsing — deterministic, debuggable, costs ~30 extra tokens per invocation.
- **One persistent Team Lead** rather than peer agents — global view enables coherent prioritization and architectural consistency.
- **Ephemeral workers** — fresh context per task eliminates accumulated context noise; different models can be used per task type.
- **Event-driven task graph** rather than a fixed pipeline — lets the Team Lead react to failures, rework, and new information dynamically.
- **No per-agent containerization** — the whole VM is the sandbox; Docker overhead is not justified.

## Implementation Phases

See `AIDO-implementation-plan.md §10` for the full phased plan:
1. **Foundation** — config, Anthropic provider, tool system, base agent, workspace, Express server
2. **Orchestration** — task graph, agent pool, Team Lead, model router, budget, context manager
3. **Web UI** — Vite/React, Socket.IO, dashboard, terminal view, override controls
4. **Claude Code Bridge** — file-based protocol, tmux/node-pty, rate-limit handling
5. **Additional Providers + Polish** — OpenAI, Gemini, Ollama, git integration, error recovery
