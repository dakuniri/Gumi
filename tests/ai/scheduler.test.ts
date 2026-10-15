import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClickScheduler, MAX_SCHEDULED, Mutex } from '../../src/services/agent/scheduler';
import { runAgent, type AgentExecutor } from '../../src/services/agent/agent';
import type { ChatSession, ModelTurn } from '../../src/services/ai/types';
import { defaultSettings } from '../../src/services/settings/schema';

function makeScheduler(opts: { paused?: () => boolean } = {}) {
  const ctrl = new AbortController();
  const ran: number[] = [];
  const done: { id: number; ok: boolean }[] = [];
  let resume: (() => void) | null = null;
  const s = new ClickScheduler({
    signal: ctrl.signal,
    checkpoint: () => (opts.paused?.() ? new Promise<void>((r) => (resume = r)) : Promise.resolve()),
    run: async (c) => {
      ran.push(c.id);
      return 'ok';
    },
    onChange: () => undefined,
    onDone: (c, ok) => done.push({ id: c.id, ok }),
  });
  const add = (delaySec: number) =>
    s.add({ point: { x: 1, y: 2 }, imagePoint: { x: 1, y: 2 }, button: 'left', clicks: 1, label: 'x', delaySec });
  return { s, ctrl, ran, done, add, resume: () => resume?.() };
}

describe('ClickScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs a reservation after its delay, in order', async () => {
    const { s, ran, add } = makeScheduler();
    add(5);
    add(2);
    expect(s.pending).toBe(2);
    await vi.advanceTimersByTimeAsync(2100);
    expect(ran).toEqual([2]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(ran).toEqual([2, 1]);
    expect(s.pending).toBe(0);
  });

  it('can cancel, limits the number, and clamps the delay', async () => {
    const { s, ran, add } = makeScheduler();
    const c = add(10);
    expect(s.cancel(c.id)).toBe(true);
    expect(s.cancel(999)).toBe(false);
    for (let i = 0; i < MAX_SCHEDULED; i++) add(100);
    expect(() => add(100)).toThrow();
    s.cancelAll();
    const tiny = add(0.01);
    expect(tiny.at - Date.now()).toBeGreaterThanOrEqual(500);
    await vi.advanceTimersByTimeAsync(600);
    expect(ran).toEqual([tiny.id]);
  });

  it('waits for resume when the time comes during a pause', async () => {
    let paused = true;
    const m = makeScheduler({ paused: () => paused });
    m.add(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(m.ran).toEqual([]);
    paused = false;
    m.resume();
    await vi.advanceTimersByTimeAsync(10);
    expect(m.ran).toHaveLength(1);
  });

  it('cancels everything when the task is stopped', async () => {
    const { s, ctrl, ran, add } = makeScheduler();
    add(1);
    add(2);
    const wait = s.waitAll();
    ctrl.abort();
    await expect(wait).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(3000);
    expect(ran).toEqual([]);
    expect(s.pending).toBe(0);
  });
});

describe('Mutex', () => {
  it('runs tasks one at a time', async () => {
    const m = new Mutex();
    const order: string[] = [];
    const slow = m.run(async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('a-end');
    });
    const fast = m.run(async () => {
      order.push('b');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });
});

describe('agent with click reservations', () => {
  it('keeps the task running until the reserved click is done', async () => {
    const turns: ModelTurn[] = [
      { text: '', toolCalls: [{ id: '1', name: 'schedule_click', args: { x: 10, y: 20, delay_seconds: 0.5 } }], stopReason: 'tool_use' },
      { text: '', toolCalls: [{ id: '2', name: 'task_complete', args: { summary: '予約しました' } }], stopReason: 'tool_use' },
    ];
    const session: ChatSession = {
      addUser() {},
      addToolResults() {},
      next: async () => turns.shift()!,
      pruneImages() {},
    };
    const clicks: { x: number; y: number }[] = [];
    const executor: AgentExecutor = {
      vision: true,
      prepareTask() {},
      observe: async () => ({ parts: [{ type: 'text', text: 's' }], summary: '', sentImage: false, blocked: null }),
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false, summary: 'ok' }),
      resolvePoint: (x, y) => ({ x: x * 2, y: y * 2 }),
      clickPhysical: async (p) => {
        clicks.push(p);
      },
    };
    const phases: string[] = [];
    const started = Date.now();
    const r = await runAgent(
      {
        task: 't',
        config: {
          provider: 'anthropic',
          model: 'm',
          endpoint: 'https://api.anthropic.com',
          apiKey: 'k',
          maxTokens: 100,
          temperature: null,
          supportsVision: true,
          supportsTools: true,
          maxRetries: 0,
        },
        settings: defaultSettings(),
        environment: { now: new Date(0), os: 'w', displays: '', folders: {} },
        signal: new AbortController().signal,
      },
      { executor, createSession: () => session },
      {
        setPhase: (p, patch) => phases.push(`${p}:${patch?.currentAction ?? ''}`),
        log: () => undefined,
        requestApproval: async () => ({ approved: true, remember: false }),
        askUser: async () => '',
        checkpoint: async () => undefined,
        transmission: () => undefined,
      },
    );
    expect(r.outcome).toBe('completed');
    expect(clicks).toEqual([{ x: 20, y: 40 }]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(phases.some((p) => p.includes('予約したクリック'))).toBe(true);
  });
});
