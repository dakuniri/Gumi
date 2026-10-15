/**
 * AI エージェントの実行ループ。
 *
 * 指示解析 → 画面認識 → 計画 (モデル) → 権限検証 → 実行 → 結果確認 → 再試行 / 継続 → 完了判定 → 報告
 *
 * UI・状態管理 (TaskManager) とは {@link AgentHost} を介して疎結合にしてあり、
 * テストではモデルと実行器をモックに差し替えられる。
 */
import type { Settings, PermissionCategory } from '../settings/schema';
import type { AgentPhase, LogKind, PendingApproval, RiskLevel } from '../../types/agent';
import type { ChatSession, ContentPart, ProviderConfig, SessionInit, ToolResultMessage } from '../ai/types';
import { ApiError } from '../ai/types';
import { availableTools, getTool, toolSpecs, validateToolCall, type ToolDefinition } from '../computer-use/tools';
import { decidePermission } from '../computer-use/permissions';
import type { ObserveResult, ToolOutcome } from '../computer-use/executor';
import { LoopGuard } from './loop-guard';
import { buildSystemPrompt, buildTaskMessage, type PromptEnvironment } from './prompts';
import { isAbortError, AbortedError } from '../automation/util';
import { ClickScheduler, Mutex, type ScheduledClick } from './scheduler';
import type { Point } from '../../types/character';
import type { MouseButton } from '../automation/win32/input';
import type { ScheduledClickInfo } from '../../types/agent';

export interface AgentExecutor {
  vision: boolean;
  prepareTask(): void;
  observe(opts: { image: boolean; header?: string }): Promise<ObserveResult>;
  execute(name: string, args: Record<string, unknown>, opts: { signal: AbortSignal; verify: boolean }): Promise<ToolOutcome>;
  /** 画像座標 -> 物理座標 (クリック予約用) */
  resolvePoint?(x: number, y: number): Point;
  /** 物理座標でクリック (予約したクリックの実行用) */
  clickPhysical?(p: Point, button: MouseButton, clicks: number, signal: AbortSignal): Promise<void>;
}

export interface ApprovalAnswer {
  approved: boolean;
  remember: boolean;
}

export interface AgentHost {
  setPhase(
    phase: AgentPhase,
    patch?: { step?: number; currentAction?: string | null; lastResult?: string | null; currentTool?: string | null },
  ): void;
  /** 予約クリックの一覧が変わった */
  setScheduled?(list: ScheduledClickInfo[]): void;
  log(kind: LogKind, text: string, extra?: { tool?: string; risk?: RiskLevel; ok?: boolean }): void;
  requestApproval(req: Omit<PendingApproval, 'id'>): Promise<ApprovalAnswer>;
  askUser(question: string): Promise<string>;
  /** 一時停止中なら再開まで待つ。停止されていれば例外。 */
  checkpoint(): Promise<void>;
  /** API 送信内容の明示 */
  transmission(info: { images: number; chars: number; description: string }): void;
}

export interface AgentRunInput {
  task: string;
  config: ProviderConfig;
  settings: Settings;
  environment: Omit<PromptEnvironment, 'vision' | 'deniedCategories' | 'confirmPolicy'>;
  signal: AbortSignal;
}

export interface AgentResult {
  outcome: 'completed' | 'failed' | 'stopped';
  summary: string;
  steps: number;
}

export interface AgentDeps {
  executor: AgentExecutor;
  createSession: (init: SessionInit) => ChatSession;
}

const MAX_CONTINUATIONS = 2;

const SCHEDULE_TOOLS = new Set(['schedule_click', 'cancel_scheduled_click', 'list_scheduled_clicks']);

export async function runAgent(input: AgentRunInput, deps: AgentDeps, host: AgentHost): Promise<AgentResult> {
  const { signal } = input;
  const { executor } = deps;
  // AI 自身の操作と予約クリックが同時に入力しないよう直列化する
  const lock = new Mutex();
  /** 予約クリックの実行結果 (次のツール結果と一緒に AI へ伝える) */
  const notes: string[] = [];
  const scheduler = new ClickScheduler({
    signal,
    checkpoint: () => host.checkpoint(),
    run: (c, sig) =>
      lock.run(async () => {
        if (!executor.clickPhysical) throw new Error('この環境ではクリックを予約できません');
        host.setPhase('acting', { currentAction: `予約したクリック #${c.id} を実行`, currentTool: 'schedule_click' });
        await executor.clickPhysical(c.point, c.button, c.clicks, sig);
        host.setPhase('thinking', { currentTool: null });
        return `(${c.imagePoint.x}, ${c.imagePoint.y}) をクリックしました`;
      }),
    onChange: (list) => host.setScheduled?.(list),
    onDone: (c, ok, msg) => {
      host.log(ok ? 'result' : 'error', `予約 #${c.id}: ${ok ? msg : `失敗: ${msg}`}`, { tool: 'schedule_click', ok });
      notes.push(`Scheduled click #${c.id} at (${c.imagePoint.x}, ${c.imagePoint.y}) ${ok ? 'was performed' : `FAILED: ${msg}`}.`);
    },
  });

  try {
    const result = await runLoop(input, deps, host, { lock, scheduler, notes });
    if (result.outcome === 'completed' && scheduler.pending > 0) {
      host.setPhase('acting', { currentAction: `予約したクリック ${scheduler.pending} 件の実行を待っています`, currentTool: null });
      host.log('system', `予約したクリック ${scheduler.pending} 件が終わるまでタスクを続けます`);
      try {
        await scheduler.waitAll();
      } catch (err) {
        if (isAbortError(err) || signal.aborted) {
          return { ...result, outcome: 'stopped', summary: 'ユーザーにより停止されました (予約は取り消しました)' };
        }
        throw err;
      }
    }
    return result;
  } finally {
    scheduler.cancelAll();
  }
}

interface LoopContext {
  lock: Mutex;
  scheduler: ClickScheduler;
  notes: string[];
}

async function runLoop(input: AgentRunInput, deps: AgentDeps, host: AgentHost, ctx: LoopContext): Promise<AgentResult> {
  const { settings, config, signal } = input;
  const { executor } = deps;
  const vision = config.supportsVision && settings.permissions.screenshot !== 'deny';
  executor.vision = vision;
  executor.prepareTask();

  const isDenied = (c: PermissionCategory) => settings.permissions[c] === 'deny';
  const tools = availableTools({ vision, isDenied });
  const deniedCategories = (Object.keys(settings.permissions) as PermissionCategory[]).filter(isDenied);
  const system = buildSystemPrompt({
    ...input.environment,
    vision,
    deniedCategories,
    confirmPolicy: settings.confirmPolicy,
  });
  const session = deps.createSession({ config, system, tools: toolSpecs(tools) });
  const guard = new LoopGuard({ maxActionRetries: settings.agent.maxActionRetries, autoRetry: settings.agent.autoRetry });
  const approvedForTask = new Set<string>();
  let pendingImages = 0;
  let pendingChars = system.length;
  let steps = 0;
  let continuations = 0;

  const countParts = (parts: ContentPart[]) => {
    for (const p of parts) {
      if (p.type === 'image') pendingImages++;
      else pendingChars += p.text.length;
    }
  };

  try {
    // ---- 初期状態の認識 ----
    host.setPhase('thinking', { step: 0, currentAction: '画面を確認しています' });
    const initial = await executor.observe({ image: vision, header: 'Initial state of the screen.' });
    if (initial.blocked) host.log('system', `機密の可能性があるウィンドウ「${initial.blocked}」が表示されているため、スクリーンショットを送信しませんでした`);
    const first: ContentPart[] = [{ type: 'text', text: buildTaskMessage(input.task) }, ...initial.parts];
    countParts(first);
    session.addUser(first);

    for (;;) {
      await host.checkpoint();
      if (steps >= settings.agent.maxSteps) {
        return { outcome: 'failed', summary: `最大ステップ数 (${settings.agent.maxSteps}) に達したため停止しました`, steps };
      }
      steps++;
      host.setPhase('thinking', { step: steps, currentAction: '次の操作を考えています' });
      session.pruneImages(settings.agent.keepScreenshots);
      host.transmission({
        images: pendingImages,
        chars: pendingChars,
        description: `${config.provider} / ${config.model} へ送信: テキスト約${pendingChars}文字${pendingImages ? ` + 画面画像${pendingImages}枚` : ''}`,
      });
      pendingImages = 0;
      pendingChars = 0;

      const turn = await session.next(signal);
      if (turn.text) host.log('assistant', turn.text);

      if (turn.toolCalls.length === 0) {
        if ((turn.stopReason === 'max_tokens' || turn.stopReason === 'length' || turn.stopReason === 'MAX_TOKENS') && continuations < MAX_CONTINUATIONS) {
          continuations++;
          const cont: ContentPart[] = [{ type: 'text', text: 'Your reply was cut off. Continue, and use tools to act.' }];
          countParts(cont);
          session.addUser(cont);
          continue;
        }
        if (turn.stopReason === 'refusal' || turn.stopReason === 'SAFETY') {
          return { outcome: 'failed', summary: turn.text || 'AI が依頼の実行を拒否しました', steps };
        }
        // ツールを呼ばずに応答した = 作業終了とみなす
        return { outcome: 'completed', summary: turn.text || '完了しました', steps };
      }

      const results: ToolResultMessage[] = [];
      let finish: AgentResult | null = null;
      const lastVerifyIndex = findLastVerifyIndex(turn.toolCalls);

      for (let i = 0; i < turn.toolCalls.length; i++) {
        const call = turn.toolCalls[i];
        const push = (content: ContentPart[], isError = false) => {
          countParts(content);
          results.push({ callId: call.id, name: call.name, content, isError });
        };

        if (finish) {
          push([{ type: 'text', text: 'Skipped: task already finished.' }], true);
          continue;
        }
        if (call.parseError) {
          host.log('error', `AI の出力を解釈できませんでした: ${call.parseError}`);
          push([{ type: 'text', text: `Error: ${call.parseError}. Reply with valid arguments.` }], true);
          continue;
        }

        let tool: ToolDefinition;
        let args: Record<string, unknown>;
        try {
          ({ tool, args } = validateToolCall(call.name, call.args));
        } catch (err) {
          const msg = (err as Error).message;
          host.log('error', `不正な操作要求: ${msg}`, { tool: call.name, ok: false });
          push([{ type: 'text', text: `Error: ${msg}` }], true);
          const verdict = guard.record(call.name, call.args, { isError: true });
          if (verdict.kind === 'abort') finish = { outcome: 'failed', summary: verdict.reason, steps };
          continue;
        }

        // ---- 制御ツール ----
        if (tool.name === 'task_complete') {
          const success = args.success !== false;
          finish = { outcome: success ? 'completed' : 'failed', summary: String(args.summary), steps };
          push([{ type: 'text', text: 'Task finished.' }]);
          continue;
        }
        if (tool.name === 'ask_user') {
          host.log('assistant', `質問: ${String(args.question)}`);
          host.setPhase('awaiting-input', { currentAction: 'あなたの回答を待っています' });
          const answer = await host.askUser(String(args.question));
          host.log('user', answer);
          push([{ type: 'text', text: `User answered: ${answer}` }]);
          continue;
        }

        const risk = tool.risk(args as never);
        const description = tool.describe(args as never);
        const decision = decidePermission(tool, risk, {
          permissions: settings.permissions,
          confirmPolicy: settings.confirmPolicy,
          approvedForTask,
        });

        if (decision.kind === 'deny') {
          host.log('error', `${description} — ${decision.reason}`, { tool: tool.name, ok: false });
          push([{ type: 'text', text: `Permission denied: ${decision.reason}. Do not retry this; use another approach or ask_user.` }], true);
          continue;
        }

        if (decision.kind === 'ask') {
          host.setPhase('awaiting-approval', { currentAction: `承認待ち: ${description}` });
          const answer = await host.requestApproval({
            tool: tool.name,
            category: tool.category === 'none' ? 'control' : tool.category,
            risk: decision.risk,
            description: tool.name === 'request_confirmation' ? String(args.action) : description,
            details: tool.name === 'request_confirmation' ? String(args.reason ?? '') : formatArgs(args),
            reason: decision.reason,
          });
          host.log('approval', `${answer.approved ? '承認' : '拒否'}: ${description}`, { tool: tool.name, risk: decision.risk, ok: answer.approved });
          if (answer.approved && answer.remember && decision.rememberable) approvedForTask.add(tool.name);
          if (tool.name === 'request_confirmation') {
            push([{ type: 'text', text: answer.approved ? 'The user APPROVED. Proceed.' : 'The user DENIED. Do not perform this action. Choose another approach, ask_user, or finish with task_complete.' }]);
            continue;
          }
          if (!answer.approved) {
            push([{ type: 'text', text: 'The user denied this action. Do not retry it; choose another approach or ask_user.' }], true);
            continue;
          }
        } else if (tool.name === 'request_confirmation') {
          push([{ type: 'text', text: 'Approved.' }]);
          continue;
        }

        // ---- クリック予約 ----
        if (SCHEDULE_TOOLS.has(tool.name)) {
          try {
            const text = handleScheduleTool(tool.name, args, executor, ctx.scheduler);
            host.log('action', description, { tool: tool.name, risk: risk.level });
            host.log('result', text.summary, { tool: tool.name, ok: true });
            push([{ type: 'text', text: text.forModel }]);
          } catch (err) {
            const msg = (err as Error).message;
            host.log('error', `${description}: ${msg}`, { tool: tool.name, ok: false });
            push([{ type: 'text', text: `Error: ${msg}` }], true);
          }
          continue;
        }

        // ---- 実行 ----
        await host.checkpoint();
        host.setPhase(tool.kind === 'observe' ? 'thinking' : 'acting', { currentAction: description, currentTool: tool.name });
        host.log('action', description, { tool: tool.name, risk: risk.level });
        const outcome = await ctx.lock.run(() =>
          executor.execute(tool.name, args, {
            signal,
            verify: !!tool.verifyAfter && i === lastVerifyIndex,
          }),
        );
        host.log('result', outcome.summary, { tool: tool.name, ok: !outcome.isError });
        host.setPhase('thinking', { lastResult: outcome.summary, currentTool: null });

        const content = [...outcome.content];
        const verdict = guard.record(tool.name, args, outcome);
        if (verdict.kind === 'warn') {
          content.push({ type: 'text', text: verdict.message });
          host.log('system', '同じ操作の繰り返し / 連続失敗を検出したため、AI に方針転換を指示しました');
        } else if (verdict.kind === 'abort') {
          finish = { outcome: 'failed', summary: verdict.reason, steps };
        }
        push(content, outcome.isError);
      }

      if (finish) return finish;
      // 予約クリックの実行結果を AI に伝える
      if (ctx.notes.length && results.length) {
        results[results.length - 1].content.push({ type: 'text', text: ctx.notes.splice(0).join('\n') });
      }
      session.addToolResults(results);
    }
  } catch (err) {
    if (isAbortError(err) || signal.aborted) {
      return { outcome: 'stopped', summary: 'ユーザーにより停止されました', steps };
    }
    if (err instanceof ApiError) {
      return { outcome: 'failed', summary: `AI API エラー: ${err.message}`, steps };
    }
    throw err;
  }
}

function handleScheduleTool(
  name: string,
  args: Record<string, unknown>,
  executor: AgentExecutor,
  scheduler: ClickScheduler,
): { forModel: string; summary: string } {
  if (name === 'list_scheduled_clicks') {
    const list = scheduler.list();
    if (list.length === 0) return { forModel: 'No pending click reservations.', summary: '予約なし' };
    const now = Date.now();
    const lines = list.map(
      (c) => `#${c.id}: ${c.button} x${c.clicks} at (${c.imagePoint.x}, ${c.imagePoint.y}) in ${Math.max(0, Math.round((c.at - now) / 1000))}s`,
    );
    return { forModel: lines.join('\n'), summary: `予約 ${list.length} 件` };
  }
  if (name === 'cancel_scheduled_click') {
    const id = Number(args.id);
    if (!scheduler.cancel(id)) throw new Error(`Reservation #${id} not found or already running.`);
    return { forModel: `Reservation #${id} cancelled.`, summary: `予約 #${id} を取り消しました` };
  }
  if (!executor.resolvePoint) throw new Error('Click reservation is not available.');
  const x = Number(args.x);
  const y = Number(args.y);
  const point = executor.resolvePoint(x, y);
  const button = (args.button as MouseButton) ?? 'left';
  const clicks = Number(args.clicks ?? 1);
  const delay = Number(args.delay_seconds);
  const c: ScheduledClick = scheduler.add({
    point,
    imagePoint: { x: Math.round(x), y: Math.round(y) },
    button,
    clicks,
    delaySec: delay,
    label: `(${Math.round(x)}, ${Math.round(y)}) を${button === 'right' ? '右' : ''}${clicks === 2 ? 'ダブル' : ''}クリック`,
  });
  return {
    forModel: `Reservation #${c.id}: ${button} click x${clicks} at (${Math.round(x)}, ${Math.round(y)}) in ${delay}s. Continue with other work; the result will be reported later.`,
    summary: `予約 #${c.id} を登録しました`,
  };
}

/** 1 ターンに複数の操作がある場合、結果確認 (再撮影) は最後の操作の後だけ行う */
function findLastVerifyIndex(calls: { name: string }[]): number {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (getTool(calls[i].name)?.verifyAfter) return i;
  }
  return -1;
}

function formatArgs(args: Record<string, unknown>): string {
  const s = JSON.stringify(args, (_k, v) => (typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v), 2);
  return s.length > 1500 ? s.slice(0, 1500) + '…' : s;
}

export { AbortedError };
