/**
 * Gumi の円の状態表現の一元決定 (純粋関数)。
 * AI の状態・円の状態・一時的なリアクションから、優先度順に「ただ 1 つ」の状態を決める。
 * 矛盾した表現が同時に発生しないよう、状態はこの関数以外では決めない。
 */
import type { AgentPhase } from '../../types/agent';
import type { ExpressionName, ReactionKind } from '../../types/character';

export interface ExpressionInputs {
  phase: AgentPhase;
  /** 実行中のツール (web_search なら検索中の表示) */
  currentTool?: string | null;
  pendingApproval: boolean;
  pendingQuestion: boolean;
  sleeping: boolean;
  waking: boolean;
  hover: boolean;
  dragging: boolean;
  /** 円の横の入力欄が開いている (ユーザーの入力待ち) */
  inputOpen: boolean;
  idle: boolean;
  /** タスク終了時などの一時的なリアクション */
  reaction: ReactionKind | null;
}

export function resolveExpression(i: ExpressionInputs): ExpressionName {
  if (i.dragging) return 'drag';
  if (i.reaction === 'error') return 'error';
  if (i.pendingApproval || i.pendingQuestion) return 'waiting';
  if ((i.phase === 'thinking' || i.phase === 'acting') && i.currentTool === 'web_search') return 'searching';
  switch (i.phase) {
    case 'acting':
      return 'working';
    case 'thinking':
      return 'thinking';
    case 'awaiting-approval':
    case 'awaiting-input':
    case 'paused':
      return 'waiting';
    default:
      break;
  }
  if (i.reaction === 'success') return 'success';
  if (i.reaction === 'failure') return 'failure';
  if (i.waking) return 'waking';
  if (i.sleeping) return 'sleep';
  if (i.inputOpen) return 'waiting';
  if (i.hover) return 'hover';
  if (i.idle) return 'idle';
  return 'normal';
}

/** タスク終了フェーズに対応するリアクション */
export function reactionForPhase(prev: AgentPhase, next: AgentPhase, error: boolean): ReactionKind | null {
  if (prev === next) return null;
  if (next === 'completed') return 'success';
  if (next === 'failed') return error ? 'error' : 'failure';
  return null;
}

export const REACTION_DURATION_MS: Record<ReactionKind, number> = {
  success: 6000,
  failure: 4200,
  error: 3000,
};
