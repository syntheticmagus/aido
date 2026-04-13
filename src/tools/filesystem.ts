import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { spawn } from 'node:child_process';
import type { Tool, ToolResult, AgentContext } from './types.js';
import type { TaskType } from '../config/schema.js';

const MAX_LINES = 500;

// ─── File access control ──────────────────────────────────────────────────────

type PathCategory = 'system' | 'test' | 'config' | 'doc' | 'impl';

const CONFIG_BASENAMES = new Set([
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  '.gitignore', '.gitattributes', '.editorconfig',
]);
const CONFIG_PATTERNS = [
  /^tsconfig.*\.json$/i,
  /\.config\.(js|ts|mjs|cjs)$/i,
  /^\.env/i,
  /^\.eslintrc/i,
  /^\.prettierrc/i,
  /^babel\.config/i,
  /^jest\.config/i,
  /^vite\.config/i,
  /^webpack\.config/i,
];

function classifyPath(relativePath: string): PathCategory {
  const p = relativePath.replace(/\\/g, '/');
  const base = path.basename(p).toLowerCase();
  const lower = p.toLowerCase();

  // System — .aido/ and .git/ are off-limits to all agents
  if (lower.startsWith('.aido/') || lower === '.aido' || lower.startsWith('.git/') || lower === '.git') {
    return 'system';
  }
  // Test files
  if (/\.(test|spec)\.[^./]+$/.test(lower)) return 'test';
  if (/(^|\/)(tests?|__tests?__)\//.test(lower)) return 'test';
  // Config files (by known basename or pattern)
  if (CONFIG_BASENAMES.has(base)) return 'config';
  if (CONFIG_PATTERNS.some((re) => re.test(base))) return 'config';
  // Doc files
  if (lower.endsWith('.md') || /(^|\/)docs?\//.test(lower)) return 'doc';
  // Everything else is impl
  return 'impl';
}

// Which categories each role may write to. 'system' is never writable via tools.
const WRITE_PERMISSIONS: Record<TaskType, Set<PathCategory>> = {
  architecture: new Set(['doc']),
  implement:    new Set(['impl']),
  test:         new Set(['test']),
  review:       new Set(),
  debug:        new Set(['impl', 'test']),
  devops:       new Set(['config', 'impl']),
  docs:         new Set(['doc']),
  integrate:    new Set(['impl', 'config']),
  validate:     new Set(),
};

function checkWritePermission(
  resolvedPath: string,
  context: AgentContext,
): string | null {
  // No taskType = legacy/team-lead path; allow (team lead has no write tools anyway)
  if (!context.taskType) return null;

  const rel = path.relative(context.workspaceRoot, resolvedPath).replace(/\\/g, '/');
  const category = classifyPath(rel);

  if (category === 'system') {
    return `Write blocked: no agent may write to system files (.aido/, .git/).`;
  }

  // Implement agents with an assignedFiles list: whitelist is the sole gate.
  // Category is ignored — both src/foo.ts and tests/foo.test.ts may be assigned.
  if (context.taskType === 'implement' && context.assignedFiles && context.assignedFiles.length > 0) {
    const assignedResolved = context.assignedFiles.map((f) =>
      path.resolve(context.workspaceRoot, f).replace(/\\/g, '/'),
    );
    const resolvedNorm = resolvedPath.replace(/\\/g, '/');
    if (!assignedResolved.includes(resolvedNorm)) {
      return (
        `Write blocked: this implement task is authorized to write only: ` +
        `${context.assignedFiles.join(', ')}. Attempted: ${rel}`
      );
    }
    return null; // in whitelist — permitted regardless of category
  }

  const allowed = WRITE_PERMISSIONS[context.taskType] ?? new Set();
  if (!allowed.has(category)) {
    return `Write blocked: "${context.taskType}" agents may not write to ${category} files.`;
  }

  return null; // permitted
}

async function appendAuditLog(context: AgentContext, op: 'write' | 'patch', filePath: string): Promise<void> {
  try {
    const logPath = path.join(context.workspaceRoot, '.aido', 'file-writes.jsonl');
    const entry = JSON.stringify({
      ts: Date.now(),
      agentId: context.agentId,
      taskId: context.taskId,
      taskType: context.taskType ?? 'unknown',
      op,
      path: filePath,
    });
    await fs.appendFile(logPath, entry + '\n', 'utf-8');
  } catch {
    // Best-effort — don't let audit failures break the agent
  }
}

/** Normalize a path to forward slashes for use with fast-glob (which rejects backslashes). */
function toGlobPath(p: string): string {
  return p.replace(/\\/g, '/');
}

function clampToWorkspace(
  inputPath: string,
  workspaceRoot: string,
): string | null {
  const resolvedRoot = path.resolve(workspaceRoot); // normalise drive letter on Windows
  const resolved = path.resolve(workspaceRoot, inputPath);
  const safe = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (resolved !== resolvedRoot && !resolved.startsWith(safe)) return null;
  return resolved;
}

// ─── file_read ────────────────────────────────────────────────────────────────

interface FileReadParams {
  path: string;
  startLine?: number;
  endLine?: number;
}

export class FileReadTool implements Tool {
  readonly name = 'file_read';
  readonly description =
    'Read a file from the workspace. Returns line-numbered content. ' +
    `Max ${MAX_LINES} lines per call — use startLine/endLine for large files.`;
  readonly parameters = {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: 'File path (relative to workspace root)' },
      startLine: { type: 'number', description: '1-based line to start reading from' },
      endLine: { type: 'number', description: '1-based line to stop reading at (inclusive)' },
    },
    required: ['path'],
  };

  async execute(params: unknown, context: AgentContext): Promise<ToolResult> {
    const { path: inputPath, startLine, endLine } = params as FileReadParams;
    const resolved = clampToWorkspace(inputPath, context.workspaceRoot);
    if (!resolved) {
      return { success: false, output: '', error: 'Path is outside workspace root.' };
    }

    let content: string;
    try {
      content = await fs.readFile(resolved, 'utf-8');
    } catch (err) {
      return { success: false, output: '', error: `Cannot read file: ${(err as Error).message}` };
    }

    let lines = content.split('\n');
    const totalLines = lines.length;

    const start = Math.max(1, startLine ?? 1);
    const end = Math.min(totalLines, endLine ?? start + MAX_LINES - 1);
    lines = lines.slice(start - 1, end);

    if (lines.length > MAX_LINES) {
      lines = lines.slice(0, MAX_LINES);
      lines.push(`[TRUNCATED — showing lines ${start}-${start + MAX_LINES - 1} of ${totalLines}. Use startLine/endLine to read more.]`);
    }

    const numbered = lines
      .map((line, i) => `${String(start + i).padStart(6)} | ${line}`)
      .join('\n');

    return { success: true, output: numbered, metadata: { totalLines } };
  }
}

// ─── file_write ───────────────────────────────────────────────────────────────

interface FileWriteParams {
  path: string;
  content: string;
  createDirs?: boolean;
}

export class FileWriteTool implements Tool {
  readonly name = 'file_write';
  readonly description = 'Write (overwrite) a file in the workspace.';
  readonly parameters = {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: 'File path (relative to workspace root)' },
      content: { type: 'string', description: 'Full file content to write' },
      createDirs: {
        type: 'boolean',
        description: 'Create parent directories if they do not exist (default: true)',
      },
    },
    required: ['path', 'content'],
  };

  async execute(params: unknown, context: AgentContext): Promise<ToolResult> {
    const { path: inputPath, content, createDirs = true } = params as FileWriteParams;
    const resolved = clampToWorkspace(inputPath, context.workspaceRoot);
    if (!resolved) {
      return { success: false, output: '', error: 'Path is outside workspace root.' };
    }

    const denied = checkWritePermission(resolved, context);
    if (denied) return { success: false, output: '', error: denied };

    try {
      if (createDirs) {
        await fs.mkdir(path.dirname(resolved), { recursive: true });
      }
      await fs.writeFile(resolved, content, 'utf-8');
      void appendAuditLog(context, 'write', inputPath);
      return { success: true, output: `Written ${content.length} bytes to ${inputPath}` };
    } catch (err) {
      return { success: false, output: '', error: `Cannot write file: ${(err as Error).message}` };
    }
  }
}

// ─── file_patch ───────────────────────────────────────────────────────────────

interface FilePatchParams {
  path: string;
  search: string;
  replace: string;
  occurrence?: number;
}

export class FilePatchTool implements Tool {
  readonly name = 'file_patch';
  readonly description =
    'Apply a targeted search-and-replace edit to a file. ' +
    'Uses exact string matching (not regex). Specify occurrence (1-based) to target a specific instance.';
  readonly parameters = {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: 'File path (relative to workspace root)' },
      search: { type: 'string', description: 'Exact string to find' },
      replace: { type: 'string', description: 'String to replace it with' },
      occurrence: {
        type: 'number',
        description: 'Which occurrence to replace (1-based, default: 1)',
      },
    },
    required: ['path', 'search', 'replace'],
  };

  async execute(params: unknown, context: AgentContext): Promise<ToolResult> {
    const { path: inputPath, search, replace, occurrence = 1 } = params as FilePatchParams;
    const resolved = clampToWorkspace(inputPath, context.workspaceRoot);
    if (!resolved) {
      return { success: false, output: '', error: 'Path is outside workspace root.' };
    }

    const denied = checkWritePermission(resolved, context);
    if (denied) return { success: false, output: '', error: denied };

    let content: string;
    try {
      content = await fs.readFile(resolved, 'utf-8');
    } catch (err) {
      return { success: false, output: '', error: `Cannot read file: ${(err as Error).message}` };
    }

    let found = 0;
    let patched = false;
    const result = content.split(search).reduce<string>((acc, part, i, arr) => {
      if (i === arr.length - 1) return acc + part;
      found++;
      if (found === occurrence) {
        patched = true;
        return acc + part + replace;
      }
      return acc + part + search;
    }, '');

    if (!patched) {
      return {
        success: false,
        output: '',
        error: `String not found in ${inputPath} (occurrence ${occurrence}, total occurrences: ${found})`,
      };
    }

    try {
      await fs.writeFile(resolved, result, 'utf-8');
      void appendAuditLog(context, 'patch', inputPath);
      return { success: true, output: `Patched occurrence ${occurrence} in ${inputPath}` };
    } catch (err) {
      return { success: false, output: '', error: `Cannot write file: ${(err as Error).message}` };
    }
  }
}

// ─── file_search ──────────────────────────────────────────────────────────────

interface FileSearchParams {
  pattern: string;
  path?: string;
  fileGlob?: string;
  maxResults?: number;
}

export class FileSearchTool implements Tool {
  readonly name = 'file_search';
  readonly description =
    'Search for a pattern across workspace files. Uses ripgrep (rg) if available, otherwise falls back to Node.js glob+grep.';
  readonly parameters = {
    type: 'object' as const,
    properties: {
      pattern: { type: 'string', description: 'Search pattern (regex supported)' },
      path: { type: 'string', description: 'Directory to search in (default: workspace root)' },
      fileGlob: { type: 'string', description: 'File glob pattern (e.g. "*.ts")' },
      maxResults: { type: 'number', description: 'Maximum results to return (default: 100)' },
    },
    required: ['pattern'],
  };

  async execute(params: unknown, context: AgentContext): Promise<ToolResult> {
    const { pattern, path: searchPath, fileGlob, maxResults = 100 } = params as FileSearchParams;

    const searchDir = searchPath
      ? clampToWorkspace(searchPath, context.workspaceRoot) ?? context.workspaceRoot
      : context.workspaceRoot;

    // Try ripgrep first
    const rgResult = await tryRipgrep(pattern, searchDir, fileGlob, maxResults);
    if (rgResult !== null) return rgResult;

    // Fallback: Node.js glob + readline
    return await nodeGrepFallback(pattern, searchDir, fileGlob, maxResults);
  }
}

async function tryRipgrep(
  pattern: string,
  dir: string,
  fileGlob: string | undefined,
  maxResults: number,
): Promise<ToolResult | null> {
  return new Promise((resolve) => {
    const args = ['-n', '--no-heading', `-m${maxResults}`, pattern, dir];
    if (fileGlob) args.push('--glob', fileGlob);

    const proc = spawn('rg', args, { stdio: 'pipe' });
    let output = '';
    proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.on('close', (code) => {
      if (code === null || code > 1) {
        // rg not available or error
        resolve(null);
      } else {
        resolve({ success: true, output: output.trim() || '(no matches)' });
      }
    });
    proc.on('error', () => resolve(null));
  });
}

async function nodeGrepFallback(
  pattern: string,
  dir: string,
  fileGlob: string | undefined,
  maxResults: number,
): Promise<ToolResult> {
  const globDir = toGlobPath(dir);
  const globPattern = fileGlob ? `${globDir}/**/${fileGlob}` : `${globDir}/**/*`;
  const files = await fg(globPattern, { onlyFiles: true, ignore: ['**/.git/**', '**/.aido/**'] });

  const regex = new RegExp(pattern, 'g');
  const matches: string[] = [];

  for (const file of files) {
    if (matches.length >= maxResults) break;
    try {
      const content = await fs.readFile(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        if (regex.test(lines[i]!)) {
          matches.push(`${file}:${i + 1}:${lines[i]}`);
          regex.lastIndex = 0;
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return {
    success: true,
    output: matches.length > 0 ? matches.join('\n') : '(no matches)',
  };
}

// ─── directory_list ───────────────────────────────────────────────────────────

interface DirectoryListParams {
  path?: string;
  recursive?: boolean;
  maxDepth?: number;
}

export class DirectoryListTool implements Tool {
  readonly name = 'directory_list';
  readonly description = 'List directory contents in the workspace.';
  readonly parameters = {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: 'Directory path (default: workspace root)' },
      recursive: { type: 'boolean', description: 'List recursively (default: false)' },
      maxDepth: { type: 'number', description: 'Maximum recursion depth (default: 3)' },
    },
    required: [],
  };

  async execute(params: unknown, context: AgentContext): Promise<ToolResult> {
    const { path: inputPath, recursive = false, maxDepth = 3 } = params as DirectoryListParams;

    const dir = inputPath
      ? clampToWorkspace(inputPath, context.workspaceRoot) ?? context.workspaceRoot
      : context.workspaceRoot;

    const globDir = toGlobPath(dir);
    const pattern = recursive ? `${globDir}/**/*` : `${globDir}/*`;
    const files = await fg(pattern, {
      onlyFiles: false,
      ignore: ['**/.git/**'],
      deep: recursive ? maxDepth : 1,
    });

    const rootPrefix = toGlobPath(context.workspaceRoot);
    const relative = files
      .map((f) => f.replace(rootPrefix + '/', '').replace(rootPrefix, ''))
      .sort()
      .join('\n');

    return { success: true, output: relative || '(empty directory)' };
  }
}
