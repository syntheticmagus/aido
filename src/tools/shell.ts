import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Tool, ToolResult, AgentContext } from './types.js';
import type { TaskType } from '../config/schema.js';

const MAX_OUTPUT_BYTES = 1_048_576; // 1 MB

// ─── Shell write-pattern blocking ─────────────────────────────────────────────

/**
 * Roles that must not write files via shell commands.
 * These agents have shell_exec for running/testing but not for editing.
 */
const SHELL_WRITE_RESTRICTED = new Set<TaskType>(['validate', 'review']);

/**
 * Patterns that indicate an attempt to write or overwrite files via shell.
 * Ordered from most specific to most general.
 */
const SHELL_FILE_WRITE_PATTERNS: RegExp[] = [
  // sed -i / --in-place: in-place file edit
  /\bsed\s+(?:-[a-zA-Z]*i[a-zA-Z]*\b|--in-place\b)/m,
  // tee writing to a real file (not /dev/null, /dev/stdout, /dev/stderr)
  /\btee\b(?!\s+\/dev\/(?:null|stdout|stderr))\s+\S/m,
  // mv: could clobber source files
  /\bmv\s+\S+\s+\S/m,
  // cmd >> file — append redirect; exclude >>&digit FD redirects (e.g. >>&1)
  /(?:^|[;&|({\n])\s*(?:cat|echo|printf)\b[^|<\n]*>>(?![&\d])/m,
  // cmd > file — overwrite redirect; exclude >&digit FD redirects (e.g. 2>&1) and >>
  /(?:^|[;&|({\n])\s*(?:cat|echo|printf)\b[^|<\n]*(?<![>])>(?![>&\d])/m,
  // bare > file — exclude >&, >>, and >/dev/ paths
  /(?:^|[;&|({\n])\s*>(?![>&])\s*(?!\/dev\/)\S/m,
];

function detectShellWrite(command: string): boolean {
  return SHELL_FILE_WRITE_PATTERNS.some((re) => re.test(command));
}

/**
 * Pick the best available shell for the current platform.
 *
 * On Windows, LLMs generate POSIX commands (ls, cat, mkdir -p, &&, ||) that
 * fail or behave incorrectly in cmd.exe and partly in PowerShell 5.x.
 * Git for Windows bundles a full bash that handles all of these correctly.
 * PowerShell 7 (pwsh) also works but is an optional install.
 * We fall back to PowerShell 5.x (powershell.exe) which covers most common
 * commands even though it lacks && / || chain operators.
 */
function resolveShell(): string | true {
  if (process.platform !== 'win32') return true; // /bin/sh on POSIX
  const candidates = [
    'C:/Program Files/Git/bin/bash.exe',  // Git for Windows (most compatible)
    'C:/Program Files (x86)/Git/bin/bash.exe',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall back to PowerShell 5.x — better than cmd.exe for POSIX-ish commands
  return 'powershell.exe';
}

const SHELL = resolveShell();

interface ShellExecParams {
  command: string;
  timeout?: number;
  workingDir?: string;
}

export class ShellTool implements Tool {
  readonly name = 'shell_exec';
  readonly description =
    'Execute a shell command in the project workspace and return stdout, stderr, and exit code. ' +
    'Default timeout is 120s. Working directory defaults to the project workspace root.';
  readonly parameters = {
    type: 'object' as const,
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 120000)',
      },
      workingDir: {
        type: 'string',
        description: 'Working directory (relative to workspace root or absolute within it)',
      },
    },
    required: ['command'],
  };

  async execute(params: unknown, context: AgentContext): Promise<ToolResult> {
    const { command, timeout = 120_000, workingDir } = params as ShellExecParams;

    // Resolve and clamp working directory to workspace root
    let cwd = context.workspaceRoot;
    if (workingDir) {
      const resolved = path.resolve(context.workspaceRoot, workingDir);
      const resolvedRoot = path.resolve(context.workspaceRoot);
      const safe = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
      if (resolved !== resolvedRoot && !resolved.startsWith(safe)) {
        return {
          success: false,
          output: '',
          error: `Working directory "${workingDir}" is outside the workspace root.`,
        };
      }
      cwd = resolved;
    }

    // Block shell file-write bypass attempts for read-only roles
    if (context.taskType && SHELL_WRITE_RESTRICTED.has(context.taskType) && detectShellWrite(command)) {
      return {
        success: false,
        output: '',
        error:
          `Shell file-write blocked: "${context.taskType}" agents may not write files via shell ` +
          `commands (e.g. cat >, echo >, sed -i, tee, mv). ` +
          `If you found a bug or build error, describe it precisely in report_result ` +
          `so the team lead can dispatch a debug agent to fix it.`,
      };
    }

    return new Promise<ToolResult>((resolve) => {
      let stdoutBuf = '';
      let stderrBuf = '';
      let truncated = false;

      const proc = spawn(command, { shell: SHELL, cwd });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        resolve({
          success: false,
          output: buildOutput(-1, stdoutBuf, stderrBuf),
          error: `Command timed out after ${timeout}ms`,
        });
      }, timeout);

      proc.stdout.on('data', (chunk: Buffer) => {
        const str = chunk.toString();
        context.emitOutput(str);
        if (stdoutBuf.length < MAX_OUTPUT_BYTES) {
          stdoutBuf += str;
          if (stdoutBuf.length >= MAX_OUTPUT_BYTES) {
            const omitted = 'total';
            stdoutBuf += `\n[OUTPUT TRUNCATED — ${omitted} bytes exceeded 1 MB limit]`;
            truncated = true;
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        const str = chunk.toString();
        if (!truncated && stderrBuf.length < MAX_OUTPUT_BYTES) {
          stderrBuf += str;
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          success: code === 0,
          output: buildOutput(code ?? -1, stdoutBuf, stderrBuf),
          metadata: { exitCode: code },
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          output: buildOutput(-1, stdoutBuf, stderrBuf),
          error: err.message,
        });
      });
    });
  }
}

function buildOutput(exitCode: number, stdout: string, stderr: string): string {
  return `Exit: ${exitCode}\nStdout:\n${stdout}\nStderr:\n${stderr}`;
}
