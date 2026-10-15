/**
 * 操作の権限制御 (純粋関数)。
 *
 * 判定順:
 *  1. カテゴリが deny → 拒否
 *  2. カテゴリが ask → 承認を求める
 *  3. 高リスク操作 (削除・上書き・確認依頼・シェル起動など) → 常に承認を求める
 *  4. 確認ポリシーのしきい値以上のリスク → 承認を求める
 *  5. それ以外 → 許可
 * タスク中に「このタスクでは許可」された操作は、高リスクでなければ以後確認しない。
 */
import type { PermissionCategory, PermissionMode, Settings } from '../settings/schema';
import type { RiskLevel } from '../../types/agent';
import type { RiskAssessment, ToolDefinition } from './tools';

export type PermissionDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason: string; risk: RiskLevel; rememberable: boolean };

const RANK: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3 };

export function riskAtLeast(a: RiskLevel, b: RiskLevel): boolean {
  return RANK[a] >= RANK[b];
}

export function policyThreshold(policy: Settings['confirmPolicy']): RiskLevel {
  switch (policy) {
    case 'every':
      return 'low';
    case 'medium':
      return 'medium';
    default:
      return 'high';
  }
}

export interface PermissionContext {
  permissions: Record<PermissionCategory, PermissionMode>;
  confirmPolicy: Settings['confirmPolicy'];
  /** このタスクでユーザーが一括許可したツール名 */
  approvedForTask: Set<string>;
}

export function decidePermission(
  tool: ToolDefinition,
  risk: RiskAssessment,
  ctx: PermissionContext,
): PermissionDecision {
  if (tool.category === 'control') {
    if (tool.name === 'request_confirmation') {
      return { kind: 'ask', reason: risk.reason ?? 'AI が確認を求めています', risk: 'high', rememberable: false };
    }
    return { kind: 'allow' };
  }

  const categories: PermissionCategory[] = [];
  if (tool.category !== 'none') categories.push(tool.category);
  if (tool.extraCategories) categories.push(...tool.extraCategories);

  for (const c of categories) {
    if (ctx.permissions[c] === 'deny') {
      return { kind: 'deny', reason: `「${c}」の操作は設定で禁止されています` };
    }
  }

  const alwaysAsk = categories.some((c) => ctx.permissions[c] === 'ask');
  const high = risk.level === 'high';
  const rememberable = !high && tool.category !== 'fileDelete';

  if (rememberable && ctx.approvedForTask.has(tool.name)) return { kind: 'allow' };

  if (alwaysAsk) {
    return { kind: 'ask', reason: risk.reason ?? '設定で確認が必要な操作です', risk: maxRisk(risk.level, 'low'), rememberable };
  }
  if (high) {
    return { kind: 'ask', reason: risk.reason ?? '影響の大きい操作です', risk: 'high', rememberable: false };
  }
  if (risk.level !== 'none' && riskAtLeast(risk.level, policyThreshold(ctx.confirmPolicy))) {
    return { kind: 'ask', reason: risk.reason ?? '確認ポリシーにより確認が必要です', risk: risk.level, rememberable };
  }
  return { kind: 'allow' };
}

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RANK[a] >= RANK[b] ? a : b;
}
