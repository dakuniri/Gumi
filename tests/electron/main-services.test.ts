import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSettings, migrateSettings } from '../../src/services/settings/schema';
import { SettingsStore, type SecretCipher } from '../../src/services/settings/store';
import { HistoryStore } from '../../src/services/tasks/history-store';
import { TaskManager } from '../../src/services/tasks/task-manager';
import { invokeSchemas, sendSchemas, settingsPatchSchema } from '../../electron/ipc/schemas';
import { INVOKE_CHANNELS, SEND_CHANNELS } from '../../src/types/ipc';
import type { ChatSession, ModelTurn } from '../../src/services/ai/types';
import type { AgentExecutor } from '../../src/services/agent/agent';
import type { AgentStatus } from '../../src/types/agent';

const fakeCipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, ''),
};

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gumi-main-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('settings schema', () => {
  it('has small white defaults', () => {
    const s = defaultSettings();
    expect(s.version).toBe(3);
    expect(s.screenshot.hideGumiDuringCapture).toBe(true);
    expect('excludeGumi' in s.screenshot).toBe(false);
    expect(s.appearance.color).toBe('white');
    expect(s.character.size).toBe(36);
  });

  it('migrates v1 (face) settings to the small monochrome circle', () => {
    const s = migrateSettings({ character: { size: 96, sleepAfterSec: 300 }, appearance: { bodyColor: '#00FF00' }, expressions: { blink: true } });
    expect(s.character.size).toBe(36);
    expect(s.character.sleepAfterSec).toBe(300);
    expect(s.appearance).toEqual({ color: 'white', amuTone: 'white', animations: true, aiCursor: true });
  });

  it('migrates v2: capture exclusion removed, hide only during AI capture', () => {
    const s = migrateSettings({ version: 2, screenshot: { excludeGumi: true, hideGumiDuringCapture: false, jpegQuality: 70 } });
    expect(s.version).toBe(3);
    expect(s.screenshot.hideGumiDuringCapture).toBe(true);
    expect(s.screenshot.jpegQuality).toBe(70);
    expect('excludeGumi' in s.screenshot).toBe(false);
    expect(s.permissions.web).toBe('allow');
  });

  it('repairs invalid fields individually', () => {
    const s = migrateSettings({ version: 3, character: { size: 9999, sleepAfterSec: 60 }, agent: { maxSteps: 'x' } });
    expect(s.character.size).toBe(36);
    expect(s.character.sleepAfterSec).toBe(60);
    expect(s.agent.maxSteps).toBe(50);
    expect(migrateSettings('garbage')).toEqual(defaultSettings());
  });
});

describe('SettingsStore', () => {
  it('persists settings and encrypts API keys without exposing them publicly', async () => {
    const store = new SettingsStore(dir, fakeCipher);
    store.loadSync();
    store.update({ appearance: { color: 'black' } });
    store.setApiKey('anthropic', '  sk-test  ');
    await store.flush();
    expect(store.getApiKey('anthropic')).toBe('sk-test');
    const pub = store.getPublic();
    expect(pub.apiKeys.anthropic).toBe(true);
    expect(JSON.stringify(pub)).not.toContain('sk-test');
    expect(readFileSync(path.join(dir, 'secrets.json'), 'utf8')).not.toContain('sk-test');

    const reloaded = new SettingsStore(dir, fakeCipher);
    reloaded.loadSync();
    expect(reloaded.get().appearance.color).toBe('black');
    expect(reloaded.getApiKey('anthropic')).toBe('sk-test');
    expect(() => reloaded.update({ character: { size: 5 } })).toThrow();
  });

  it('keeps a backup of a corrupt settings file instead of silently losing it', () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'gumi-corrupt-'));
    writeFileSync(path.join(d, 'settings.json'), '{ "ai": { "provider": "openai", ');
    const store = new SettingsStore(d, fakeCipher);
    store.loadSync();
    expect(store.get().ai.provider).toBe('anthropic');
    const backups = readdirSync(d).filter((f) => f.startsWith('settings.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(d, backups[0]), 'utf8')).toContain('"openai"');
    rmSync(d, { recursive: true, force: true });
  });

  it('saves model, endpoint and the fetched model list automatically to disk', async () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'gumi-ai-'));
    const store = new SettingsStore(d, fakeCipher);
    store.loadSync();
    store.update({ ai: { provider: 'openai', profiles: { openai: { model: 'gpt-x', endpoint: 'https://example.com/v1' } } } });
    store.update({ ai: { modelCache: { openai: { ids: ['gpt-x', 'gpt-y'], fetchedAt: 1 } } } });
    await store.flush();
    const again = new SettingsStore(d, fakeCipher);
    again.loadSync();
    expect(again.get().ai.provider).toBe('openai');
    expect(again.get().ai.profiles.openai).toMatchObject({ model: 'gpt-x', endpoint: 'https://example.com/v1' });
    expect(again.get().ai.modelCache.openai.ids).toEqual(['gpt-x', 'gpt-y']);
    expect(again.get().ai.profiles.anthropic.model).toBe('claude-sonnet-5-5');
    rmSync(d, { recursive: true, force: true });
  });

  it('refuses to store keys without secure storage', () => {
    const store = new SettingsStore(dir, { ...fakeCipher, isEncryptionAvailable: () => false });
    expect(() => store.setApiKey('openai', 'k')).toThrow();
  });
});

describe('IPC validation', () => {
  it('has a schema for every channel', () => {
    for (const c of INVOKE_CHANNELS) expect(invokeSchemas[c], c).toBeDefined();
    for (const c of SEND_CHANNELS) expect(sendSchemas[c], c).toBeDefined();
  });

  it('rejects malformed arguments and strips secret fields from patches', () => {
    expect(invokeSchemas['agent:start'].safeParse([{ text: '' }]).success).toBe(false);
    expect(invokeSchemas['agent:approve'].safeParse([{ id: 'nope', approved: true, remember: false }]).success).toBe(false);
    expect(sendSchemas['character:bubble'].safeParse({ action: 'delete' }).success).toBe(false);
    const p = settingsPatchSchema.parse({ apiKeys: { anthropic: true }, appearance: { color: 'black' } });
    expect(p).toEqual({ appearance: { color: 'black' } });
  });
});

describe('HistoryStore', () => {
  it('records tasks and logs, and lists operations', async () => {
    const file = path.join(dir, 'history.json');
    const h = new HistoryStore(file, () => ({ enabled: true, maxTasks: 2 }));
    await h.load();
    h.begin({ id: 't1', text: 'a', status: 'running', startedAt: 1, endedAt: null, provider: 'p', model: 'm', steps: 0, summary: null });
    h.append('t1', { id: 'l1', taskId: 't1', ts: 1, kind: 'action', text: 'click' });
    h.finish('t1', { status: 'completed', endedAt: 2, summary: 'ok', steps: 1 });
    await h.saveNow();
    const h2 = new HistoryStore(file, () => ({ enabled: true, maxTasks: 2 }));
    await h2.load();
    expect(h2.list()[0]).toMatchObject({ id: 't1', status: 'completed', logCount: 1 });
    expect(h2.operations()[0].text).toBe('click');
    await h2.clear();
    expect(h2.list()).toEqual([]);
  });
});

describe('TaskManager', () => {
  function makeManager(turns: ModelTurn[], executor: AgentExecutor) {
    const settings = defaultSettings();
    let released = 0;
    const session: ChatSession = {
      addUser() {},
      addToolResults() {},
      next: async (signal) => {
        await new Promise((r) => setTimeout(r, 5));
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        const t = turns.shift();
        if (!t) throw new Error('none');
        return t;
      },
      pruneImages() {},
    };
    const tm = new TaskManager({
      settings: () => settings,
      providerConfig: () => ({
        provider: 'anthropic',
        model: 'm',
        endpoint: 'https://api.anthropic.com',
        apiKey: 'k',
        maxTokens: 100,
        temperature: null,
        supportsVision: true,
        supportsTools: true,
        maxRetries: 0,
      }),
      agentDeps: { executor, createSession: () => session },
      environment: () => ({ now: new Date(0), os: 'w', displays: '', folders: {} }),
      history: new HistoryStore(path.join(dir, `h-${Math.random()}.json`), () => ({ enabled: false, maxTasks: 10 })),
      releaseInput: () => {
        released++;
        return { keys: 0, buttons: 0 };
      },
    });
    return { tm, released: () => released };
  }

  const exec: AgentExecutor = {
    vision: true,
    prepareTask() {},
    observe: async () => ({ parts: [{ type: 'text', text: 's' }], summary: '', sentImage: false, blocked: null }),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false, summary: 'ok', screenChanged: true }),
  };
  const waitFor = async (tm: TaskManager, pred: (s: AgentStatus) => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (pred(tm.getStatus())) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timeout: ${tm.getStatus().phase}`);
  };

  it('runs a task to completion', async () => {
    const { tm } = makeManager([{ text: '', toolCalls: [{ id: '1', name: 'task_complete', args: { summary: '完了' } }], stopReason: 'tool_use' }], exec);
    expect(() => tm.start('  ')).toThrow();
    tm.start('テスト');
    expect(() => tm.start('二つ目')).toThrow();
    await waitFor(tm, (s) => s.phase === 'completed');
    expect(tm.getStatus().summary).toBe('完了');
  });

  it('waits for approval and continues after the user approves', async () => {
    const { tm } = makeManager(
      [
        { text: '', toolCalls: [{ id: '1', name: 'delete_path', args: { path: 'Desktop\\x' } }], stopReason: 'tool_use' },
        { text: '', toolCalls: [{ id: '2', name: 'task_complete', args: { summary: 'ok' } }], stopReason: 'tool_use' },
      ],
      exec,
    );
    tm.start('削除して');
    await waitFor(tm, (s) => !!s.pendingApproval);
    expect(tm.getStatus().phase).toBe('awaiting-approval');
    tm.respondApproval(tm.getStatus().pendingApproval!.id, true, false);
    await waitFor(tm, (s) => s.phase === 'completed');
  });

  it('pauses, resumes, and stops immediately releasing input', async () => {
    const { tm, released } = makeManager(
      Array.from({ length: 50 }, (_, i) => ({ text: '', toolCalls: [{ id: `${i}`, name: 'wait', args: { seconds: 0.1 + i / 1000 } }], stopReason: 'tool_use' })),
      exec,
    );
    tm.start('長い作業');
    await waitFor(tm, (s) => s.step >= 1);
    expect(tm.pause('テスト')).toBe(true);
    expect(tm.getStatus().phase).toBe('paused');
    const stepAtPause = tm.getStatus().step;
    await new Promise((r) => setTimeout(r, 60));
    expect(tm.getStatus().step).toBeLessThanOrEqual(stepAtPause + 1);
    expect(tm.resume()).toBe(true);
    await waitFor(tm, (s) => s.step > stepAtPause + 1);
    expect(tm.stop()).toBe(true);
    await waitFor(tm, (s) => s.phase === 'stopped');
    expect(released()).toBeGreaterThan(0);
  });
});
