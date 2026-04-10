import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createLogger } from '../utils/logger.js';
import type { ModelsConfig } from '../config/schema.js';

const log = createLogger({ module: 'workspace' });

function runGit(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, stdio: 'pipe' });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(' ')} failed with code ${code}`));
    });
    proc.on('error', reject);
  });
}

export class WorkspaceManager {
  constructor(private readonly rootDir: string) {}

  getProjectRoot(projectName: string): string {
    return path.join(this.rootDir, projectName);
  }

  async initProject(
    projectName: string,
    specContent: string,
    modelsConfig: ModelsConfig,
  ): Promise<string> {
    const projectRoot = this.getProjectRoot(projectName);
    const aidoDir = path.join(projectRoot, '.aido');

    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(path.join(aidoDir, 'agents'), { recursive: true });

    // Write spec and config
    await fs.writeFile(path.join(aidoDir, 'spec.md'), specContent, 'utf-8');
    await fs.writeFile(
      path.join(aidoDir, 'models.json'),
      JSON.stringify(modelsConfig, null, 2),
      'utf-8',
    );

    // Create .gitignore that excludes .aido/
    await fs.writeFile(
      path.join(projectRoot, '.gitignore'),
      '.aido/\nnode_modules/\n',
      'utf-8',
    );

    // Init git repo
    try {
      await runGit(['init'], projectRoot);
      await runGit(['config', 'user.email', 'aido@localhost'], projectRoot);
      await runGit(['config', 'user.name', 'AIDO'], projectRoot);
      log.info({ projectName }, 'Initialized git repository');
    } catch (err) {
      log.warn({ err }, 'git init failed — workspace will not be version controlled');
    }

    await this.ensureClaudeCodeDirs(projectName);

    log.info({ projectName, projectRoot }, 'Project workspace initialized');
    return projectRoot;
  }

  async ensureClaudeCodeDirs(projectName: string): Promise<void> {
    const base = path.join(this.getProjectRoot(projectName), '.aido', 'claude-code');
    await fs.mkdir(path.join(base, 'inbox'), { recursive: true });
    await fs.mkdir(path.join(base, 'outbox'), { recursive: true });
    await fs.mkdir(path.join(base, 'signals'), { recursive: true });
  }

  async listArtifacts(projectName: string): Promise<string[]> {
    const fg = (await import('fast-glob')).default;
    const root = this.getProjectRoot(projectName);
    const globRoot = root.replace(/\\/g, '/');
    const files = await fg(`${globRoot}/**/*`, {
      onlyFiles: true,
      ignore: [`${globRoot}/.aido/**`, `${globRoot}/.git/**`],
    });
    return files.map((f) => f.replace(globRoot + '/', ''));
  }

  async projectExists(projectName: string): Promise<boolean> {
    try {
      await fs.access(this.getProjectRoot(projectName));
      return true;
    } catch {
      return false;
    }
  }
}
