/**
 * タスク状態管理。
 * - タスクの開始 / 一時停止 / 再開 / 即時停止
 * - 承認待ち・質問待ちの管理
 * - 状態とログを UI へ通知し、履歴へ保存
 * - 停止時は押下中のキー・マウスボタンを必ず解放する
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Settings } from '../settings/schema';
import { PROVIDER_LABELS } from '../settings/schema';
import {
  idleStatus,
  isBusyPhase,
  type AgentPhase,
  type AgentStatus,
  type LogEntry,
  type LogKind,
  type PendingApproval,
  type RiskLevel,
} from '../../types/agent';
import type { ProviderConfig } from '../ai/types';
import { validateConfig } from '../ai/factory';
import { runAgent, type AgentDeps, type AgentHost, type AgentRunInput, type ApprovalAnswer } from '../agent/agent';
import { AbortedError } from '../automation/util';
import type { HistoryStore } from './history-store';

export interface TaskManagerDeps {
  settings: () => Settings;
  providerConfig: () => ProviderConfig;
  agentDeps: AgentDeps;
  environment: () => AgentRunInput['environment'];
  history: HistoryStore;
  /** 押下中の入力を解放する */
  releaseInput: () => { keys: number; buttons: number };
}

interface Waiter<T> {
  id: string;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}

export class TaskManager extends EventEmitter {
  private status: AgentStatus = idleStatus();
  private abort: AbortController | null = null;
  private paused = false;
  private phaseBeforePause: AgentPhase = 'thinking';
  private resumeWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private approval: Waiter<ApprovalAnswer> | null = null;
  private question: Waiter<string> | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: TaskManagerDeps) {
    super();
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  private update(patch: Partial<AgentStatus>) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  private log(kind: LogKind, text: string, extra: { tool?: string; risk?: RiskLevel; ok?: boolean } = {}) {
    const taskId = this.status.task?.id;
    if (!taskId) return;
    const entry: LogEntry = { id: randomUUID(), taskId, ts: Date.now(), kind, text, ...extra };
    this.deps.history.append(taskId, entry);
    this.emit('log', entry);
  }

  /** タスクを開始する。設定不備や実行中の場合は例外を投げる。 */
  start(text: string): { taskId: string } {
    const task = text.trim();
    if (!task) throw new Error('指示を入力してください');
    if (task.length > 8000) throw new Error('指示が長すぎます (8000 文字まで)');
    if (this.running) throw new Error('別のタスクを実行中です。停止してから開始してください。');
    const config = this.deps.providerConfig();
    const invalid = validateConfig(config);
    if (invalid) throw new Error(invalid);

    const settings = this.deps.settings();
    const taskId = randomUUID();
    const startedAt = Date.now();
    this.abort = new AbortController();
    this.paused = false;
    this.status = {
      ...idleStatus(),
      phase: 'thinking',
      task: { id: taskId, text: task, startedAt },
      maxSteps: settings.agent.maxSteps,
      currentAction: '準備しています',
      provider: {
        id: config.provider,
        label: PROVIDER_LABELS[config.provider],
        model: config.model,
        vision: config.supportsVision,
        tools: config.supportsTools,
      },
    };
    this.emit('status', this.status);
    this.deps.history.begin({
      id: taskId,
      text: task,
      status: 'running',
      startedAt,
      endedAt: null,
      provider: config.provider,
      model: config.model,
      steps: 0,
      summary: null,
    });
    this.log('user', task);
    if (!config.supportsVision) {
      this.log('system', 'このモデルは画像入力に対応していない設定のため、画面認識は UI 要素情報とウィンドウ情報のみで行います。');
    }
    if (!config.supportsTools) {
      this.log('system', 'このモデルはツール呼び出しに対応していない設定のため、JSON 形式の操作指示で代替します (精度が下がる場合があります)。');
    }

    const signal = this.abort.signal;
    this.running = (async () => {
      let outcome: 'completed' | 'failed' | 'stopped' = 'failed';
      let summary = '';
      let steps = 0;
      try {
        const result = await runAgent(
          { task, config, settings, environment: this.deps.environment(), signal },
          this.deps.agentDeps,
          this.host(),
        );
        outcome = result.outcome;
        summary = result.summary;
        steps = result.steps;
      } catch (err) {
        outcome = signal.aborted ? 'stopped' : 'failed';
        summary = signal.aborted ? 'ユーザーにより停止されました' : `予期しないエラー: ${(err as Error).message}`;
        if (!signal.aborted) this.update({ error: (err as Error).message });
      } finally {
        this.cleanupInput();
      }
      this.log(outcome === 'completed' ? 'assistant' : outcome === 'stopped' ? 'system' : 'error', summary);
      this.deps.history.finish(taskId, { status: outcome, endedAt: Date.now(), summary, steps });
      this.paused = false;
      this.rejectWaiters(new AbortedError());
      this.update({
        phase: outcome,
        summary,
        step: steps,
        currentAction: null,
        pendingApproval: null,
        pendingQuestion: null,
        currentTool: null,
        scheduled: [],
        pauseReason: null,
        sendingScreenshot: false,
        error: outcome === 'failed' ? summary : this.status.error,
      });
      this.abort = null;
      this.running = null;
    })();
    return { taskId };
  }

  private host(): AgentHost {
    return {
      setPhase: (phase, patch = {}) => {
        const p: Partial<AgentStatus> = {};
        if (patch.step !== undefined) p.step = patch.step;
        if (patch.currentAction !== undefined) p.currentAction = patch.currentAction;
        if (patch.lastResult !== undefined) p.lastResult = patch.lastResult;
        if (patch.currentTool !== undefined) p.currentTool = patch.currentTool;
        if (this.paused) {
          this.phaseBeforePause = phase;
          this.update(p);
        } else {
          this.update({ ...p, phase, sendingScreenshot: phase === 'thinking' ? this.status.sendingScreenshot : false });
        }
      },
      log: (kind, text, extra) => this.log(kind, text, extra),
      setScheduled: (list) => this.update({ scheduled: list }),
      requestApproval: (req) => this.waitApproval(req),
      askUser: (q) => this.waitQuestion(q),
      checkpoint: () => this.checkpoint(),
      transmission: (info) => {
        this.update({ lastTransmission: info.description, sendingScreenshot: info.images > 0 });
      },
    };
  }

  private checkpoint(): Promise<void> {
    if (this.abort?.signal.aborted) return Promise.reject(new AbortedError());
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve, reject) => this.resumeWaiters.push({ resolve, reject }));
  }

  private waitApproval(req: Omit<PendingApproval, 'id'>): Promise<ApprovalAnswer> {
    const id = randomUUID();
    const pending: PendingApproval = { id, ...req };
    const prevPhase = this.status.phase;
    this.update({ pendingApproval: pending, phase: this.paused ? 'paused' : 'awaiting-approval' });
    this.emit('attention', 'approval');
    return new Promise<ApprovalAnswer>((resolve, reject) => {
      this.approval = { id, resolve, reject };
    }).finally(() => {
      this.approval = null;
      this.update({ pendingApproval: null, phase: this.paused ? 'paused' : prevPhase === 'awaiting-approval' ? 'thinking' : prevPhase });
    });
  }

  private waitQuestion(question: string): Promise<string> {
    const id = randomUUID();
    this.update({ pendingQuestion: { id, question }, phase: this.paused ? 'paused' : 'awaiting-input' });
    this.emit('attention', 'question');
    return new Promise<string>((resolve, reject) => {
      this.question = { id, resolve, reject };
    }).finally(() => {
      this.question = null;
      this.update({ pendingQuestion: null, phase: this.paused ? 'paused' : 'thinking' });
    });
  }

  respondApproval(id: string, approved: boolean, remember: boolean): void {
    if (!this.approval || this.approval.id !== id) throw new Error('この承認リクエストは既に終了しています');
    this.approval.resolve({ approved, remember });
  }

  answerQuestion(id: string, text: string): void {
    if (!this.question || this.question.id !== id) throw new Error('この質問は既に終了しています');
    const t = text.trim();
    if (!t) throw new Error('回答を入力してください');
    this.question.resolve(t.slice(0, 4000));
  }

  /** 一時停止 (承認待ち・質問待ちの間も可能) */
  pause(reason: string | null = null): boolean {
    if (!this.running || this.paused) return false;
    this.paused = true;
    this.phaseBeforePause = this.status.phase;
    this.cleanupInput();
    this.update({ phase: 'paused', pauseReason: reason });
    if (reason) this.log('system', reason);
    else this.log('system', '一時停止しました');
    return true;
  }

  resume(): boolean {
    if (!this.running || !this.paused) return false;
    this.paused = false;
    const phase = this.status.pendingApproval
      ? 'awaiting-approval'
      : this.status.pendingQuestion
        ? 'awaiting-input'
        : this.phaseBeforePause === 'paused'
          ? 'thinking'
          : this.phaseBeforePause;
    this.update({ phase, pauseReason: null });
    this.log('system', '再開しました');
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    waiters.forEach((w) => w.resolve());
    return true;
  }

  /** 即時停止。実行中の API 呼び出し・操作を中断し、入力を解放する。 */
  stop(): boolean {
    if (!this.running || !this.abort) return false;
    this.abort.abort();
    this.cleanupInput();
    this.rejectWaiters(new AbortedError());
    this.paused = false;
    this.update({ currentAction: '停止しています', pendingApproval: null, pendingQuestion: null });
    return true;
  }

  private rejectWaiters(err: Error) {
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    waiters.forEach((w) => w.reject(err));
    this.approval?.reject(err);
    this.question?.reject(err);
  }

  private cleanupInput() {
    try {
      const released = this.deps.releaseInput();
      if (released.keys + released.buttons > 0) {
        this.log('system', `押されたままのキー ${released.keys} 個・マウスボタン ${released.buttons} 個を解放しました`);
      }
    } catch {
      /* Win32 不可の環境 */
    }
  }

  isBusy(): boolean {
    return this.running !== null && isBusyPhase(this.status.phase);
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** 終了処理 */
  async shutdown(): Promise<void> {
    this.stop();
    if (this.running) await Promise.race([this.running, new Promise((r) => setTimeout(r, 2000))]);
    await this.deps.history.saveNow();
  }
}
