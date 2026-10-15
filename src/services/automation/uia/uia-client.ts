/**
 * Windows UI Automation クライアント。
 *
 * .NET の System.Windows.Automation を利用するため、常駐 PowerShell プロセス (uia-host.ps1) と
 * JSON Lines でやり取りする。プロセスは初回利用時に起動し、以降は使い回す
 * (UI Automation の COM API を Node.js から直接扱うためのネイティブ依存を避けるための唯一の外部プロセス)。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import hostScript from './uia-host.ps1';
import type { Rect } from '../../../types/character';
import type { StartApp, UiDriver, UiElement, UiTree } from '../types';

export type { UiElement, UiTree };

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class UiaClient implements UiDriver {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private starting: Promise<void> | null = null;
  private scriptPath: string;
  stderrTail = '';

  constructor(workDir = path.join(os.tmpdir(), 'gumi')) {
    this.scriptPath = path.join(workDir, 'uia-host.ps1');
  }

  private async ensureStarted(): Promise<void> {
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      mkdirSync(path.dirname(this.scriptPath), { recursive: true });
      // UTF-8 BOM 付きで保存 (Windows PowerShell 5.1 が日本語を正しく解釈するため)
      writeFileSync(this.scriptPath, '﻿' + hostScript, 'utf8');
      const proc = spawn(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => this.onData(chunk));
      proc.stderr.on('data', (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-2000);
      });
      proc.on('exit', () => {
        this.proc = null;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`UI Automation ホストが終了しました ${this.stderrTail.slice(-300)}`));
        }
        this.pending.clear();
      });
      proc.on('error', (err) => {
        this.stderrTail += String(err);
      });
      this.proc = proc;
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: { id: number | null; ok: boolean; result?: unknown; error?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id === null || msg.id === undefined) continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? 'UI Automation エラー'));
    }
  }

  async request<T>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 15000): Promise<T> {
    await this.ensureStarted();
    const proc = this.proc;
    if (!proc) throw new Error('UI Automation ホストを起動できませんでした');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`UI Automation の応答がタイムアウトしました (${cmd})`));
        // 応答しないホストは再起動する
        this.dispose();
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  async ping(): Promise<{ pong: boolean; dpiAware: boolean; psVersion: string }> {
    // 初回は .NET アセンブリ読み込みに時間がかかる
    return this.request('ping', {}, 30000);
  }

  async listElements(opts: {
    hwnd?: number;
    maxCount?: number;
    maxDepth?: number;
    interactiveOnly?: boolean;
    budgetMs?: number;
  }): Promise<UiTree> {
    const tree = await this.request<UiTree>('list', opts, 30000);
    return { ...tree, elements: toArray(tree.elements) };
  }

  async elementAt(x: number, y: number): Promise<UiElement | null> {
    return this.request('at', { x, y });
  }

  async focusedElement(): Promise<UiElement | null> {
    return this.request('focused');
  }

  /** 要素の既定アクションを実行する。対応パターンが無ければ null を返す (呼び出し側でクリックにフォールバック) */
  async invoke(elementId: number): Promise<string | null> {
    try {
      return await this.request<string>('invoke', { elementId });
    } catch (err) {
      if ((err as Error).message.includes('NO_PATTERN')) return null;
      throw err;
    }
  }

  async setValue(elementId: number, value: string): Promise<void> {
    await this.request('setValue', { elementId, value });
  }

  async focus(elementId: number): Promise<void> {
    await this.request('focus', { elementId });
  }

  async rect(elementId: number): Promise<Rect> {
    return this.request('rect', { elementId });
  }

  async startApps(): Promise<StartApp[]> {
    const r = await this.request<unknown>('startApps', {}, 30000);
    return toArray(r as StartApp[]);
  }

  dispose() {
    if (this.proc) {
      try {
        this.proc.stdin.end();
        this.proc.kill();
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
  }
}

function toArray<T>(v: T[] | T | null | undefined): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
