import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import chokidar, { type FSWatcher } from 'chokidar';
import { createLogger } from '../utils/logger.js';
import { sleep } from '../utils/retry.js';

const log = createLogger({ module: 'claude-code-bridge' });
const execAsync = promisify(exec);

export type ClaudeCodeStatus = 'SUCCESS' | 'FAILED' | 'PARTIAL' | 'RATE_LIMITED';
export type BridgeState = 'idle' | 'busy' | 'rate-limited' | 'unavailable';

export interface ClaudeCodeResult {
  taskId: string;
  status: ClaudeCodeStatus;
  summary: string;
  filesChanged: string;
  issues: string;
  details: string;
  rawResponse: string;
}

interface PendingTask {
  resolve: (result: ClaudeCodeResult) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

// ─── Terminal session interface (write-only) ──────────────────────────────────

interface TerminalSession {
  start(): Promise<void>;
  sendKeys(text: string): Promise<void>;
  kill(): Promise<void>;
  isAlive(): Promise<boolean>;
}

class TmuxSession implements TerminalSession {
  constructor(
    private readonly name: string,
    private readonly cwd: string,
  ) {}

  async start(): Promise<void> {
    await execAsync(
      `tmux new-session -d -s ${shellEscape(this.name)} -x 220 -y 50 -c ${shellEscape(this.cwd)}`,
    );
    log.info({ session: this.name }, 'tmux session started');
  }

  async sendKeys(command: string): Promise<void> {
    // send-keys is the ONLY tmux command we use after startup.
    await execAsync(
      `tmux send-keys -t ${shellEscape(this.name)} ${shellEscape(command)} Enter`,
    );
  }

  async kill(): Promise<void> {
    await execAsync(`tmux kill-session -t ${shellEscape(this.name)}`).catch(() => {});
    log.info({ session: this.name }, 'tmux session killed');
  }

  async isAlive(): Promise<boolean> {
    try {
      await execAsync(`tmux has-session -t ${shellEscape(this.name)}`);
      return true;
    } catch {
      return false;
    }
  }
}

class PtySession implements TerminalSession {
  private pty: unknown = null;
  private alive = false;

  constructor(private readonly cwd: string) {}

  async start(): Promise<void> {
    try {
      // Dynamic import with try/catch — node-pty is a native addon
      // that may not build on all platforms.
      const nodePty = await import('node-pty');
      const spawn = nodePty.spawn as (
        file: string,
        args: string[],
        options: Record<string, unknown>,
      ) => { write(data: string): void; kill(): void };

      this.pty = spawn('powershell.exe', [], {
        cwd: this.cwd,
        cols: 220,
        rows: 50,
        // CRITICAL: Do NOT attach an onData handler.
        // Terminal output is intentionally discarded — all responses
        // come through the filesystem (inbox/outbox/signals protocol).
      });
      this.alive = true;
      log.info('node-pty session started');
    } catch (err) {
      log.error({ err }, 'node-pty failed to load — Claude Code bridge unavailable');
      throw err;
    }
  }

  async sendKeys(command: string): Promise<void> {
    (this.pty as { write(d: string): void }).write(command + '\r');
  }

  async kill(): Promise<void> {
    try {
      (this.pty as { kill(): void }).kill();
    } catch {
      // Ignore
    }
    this.alive = false;
  }

  async isAlive(): Promise<boolean> {
    return this.alive && this.pty !== null;
  }
}

function createTerminalSession(name: string, cwd: string): TerminalSession {
  return process.platform === 'win32'
    ? new PtySession(cwd)
    : new TmuxSession(name, cwd);
}

// Shell-escape a string for use in a tmux send-keys argument.
function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

// ─── Bridge ───────────────────────────────────────────────────────────────────

export interface ClaudeCodeConfig {
  binaryPath?: string;
  maxConcurrentSessions?: number;
  usageLimitCooldownMs?: number;
  timeoutMs?: number;
  workspaceRoot: string;
  projectName: string;
}

export class ClaudeCodeBridge extends EventEmitter {
  private session: TerminalSession | null = null;
  private watcher: FSWatcher | null = null;
  private state: BridgeState = 'idle';
  private cooldownUntil?: Date;
  private pendingTasks = new Map<string, PendingTask>();

  private inboxDir: string;
  private outboxDir: string;
  private signalsDir: string;
  private binaryPath: string;
  private usageLimitCooldownMs: number;
  private timeoutMs: number;

  constructor(private readonly config: ClaudeCodeConfig) {
    super();
    const baseDir = path.join(
      config.workspaceRoot,
      '.aido',
      'claude-code',
    );
    this.inboxDir = path.join(baseDir, 'inbox');
    this.outboxDir = path.join(baseDir, 'outbox');
    this.signalsDir = path.join(baseDir, 'signals');
    this.binaryPath = config.binaryPath ?? 'claude';
    this.usageLimitCooldownMs = config.usageLimitCooldownMs ?? 3_600_000;
    this.timeoutMs = config.timeoutMs ?? 600_000; // 10 min
  }

  async initialize(): Promise<void> {
    // Ensure dirs exist
    await fs.mkdir(this.inboxDir, { recursive: true });
    await fs.mkdir(this.outboxDir, { recursive: true });
    await fs.mkdir(this.signalsDir, { recursive: true });

    // Restart recovery: process any signal files that exist from before restart
    await this.recoverPendingSignals();

    // Start terminal session
    try {
      this.session = createTerminalSession(
        `aido-cc-${this.config.projectName}`,
        path.join(this.config.workspaceRoot),
      );
      await this.session.start();
    } catch (err) {
      log.error({ err }, 'Terminal session failed to start — bridge unavailable');
      this.setState('unavailable');
      return;
    }

    // Watch signals/ — the ONLY way we detect Claude Code completion
    this.watcher = chokidar.watch(this.signalsDir, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    this.watcher.on('add', (filepath: string) => {
      void this.onSignalFile(filepath);
    });

    log.info({ projectName: this.config.projectName }, 'Claude Code bridge initialized');
  }

  async sendTask(taskId: string, inboxContent: string): Promise<ClaudeCodeResult> {
    if (this.state === 'unavailable') {
      throw new Error('Claude Code bridge is unavailable');
    }

    if (this.state === 'rate-limited') {
      const waitMs = this.cooldownUntil
        ? this.cooldownUntil.getTime() - Date.now()
        : 0;
      if (waitMs > 0) {
        throw new Error(`Claude Code is rate-limited. Retry after ${Math.ceil(waitMs / 1000)}s`);
      }
      // Cooldown expired — reset
      this.setState('idle');
    }

    // 1. Write task file to inbox
    const inboxPath = path.join(this.inboxDir, `task-${taskId}.md`);
    await fs.writeFile(inboxPath, inboxContent, 'utf-8');

    // 2. Build and send command (terminal is WRITE-ONLY — we never read output)
    const command =
      `${this.binaryPath} ` +
      `"Read the task at ${inboxPath}. ` +
      `Do the work described. When done, write your response to ` +
      `${this.outboxDir}/task-${taskId}.md using the format in the task. ` +
      `Then create the signal file ${this.signalsDir}/task-${taskId}.done ` +
      `containing just the status word (SUCCESS/FAILED/PARTIAL/RATE_LIMITED). ` +
      `Work in ${path.join(this.config.workspaceRoot)}."`;

    await this.session!.sendKeys(command);
    this.setState('busy', taskId);

    // 3. Return a Promise that resolves when the signal file appears
    return new Promise<ClaudeCodeResult>((resolve, reject) => {
      const timeout = setTimeout(async () => {
        this.pendingTasks.delete(taskId);
        await this.recoverSession();
        reject(new Error(`Claude Code task ${taskId} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pendingTasks.set(taskId, { resolve, reject, timeout });
    });
  }

  private async onSignalFile(filepath: string): Promise<void> {
    const match = path.basename(filepath).match(/^task-(.+)\.done$/);
    if (!match) return;
    const taskId = match[1]!;

    const pending = this.pendingTasks.get(taskId);

    try {
      // Read signal keyword
      const signal = (await fs.readFile(filepath, 'utf-8')).trim() as ClaudeCodeStatus;

      if (signal === 'RATE_LIMITED') {
        this.handleRateLimit();
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingTasks.delete(taskId);
          pending.reject(new Error('Claude Code rate limited'));
        }
        return;
      }

      // Read outbox response
      const outboxPath = path.join(this.outboxDir, `task-${taskId}.md`);
      let rawResponse = '';
      try {
        rawResponse = await fs.readFile(outboxPath, 'utf-8');
      } catch {
        rawResponse = '(outbox file missing)';
      }

      const result = this.parseOutbox(taskId, signal, rawResponse);

      // Clean up signal and outbox (keep inbox for audit)
      await fs.unlink(filepath).catch(() => {});
      await fs.unlink(outboxPath).catch(() => {});

      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingTasks.delete(taskId);
        pending.resolve(result);
      }

      if (this.pendingTasks.size === 0) {
        this.setState('idle');
      }
    } catch (err) {
      log.error({ err, taskId }, 'Error processing signal file');
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingTasks.delete(taskId);
        pending.reject(err as Error);
      }
    }
  }

  private parseOutbox(
    taskId: string,
    signal: string,
    raw: string,
  ): ClaudeCodeResult {
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
    this.cooldownUntil = new Date(Date.now() + this.usageLimitCooldownMs);
    this.setState('rate-limited');
    log.warn(
      { cooldownUntil: this.cooldownUntil.toISOString() },
      'Claude Code rate limited',
    );
    // Auto-reset after cooldown
    setTimeout(() => {
      if (this.state === 'rate-limited') {
        this.setState('idle');
        log.info('Claude Code rate limit cooldown expired');
      }
    }, this.usageLimitCooldownMs);
  }

  private async recoverSession(): Promise<void> {
    this.setState('unavailable');
    log.warn('Recovering Claude Code terminal session...');
    try {
      await this.session?.kill();
      this.session = createTerminalSession(
        `aido-cc-${this.config.projectName}-r`,
        this.config.workspaceRoot,
      );
      await this.session.start();
      this.setState('idle');
      log.info('Claude Code session recovered');
    } catch (err) {
      log.error({ err }, 'Session recovery failed');
    }
  }

  private async recoverPendingSignals(): Promise<void> {
    try {
      const files = fsSync.readdirSync(this.signalsDir);
      for (const file of files) {
        if (file.endsWith('.done')) {
          log.info({ file }, 'Processing pre-existing signal file (restart recovery)');
          await this.onSignalFile(path.join(this.signalsDir, file));
        }
      }
    } catch {
      // Signals dir may not exist yet
    }
  }

  private setState(state: BridgeState, taskId?: string): void {
    this.state = state;
    this.emit('status', {
      status: state,
      taskId,
      cooldownUntil: this.cooldownUntil?.toISOString(),
      etaMs:
        state === 'rate-limited' && this.cooldownUntil
          ? Math.max(0, this.cooldownUntil.getTime() - Date.now())
          : undefined,
    });
  }

  getState(): BridgeState {
    return this.state;
  }

  async destroy(): Promise<void> {
    await this.watcher?.close();
    await this.session?.kill();
  }
}

function extractSection(raw: string, header: string): string {
  const marker = `### ${header}`;
  const start = raw.indexOf(marker);
  if (start === -1) return '';
  const contentStart = raw.indexOf('\n', start) + 1;
  const nextSection = raw.indexOf('\n### ', contentStart);
  const content =
    nextSection === -1
      ? raw.slice(contentStart)
      : raw.slice(contentStart, nextSection);
  return content.trim();
}

// ─── Format inbox file for Claude Code ───────────────────────────────────────

export function formatInboxFile(
  taskId: string,
  description: string,
  context: string,
  inboxDir: string,
  outboxDir: string,
  signalsDir: string,
): string {
  return `# Task: ${taskId}

## Objective
${description}

## Context
${context}

## Constraints
- Write your full response to: ${outboxDir}/task-${taskId}.md
- When completely finished, create the signal file: ${signalsDir}/task-${taskId}.done
- Use the response format specified below.

## Response Format
Write your outbox file with this structure:

### Status
SUCCESS | PARTIAL | FAILED | RATE_LIMITED

### Summary
One-paragraph description of what you did.

### Files Changed
- path/to/file1 — description of change

### Issues
Any problems encountered, unresolved questions, or suggestions.

### Details
Full explanation of your approach and any decisions made.
`;
}
