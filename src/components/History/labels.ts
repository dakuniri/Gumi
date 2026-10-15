import type { LogKind } from '../../types/agent';

/** ログ種別の短いラベル (絵文字は使わない) */
export const LOG_LABELS: Record<LogKind, string> = {
  user: 'あなた',
  assistant: 'Gumi',
  action: '操作',
  result: '結果',
  error: 'エラー',
  system: '情報',
  approval: '承認',
};

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
