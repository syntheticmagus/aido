import pino from 'pino';
import { EventEmitter } from 'node:events';

// Module-level event bus: lets ws.ts forward log lines to the browser
// without creating circular dependencies into the server layer.
export const logBus = new EventEmitter();
logBus.setMaxListeners(50);

const transport =
  process.env['NODE_ENV'] !== 'production'
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
      }
    : undefined;

export const logger = pino(
  {
    level: process.env['LOG_LEVEL'] ?? 'info',
  },
  transport ? pino.transport(transport) : undefined,
);

// Wrap logger to also emit on logBus for Socket.IO forwarding.
const originalChild = logger.child.bind(logger);
// Re-export a patched child factory — modules should call logger.child()
// and get a logger whose output also flows through logBus.
// For simplicity in Phase 1, we emit from the root logger via a proxy.

// Hook: any external listener can subscribe to structured log events.
// Usage in ws.ts: logBus.on('log', (entry) => io.emit('log', entry));
function emitLog(
  level: string,
  msg: string,
  bindings: Record<string, unknown>,
): void {
  logBus.emit('log', { level, msg, time: Date.now(), ...bindings });
}

export function createLogger(bindings: Record<string, unknown>) {
  const child = originalChild(bindings);
  // Wrap the four main methods to also emit on logBus.
  const wrap =
    (level: string, orig: (...args: unknown[]) => void) =>
    (msgOrObj: unknown, ...rest: unknown[]) => {
      orig.call(child, msgOrObj, ...rest);
      const msg =
        typeof msgOrObj === 'string'
          ? msgOrObj
          : (rest[0] as string | undefined) ?? '';
      emitLog(level, msg, bindings);
    };
  child.info = wrap('info', child.info.bind(child)) as typeof child.info;
  child.warn = wrap('warn', child.warn.bind(child)) as typeof child.warn;
  child.error = wrap('error', child.error.bind(child)) as typeof child.error;
  child.debug = wrap('debug', child.debug.bind(child)) as typeof child.debug;
  return child;
}
