/**
 * アクセシビリティ ワーカー (ax-worker) のクライアント (macOS, Main Process 側)。
 * UI 要素の取得・操作 (UiDriver) と、AX によるウィンドウ操作を非同期で提供する。
 * ワーカーが応答しなくなったら作り直す。
 */
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import type { AxOp, WindowRef } from './ax-core';
import type { StartApp, UiDriver, UiElement, UiTree, WindowAction } from '../types';
import type { Rect } from '../../../types/character';

declare const __AX_WORKER_CODE__: string;

/** ビルド時に埋め込まれるワーカーのコード */
function workerCode(): string {
  const code = typeof __AX_WORKER_CODE__ === 'string' ? __AX_WORKER_CODE__ : '';
  if (!code) throw new Error('アクセシビリティ ワーカーが同梱されていません (ビルドを確認してください)');
  return code;
}

/** koffi の場所 (asar 内なら展開済みの app.asar.unpacked を使う) */
function koffiPath(): string {
  const req = createRequire(__filename);
  return req.resolve('koffi').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

interface Pending {
  worker: Worker;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class AxClient {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(workerCode(), { eval: true, workerData: { koffiPath: koffiPath() } });
    w.on('message', (m: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error ?? 'アクセシビリティ API の呼び出しに失敗しました'));
    });
    const fail = (err: Error) => {
      if (this.worker === w) this.worker = null;
      // このワーカーに送った要求だけを失敗にする (作り直した後の要求は残す)
      for (const [id, p] of this.pending) {
        if (p.worker !== w) continue;
        clearTimeout(p.timer);
        p.reject(err);
        this.pending.delete(id);
      }
    };
    w.on('error', (err) => fail(err));
    w.on('exit', (code) => fail(new Error(`アクセシビリティ ワーカーが終了しました (code ${code})`)));
    w.unref();
    this.worker = w;
    return w;
  }

  call<T>(op: AxOp, args: unknown = {}, timeoutMs = 8000): Promise<T> {
    const w = this.ensure();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 応答の無いアプリで止まっている可能性があるので、ワーカーごと作り直す
        if (this.worker === w) this.worker = null;
        void w.terminate();
        reject(new Error('アプリが応答しないため UI 要素を取得できませんでした'));
      }, timeoutMs);
      this.pending.set(id, { worker: w, resolve: resolve as (v: unknown) => void, reject, timer });
      w.postMessage({ id, op, args });
    });
  }

  dispose(): void {
    void this.worker?.terminate();
    this.worker = null;
  }

  // ---- ウィンドウ ----
  focusWindow(ref: WindowRef): Promise<boolean> {
    return this.call('focusWindow', { ref }, 5000);
  }

  windowAction(ref: WindowRef, action: WindowAction): Promise<void> {
    return this.call('windowAction', { ref, action }, 5000);
  }

  setBounds(ref: WindowRef, bounds: { x: number; y: number; width?: number; height?: number }): Promise<void> {
    return this.call('setBounds', { ref, bounds }, 5000);
  }

  activateApp(pid: number): Promise<boolean> {
    return this.call('activateApp', { pid }, 3000);
  }

  frontmostPid(): Promise<number | null> {
    return this.call('frontmostPid', {}, 3000);
  }
}

/** UiDriver (get_ui_elements など) の macOS 実装 */
export class MacUiDriver implements UiDriver {
  constructor(
    private readonly ax: AxClient,
    /** CGWindowID からウィンドウ情報 (pid / 位置 / タイトル) を引く */
    private readonly windowRef: (windowId: number | undefined) => WindowRef | null,
    private readonly apps: () => Promise<StartApp[]>,
  ) {}

  async ping(): Promise<Record<string, unknown>> {
    return this.ax.call('ping', {}, 5000);
  }

  async listElements(opts: {
    hwnd?: number;
    maxCount?: number;
    maxDepth?: number;
    interactiveOnly?: boolean;
    budgetMs?: number;
  }): Promise<UiTree> {
    const ref = this.windowRef(opts.hwnd);
    if (!ref) throw new Error('No active application window. Focus a window first.');
    const budgetMs = opts.budgetMs ?? 5000;
    return this.ax.call(
      'list',
      { ref, opts: { maxCount: opts.maxCount, maxDepth: opts.maxDepth, interactiveOnly: opts.interactiveOnly, budgetMs } },
      budgetMs + 5000,
    );
  }

  elementAt(x: number, y: number): Promise<UiElement | null> {
    return this.ax.call('at', { x, y });
  }

  focusedElement(): Promise<UiElement | null> {
    return this.ax.call('focused');
  }

  invoke(elementId: number): Promise<string | null> {
    return this.ax.call('invoke', { id: elementId });
  }

  setValue(elementId: number, value: string): Promise<void> {
    return this.ax.call('setValue', { id: elementId, value });
  }

  focus(elementId: number): Promise<void> {
    return this.ax.call('focus', { id: elementId });
  }

  rect(elementId: number): Promise<Rect> {
    return this.ax.call('rect', { id: elementId });
  }

  startApps(): Promise<StartApp[]> {
    return this.apps();
  }

  dispose(): void {
    this.ax.dispose();
  }
}
