/**
 * 同じ操作の無限ループや連続失敗を検出する (純粋ロジック)。
 */
export interface GuardConfig {
  /** 連続失敗をこの回数許したら AI に方針転換を促す */
  maxActionRetries: number;
  /** false の場合、操作が 1 回失敗した時点で停止する */
  autoRetry: boolean;
}

export type GuardVerdict =
  | { kind: 'ok' }
  | { kind: 'warn'; message: string }
  | { kind: 'abort'; reason: string };

export class LoopGuard {
  private lastSignature: string | null = null;
  private sameNoChange = 0;
  private consecutiveErrors = 0;
  private totalErrors = 0;

  constructor(private readonly cfg: GuardConfig) {}

  static signature(name: string, args: unknown): string {
    return `${name}:${stableStringify(args)}`;
  }

  /**
   * 操作結果を記録して判定する。
   * @param screenChanged 画面変化 (null = 判定不能)
   */
  record(name: string, args: unknown, outcome: { isError: boolean; screenChanged?: boolean | null }): GuardVerdict {
    const sig = LoopGuard.signature(name, args);

    if (outcome.isError) {
      this.consecutiveErrors++;
      this.totalErrors++;
      if (!this.cfg.autoRetry) {
        return { kind: 'abort', reason: '操作が失敗しました (自動再試行は無効に設定されています)' };
      }
      if (this.consecutiveErrors > this.cfg.maxActionRetries * 2) {
        return { kind: 'abort', reason: `操作が ${this.consecutiveErrors} 回連続で失敗したため停止しました` };
      }
      if (this.consecutiveErrors >= this.cfg.maxActionRetries) {
        return {
          kind: 'warn',
          message: `Warning: ${this.consecutiveErrors} consecutive failures. Stop and rethink: take a screenshot, check which window is focused, try a different method, or ask_user.`,
        };
      }
    } else {
      this.consecutiveErrors = 0;
    }

    if (sig === this.lastSignature && outcome.screenChanged === false) this.sameNoChange++;
    else this.sameNoChange = outcome.screenChanged === false ? 1 : 0;
    this.lastSignature = sig;

    if (this.sameNoChange >= 5) {
      return { kind: 'abort', reason: '同じ操作を繰り返しても画面が変化しないため停止しました' };
    }
    if (this.sameNoChange >= 3) {
      return {
        kind: 'warn',
        message: `Warning: you repeated the same action ${this.sameNoChange} times with no visible change. Do not repeat it again. Re-examine the screen and use a different approach.`,
      };
    }
    return { kind: 'ok' };
  }

  get errors(): number {
    return this.totalErrors;
  }
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}
