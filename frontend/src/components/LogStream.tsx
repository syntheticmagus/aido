import { useState, useRef, useEffect } from 'react';
import { useAppStore } from '../stores/appStore.ts';
import type { LogEntry } from '../types/index.ts';

// Pino sends levels as numbers in production (10=trace,20=debug,30=info,40=warn,50=error,60=fatal)
const LEVEL_COLORS: Record<string, string> = {
  debug: 'text-gray-500',  '20': 'text-gray-500',
  info:  'text-blue-400',  '30': 'text-blue-400',
  warn:  'text-yellow-400','40': 'text-yellow-400',
  error: 'text-red-400',   '50': 'text-red-400',
  fatal: 'text-red-300',   '60': 'text-red-300',
};

const LEVEL_LABELS: Record<string, string> = {
  '10': 'trace', '20': 'debug', '30': 'info',
  '40': 'warn',  '50': 'error', '60': 'fatal',
};

export function LogStream() {
  const logs = useAppStore((s) => s.logs);
  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState<string>('');
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs.length, autoScroll]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 50;
    setAutoScroll(atBottom);
  };

  const filtered = logs.filter((entry) => {
    if (levelFilter) {
      const label = LEVEL_LABELS[String(entry.level)] ?? String(entry.level);
      if (label !== levelFilter) return false;
    }
    if (filter && !String(entry.msg ?? '').toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-2">
        <select
          className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300"
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value)}
        >
          <option value="">All levels</option>
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <input
          className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
          placeholder="Filter messages..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto font-mono text-xs space-y-0.5"
        onScroll={handleScroll}
      >
        {filtered.map((entry, i) => (
          <LogLine key={i} entry={entry} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  const levelKey = String(entry.level ?? '');
  const levelColor = LEVEL_COLORS[levelKey] ?? 'text-gray-400';
  const levelLabel = LEVEL_LABELS[levelKey] ?? levelKey;
  const time = new Date(typeof entry.time === 'number' ? entry.time : Date.now()).toLocaleTimeString();
  const msg = entry.msg != null && typeof entry.msg !== 'object' ? String(entry.msg) : JSON.stringify(entry.msg);
  return (
    <div className="flex items-start gap-2 hover:bg-gray-900 px-1 rounded">
      <span className="text-gray-600 shrink-0">{time}</span>
      <span className={`${levelColor} shrink-0 w-10`}>{levelLabel}</span>
      <span className="text-gray-300 break-all">{msg}</span>
    </div>
  );
}
