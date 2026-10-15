/**
 * ユーザー操作の検知。
 * AI が操作している最中にユーザーがマウスやキーボードを使った場合、即座にタスクを一時停止して
 * ユーザーに制御を戻す (システムの最終入力時刻と Gumi 自身の入力注入時刻を比較)。
 * Windows: GetLastInputInfo / macOS: CGEventSourceSecondsSinceLastEventType
 */
import type { InputDriver } from '../../src/services/automation/types';

export interface UserActivityDeps {
  input: InputDriver;
  /** 監視が必要な状態か (AI が思考中・操作中) */
  shouldWatch: () => boolean;
  /** カーソルが Gumi の上にある / Gumi の入力欄に入力中なら Gumi への操作とみなして除外 */
  isGumiInteraction: () => boolean;
  onUserInput: () => void;
}

/** 時計の分解能による誤差 (ms) */
const JITTER_MS = 60;
/** 注入した入力がシステムに反映されるまでの猶予 (ms) */
const INJECTION_GRACE_MS = 300;

export class UserActivityMonitor {
  private timer: NodeJS.Timeout | null = null;
  private baseline: number | null = null;

  constructor(private readonly deps: UserActivityDeps) {}

  start(): void {
    this.timer = setInterval(() => this.check(), 150);
  }

  private check(): void {
    const { input } = this.deps;
    if (!this.deps.shouldWatch()) {
      this.baseline = null;
      return;
    }
    if (input.injecting) return;
    let lastInputAt: number;
    try {
      lastInputAt = Date.now() - input.msSinceLastInput();
    } catch {
      return;
    }
    if (this.baseline === null) {
      // 監視開始時点までの入力 (承認ボタンのクリックなど) は無視する
      this.baseline = lastInputAt;
      return;
    }
    const threshold = Math.max(this.baseline + JITTER_MS, input.lastInjectionAt + INJECTION_GRACE_MS);
    if (lastInputAt > threshold) {
      this.baseline = lastInputAt;
      if (this.deps.isGumiInteraction()) return;
      this.deps.onUserInput();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
