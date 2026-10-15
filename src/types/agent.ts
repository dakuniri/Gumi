import type { PermissionCategory } from '../services/settings/schema';

export type RiskLevel = 'none' | 'low' | 'medium' | 'high';

export type AgentPhase =
  | 'idle'
  | 'thinking'
  | 'acting'
  | 'awaiting-approval'
  | 'awaiting-input'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'stopped';

export interface PendingApproval {
  id: string;
  tool: string;
  category: PermissionCategory | 'control';
  risk: RiskLevel;
  description: string;
  details: string;
  reason: string;
}

export interface PendingQuestion {
  id: string;
  question: string;
}

export interface ScheduledClickInfo {
  id: number;
  /** 実行予定時刻 (Date.now 基準) */
  at: number;
  label: string;
}

export interface AgentTaskInfo {
  id: string;
  text: string;
  startedAt: number;
}

export interface AgentStatus {
  phase: AgentPhase;
  task: AgentTaskInfo | null;
  step: number;
  maxSteps: number;
  /** 現在実行中 / 直近の操作の説明 */
  currentAction: string | null;
  /** 直近の操作結果 */
  lastResult: string | null;
  /** 最後のエラー */
  error: string | null;
  /** 最終報告 */
  summary: string | null;
  pendingApproval: PendingApproval | null;
  pendingQuestion: PendingQuestion | null;
  /** 実行中のツール名 (検索中の表示などに使う) */
  currentTool: string | null;
  /** 予約されたクリック */
  scheduled: ScheduledClickInfo[];
  /** 一時停止の理由 (ユーザー操作検知など) */
  pauseReason: string | null;
  /** 現在 AI API に画面画像を送信しているか */
  sendingScreenshot: boolean;
  provider: { id: string; label: string; model: string; vision: boolean; tools: boolean } | null;
  /** 直近に API へ送信した内容の要約 (送信情報の明示) */
  lastTransmission: string | null;
}

export type LogKind = 'user' | 'assistant' | 'action' | 'result' | 'error' | 'system' | 'approval';

export interface LogEntry {
  id: string;
  taskId: string;
  ts: number;
  kind: LogKind;
  text: string;
  tool?: string;
  risk?: RiskLevel;
  ok?: boolean;
}

export type TaskOutcome = 'running' | 'completed' | 'failed' | 'stopped';

export interface TaskRecord {
  id: string;
  text: string;
  status: TaskOutcome;
  startedAt: number;
  endedAt: number | null;
  provider: string;
  model: string;
  steps: number;
  summary: string | null;
  log: LogEntry[];
}

export type TaskSummary = Omit<TaskRecord, 'log'> & { logCount: number };

export function idleStatus(): AgentStatus {
  return {
    phase: 'idle',
    task: null,
    step: 0,
    maxSteps: 0,
    currentAction: null,
    lastResult: null,
    error: null,
    summary: null,
    pendingApproval: null,
    pendingQuestion: null,
    currentTool: null,
    scheduled: [],
    pauseReason: null,
    sendingScreenshot: false,
    provider: null,
    lastTransmission: null,
  };
}

export function isBusyPhase(phase: AgentPhase): boolean {
  return (
    phase === 'thinking' ||
    phase === 'acting' ||
    phase === 'awaiting-approval' ||
    phase === 'awaiting-input' ||
    phase === 'paused'
  );
}
