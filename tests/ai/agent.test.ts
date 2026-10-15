import { describe, expect, it } from 'vitest';
import { runAgent, type AgentExecutor, type AgentHost, type ApprovalAnswer } from '../../src/services/agent/agent';
import type { ChatSession, ContentPart, ModelTurn, ProviderConfig, ToolResultMessage } from '../../src/services/ai/types';
import { defaultSettings, type Settings } from '../../src/services/settings/schema';
import { LoopGuard } from '../../src/services/agent/loop-guard';
import type { ToolOutcome } from '../../src/services/computer-use/executor';

/** 決められた応答を順に返すモデル */
class ScriptedSession implements ChatSession {
  results: ToolResultMessage[][] = [];
  users: ContentPart[][] = [];
  constructor(private turns: ModelTurn[]) {}
  addUser(parts: ContentPart[]) {
    this.users.push(parts);
  }
  addToolResults(r: ToolResultMessage[]) {
    this.results.push(r);
  }
  async next(signal: AbortSignal): Promise<ModelTurn> {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const t = this.turns.shift();
    if (!t) throw new Error('no more turns');
    return t;
  }
  pruneImages() {}
}

const call = (name: string, args: unknown, id = name) => ({ id, name, args });
const turn = (...calls: ReturnType<typeof call>[]): ModelTurn => ({ text: '', toolCalls: calls, stopReason: 'tool_use' });

class FakeExecutor implements AgentExecutor {
  vision = true;
  executed: string[] = [];
  constructor(private outcome: (name: string) => ToolOutcome = () => ({ content: [{ type: 'text', text: 'ok' }], isError: false, summary: 'ok', screenChanged: true })) {}
  prepareTask() {}
  async observe() {
    return { parts: [{ type: 'text' as const, text: 'screen' }], summary: '', sentImage: false, blocked: null };
  }
  async execute(name: string) {
    this.executed.push(name);
    return this.outcome(name);
  }
}

function host(opts: { approve?: boolean; answer?: string; onPhase?: (p: string) => void } = {}) {
  const logs: string[] = [];
  const approvals: string[] = [];
  const h: AgentHost = {
    setPhase: (p) => opts.onPhase?.(p),
    log: (_k, t) => logs.push(t),
    requestApproval: async (req): Promise<ApprovalAnswer> => {
      approvals.push(req.tool);
      return { approved: opts.approve ?? true, remember: false };
    },
    askUser: async () => opts.answer ?? 'はい',
    checkpoint: async () => {},
    transmission: () => {},
  };
  return { h, logs, approvals };
}

const config: ProviderConfig = {
  provider: 'anthropic',
  model: 'm',
  endpoint: 'https://api.anthropic.com',
  apiKey: 'k',
  maxTokens: 1000,
  temperature: null,
  supportsVision: true,
  supportsTools: true,
  maxRetries: 0,
};
const env = { now: new Date(0), os: 'Windows', displays: '#0', folders: {} };

function input(settings: Settings = defaultSettings(), signal = new AbortController().signal) {
  return { task: 'メモ帳を開いて', config, settings, environment: env, signal };
}

describe('agent loop', () => {
  it('executes actions and completes with task_complete', async () => {
    const session = new ScriptedSession([
      turn(call('launch_app', { name: 'notepad' })),
      turn(call('type_text', { text: 'こんにちは' })),
      turn(call('task_complete', { summary: 'メモ帳に入力しました', success: true })),
    ]);
    const ex = new FakeExecutor();
    const { h } = host();
    const r = await runAgent(input(), { executor: ex, createSession: () => session }, h);
    expect(r).toMatchObject({ outcome: 'completed', summary: 'メモ帳に入力しました', steps: 3 });
    expect(ex.executed).toEqual(['launch_app', 'type_text']);
    expect(session.users[0][0]).toMatchObject({ type: 'text' });
  });

  it('asks approval for high-risk actions and tells the model when denied', async () => {
    const session = new ScriptedSession([
      turn(call('delete_path', { path: 'Desktop\\a.txt' })),
      turn(call('task_complete', { summary: 'やめました', success: false })),
    ]);
    const ex = new FakeExecutor();
    const { h, approvals } = host({ approve: false });
    const r = await runAgent(input(), { executor: ex, createSession: () => session }, h);
    expect(approvals).toEqual(['delete_path']);
    expect(ex.executed).toEqual([]);
    expect(JSON.stringify(session.results[0])).toContain('denied');
    expect(r.outcome).toBe('failed');
  });

  it('does not execute tools from denied categories', async () => {
    const settings = defaultSettings();
    settings.permissions.keyboard = 'deny';
    const session = new ScriptedSession([
      turn(call('type_text', { text: 'x' })),
      turn(call('task_complete', { summary: 'ok' })),
    ]);
    const ex = new FakeExecutor();
    await runAgent(input(settings), { executor: ex, createSession: () => session }, host().h);
    expect(ex.executed).toEqual([]);
    expect(JSON.stringify(session.results[0])).toContain('Permission denied');
  });

  it('relays ask_user answers and request_confirmation decisions', async () => {
    const session = new ScriptedSession([
      turn(call('ask_user', { question: 'どのファイル？' })),
      turn(call('request_confirmation', { action: 'メールを送信', reason: '送信は取り消せない' })),
      turn(call('task_complete', { summary: 'done' })),
    ]);
    const { h, approvals } = host({ answer: 'a.txt', approve: true });
    await runAgent(input(), { executor: new FakeExecutor(), createSession: () => session }, h);
    expect(JSON.stringify(session.results[0])).toContain('a.txt');
    expect(approvals).toEqual(['request_confirmation']);
    expect(JSON.stringify(session.results[1])).toContain('APPROVED');
  });

  it('returns invalid arguments to the model instead of executing', async () => {
    const session = new ScriptedSession([turn(call('mouse_click', { x: 'left' })), turn(call('task_complete', { summary: 'ok' }))]);
    const ex = new FakeExecutor();
    await runAgent(input(), { executor: ex, createSession: () => session }, host().h);
    expect(ex.executed).toEqual([]);
    expect(session.results[0][0].isError).toBe(true);
  });

  it('stops repeating the same action when the screen does not change', async () => {
    const same = () => turn(call('mouse_click', { x: 1, y: 1 }));
    const session = new ScriptedSession([same(), same(), same(), same(), same(), same(), same()]);
    const ex = new FakeExecutor(() => ({ content: [{ type: 'text', text: 'ok' }], isError: false, summary: 'ok', screenChanged: false }));
    const r = await runAgent(input(), { executor: ex, createSession: () => session }, host().h);
    expect(r.outcome).toBe('failed');
    expect(ex.executed.length).toBe(5);
    expect(JSON.stringify(session.results[2])).toContain('repeated the same action');
  });

  it('stops at max steps', async () => {
    const settings = defaultSettings();
    settings.agent.maxSteps = 2;
    const session = new ScriptedSession([turn(call('wait', { seconds: 0.1 })), turn(call('wait', { seconds: 0.2 })), turn(call('wait', { seconds: 0.3 }))]);
    const r = await runAgent(input(settings), { executor: new FakeExecutor(), createSession: () => session }, host().h);
    expect(r.outcome).toBe('failed');
    expect(r.summary).toContain('最大ステップ');
  });

  it('reports "stopped" when aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const session = new ScriptedSession([turn(call('wait', { seconds: 1 }))]);
    const r = await runAgent(input(defaultSettings(), ctrl.signal), { executor: new FakeExecutor(), createSession: () => session }, host().h);
    expect(r.outcome).toBe('stopped');
  });

  it('treats a plain text reply as completion', async () => {
    const session = new ScriptedSession([{ text: '終わりました', toolCalls: [], stopReason: 'end_turn' }]);
    const r = await runAgent(input(), { executor: new FakeExecutor(), createSession: () => session }, host().h);
    expect(r).toMatchObject({ outcome: 'completed', summary: '終わりました' });
  });
});

describe('LoopGuard', () => {
  it('aborts immediately on failure when auto retry is disabled', () => {
    const g = new LoopGuard({ maxActionRetries: 3, autoRetry: false });
    expect(g.record('x', {}, { isError: true }).kind).toBe('abort');
  });

  it('warns then aborts on consecutive failures', () => {
    const g = new LoopGuard({ maxActionRetries: 2, autoRetry: true });
    expect(g.record('a', { i: 1 }, { isError: true }).kind).toBe('ok');
    expect(g.record('a', { i: 2 }, { isError: true }).kind).toBe('warn');
    g.record('a', { i: 3 }, { isError: true });
    g.record('a', { i: 4 }, { isError: true });
    expect(g.record('a', { i: 5 }, { isError: true }).kind).toBe('abort');
  });
});
