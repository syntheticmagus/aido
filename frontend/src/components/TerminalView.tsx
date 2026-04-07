import { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { useAppStore } from '../stores/appStore.ts';

interface TerminalViewProps {
  agentId: string;
}

export function TerminalView({ agentId }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  // Track how many chunks have been written to avoid re-writing on re-renders
  const writtenCountRef = useRef(0);

  const outputs = useAppStore((s) => s.agentOutputs[agentId] ?? []);

  // Initialize xterm on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: {
        background: '#030712',
        foreground: '#d1d5db',
        cursor: '#9ca3af',
      },
      fontFamily: 'monospace',
      fontSize: 12,
      convertEol: true,
      scrollback: 2000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    writtenCountRef.current = 0;

    const observer = new ResizeObserver(() => fitAddon.fit());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [agentId]); // reinit when switching agents

  // Write new chunks directly to xterm — NOT through React state
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const newChunks = outputs.slice(writtenCountRef.current);
    for (const chunk of newChunks) {
      term.write(chunk);
    }
    writtenCountRef.current = outputs.length;
  }, [outputs.length, outputs]); // length change triggers this

  return (
    <div
      ref={containerRef}
      className="w-full h-64 bg-gray-950 rounded-lg overflow-hidden"
    />
  );
}
