import { useEffect, useRef } from 'react';
import type { LogEntry, LogKind } from '../../types/agent';
import { LOG_LABELS, formatTime } from './labels';
import './history.css';

const CONVERSATION: LogKind[] = ['user', 'assistant', 'system', 'error'];
const OPERATIONS: LogKind[] = ['action', 'result', 'approval', 'error'];

export function LogView({ logs, mode, empty }: { logs: LogEntry[]; mode: 'conversation' | 'operations'; empty: string }) {
  const kinds = mode === 'conversation' ? CONVERSATION : OPERATIONS;
  const items = logs.filter((l) => kinds.includes(l.kind));
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [items.length]);

  if (items.length === 0) return <div className="empty">{empty}</div>;
  return (
    <ol className={`log log--${mode}`}>
      {items.map((l) => (
        <li key={l.id} className={`log-item log-${l.kind} ${l.ok === false ? 'failed' : ''}`}>
          <span className="log-icon">{LOG_LABELS[l.kind]}</span>
          <span className="log-text">{l.text}</span>
          <time className="log-time">{formatTime(l.ts)}</time>
        </li>
      ))}
      <div ref={endRef} />
    </ol>
  );
}
