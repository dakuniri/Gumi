/**
 * クリックの予約 (「N 秒後にここをクリック」)。
 *
 * - 予約はタスクの一部。予約が残っている間はタスクを終わらせず、停止されたらすべて取り消す
 * - 一時停止中に予定時刻が来た場合は、再開されるまで待ってから実行する
 * - AI 自身の操作と同時に入力しないよう、実行は共通のロックで直列化する
 */
import type { Point } from '../../types/character';
import type { ScheduledClickInfo } from '../../types/agent';
import type { MouseButton } from '../automation/win32/input';
import { isAbortError } from '../automation/util';

export const MAX_SCHEDULED = 10;
export const MAX_DELAY_SEC = 3600;

export interface ScheduledClick {
  id: number;
  at: number;
  /** 物理座標 (予約時点で変換済み) */
  point: Point;
  /** AI が指定した画像座標 (報告用) */
  imagePoint: Point;
  button: MouseButton;
  clicks: number;
  label: string;
}

/** 非同期処理を 1 つずつ実行するロック */
export class Mutex {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export interface SchedulerDeps {
  /** 予約時刻に呼ばれる。クリックを実行して結果の説明を返す */
  run: (c: ScheduledClick, signal: AbortSignal) => Promise<string>;
  /** 一時停止中なら再開まで待つ。停止されていれば例外 */
  checkpoint: () => Promise<void>;
  signal: AbortSignal;
  onChange: (list: ScheduledClickInfo[]) => void;
  onDone: (c: ScheduledClick, ok: boolean, message: string) => void;
  now?: () => number;
}

export class ClickScheduler {
  private items = new Map<number, { c: ScheduledClick; timer: ReturnType<typeof setTimeout> | null }>();
  private running = 0;
  private nextId = 1;
  private waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];

  constructor(private readonly deps: SchedulerDeps) {
    deps.signal.addEventListener('abort', () => this.cancelAll(), { once: true });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  add(input: Omit<ScheduledClick, 'id' | 'at'> & { delaySec: number }): ScheduledClick {
    if (this.deps.signal.aborted) throw new Error('タスクは停止されています');
    if (this.items.size >= MAX_SCHEDULED) throw new Error(`予約できるのは同時に ${MAX_SCHEDULED} 件までです`);
    const delay = Math.min(MAX_DELAY_SEC, Math.max(0.5, input.delaySec));
    const c: ScheduledClick = {
      id: this.nextId++,
      at: this.now() + Math.round(delay * 1000),
      point: input.point,
      imagePoint: input.imagePoint,
      button: input.button,
      clicks: input.clicks,
      label: input.label,
    };
    const timer = setTimeout(() => void this.fire(c.id), Math.round(delay * 1000));
    this.items.set(c.id, { c, timer });
    this.changed();
    return c;
  }

  private async fire(id: number) {
    const item = this.items.get(id);
    if (!item) return;
    item.timer = null;
    this.running++;
    try {
      await this.deps.checkpoint();
      if (this.deps.signal.aborted || !this.items.has(id)) return;
      const msg = await this.deps.run(item.c, this.deps.signal);
      this.deps.onDone(item.c, true, msg);
    } catch (err) {
      if (!isAbortError(err) && !this.deps.signal.aborted) this.deps.onDone(item.c, false, (err as Error).message);
    } finally {
      this.running--;
      this.items.delete(id);
      this.changed();
    }
  }

  cancel(id: number): boolean {
    const item = this.items.get(id);
    if (!item || item.timer === null) return false; // 実行中のものは取り消せない
    clearTimeout(item.timer);
    this.items.delete(id);
    this.changed();
    return true;
  }

  cancelAll(): void {
    for (const item of this.items.values()) if (item.timer) clearTimeout(item.timer);
    this.items.clear();
    this.changed();
  }

  list(): ScheduledClick[] {
    return [...this.items.values()].map((i) => i.c).sort((a, b) => a.at - b.at);
  }

  get pending(): number {
    return this.items.size;
  }

  /** すべての予約が終わるまで待つ (停止されたら例外) */
  waitAll(): Promise<void> {
    if (this.items.size === 0 && this.running === 0) return Promise.resolve();
    if (this.deps.signal.aborted) return Promise.reject(new Error('aborted'));
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.deps.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), {
        once: true,
      });
    });
  }

  private changed() {
    this.deps.onChange(this.list().map((c) => ({ id: c.id, at: c.at, label: c.label })));
    if (this.items.size === 0 && this.running === 0) {
      const w = this.waiters;
      this.waiters = [];
      // 停止による取り消しで空になった場合は「完了」ではなく中断として扱う
      if (this.deps.signal.aborted) {
        w.forEach((x) => x.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      } else {
        w.forEach((x) => x.resolve());
      }
    }
  }
}
