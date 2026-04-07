import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import { createLogger } from '../utils/logger.js';

const log = createLogger({ module: 'workspace-watcher' });

export class WorkspaceWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;

  watch(projectRoot: string): void {
    if (this.watcher) {
      void this.watcher.close();
    }

    this.watcher = chokidar.watch(projectRoot, {
      ignored: [
        path.join(projectRoot, '.git', '**'),
        path.join(projectRoot, '.aido', '**'),
      ],
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    const emit = (type: 'add' | 'change' | 'unlink') => (filePath: string) => {
      const relPath = filePath.replace(projectRoot + path.sep, '').replace(/\\/g, '/');
      log.debug({ type, path: relPath }, 'Workspace change');
      this.emit('changed', { type, path: relPath });
    };

    this.watcher.on('add', emit('add'));
    this.watcher.on('change', emit('change'));
    this.watcher.on('unlink', emit('unlink'));

    log.info({ projectRoot }, 'Workspace watcher started');
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
  }
}
