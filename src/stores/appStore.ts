/**
 * Renderer 全体で共有する状態。Main Process からのイベントで更新される。
 */
import { createStore } from './createStore';
import type { PublicSettings, SettingsPatch } from '../services/settings/schema';
import type { AgentStatus, LogEntry } from '../types/agent';
import { idleStatus } from '../types/agent';
import type { CharacterState } from '../types/character';
import type { InitialState } from '../types/ipc';
import { gumi } from '../services/bridge';

export interface AppState {
  ready: boolean;
  settings: PublicSettings | null;
  agent: AgentStatus;
  character: CharacterState | null;
  /** 現在 (直近) のタスクのログ */
  logs: LogEntry[];
  version: string;
  platform: 'win32' | 'darwin';
  automationAvailable: boolean;
  automationError: string | null;
  shortcutErrors: string[];
  lastError: string | null;
}

export const appStore = createStore<AppState>({
  ready: false,
  settings: null,
  agent: idleStatus(),
  character: null,
  logs: [],
  version: '',
  platform: 'win32',
  automationAvailable: true,
  automationError: null,
  shortcutErrors: [],
  lastError: null,
});

let started = false;

export async function bootstrap(): Promise<void> {
  if (started) return;
  started = true;
  const api = gumi();
  api.on('settings:changed', (settings) => appStore.set({ settings }));
  api.on('agent:status', (agent) => {
    appStore.set((prev) => {
      const newTask = agent.task && agent.task.id !== prev.agent.task?.id;
      return { agent, logs: newTask ? [] : prev.logs };
    });
  });
  api.on('agent:log', (entry) => {
    appStore.set((prev) => {
      const last = prev.logs[prev.logs.length - 1];
      // 別タスクのログが届いたら切り替える
      const logs = last && last.taskId !== entry.taskId ? [entry] : [...prev.logs, entry].slice(-400);
      return { logs };
    });
  });
  api.on('character:state', (character) => appStore.set({ character }));

  const init: InitialState = await api.invoke('app:get-initial-state');
  appStore.set({
    ready: true,
    settings: init.settings,
    agent: init.agent,
    character: init.character,
    version: init.version,
    platform: init.platform,
    automationAvailable: init.automationAvailable,
    automationError: init.automationError,
    shortcutErrors: init.shortcutErrors,
  });
  if (init.agent.task) {
    // 実行中タスクのログを履歴から復元
    try {
      const rec = await api.invoke('history:get', { id: init.agent.task.id });
      if (rec) appStore.set({ logs: rec.log.slice(-400) });
    } catch {
      /* ignore */
    }
  }
}

/** 設定を部分更新 (失敗時は lastError に格納) */
export async function updateSettings(patch: SettingsPatch): Promise<void> {
  try {
    const settings = await gumi().invoke('settings:update', patch);
    appStore.set({ settings, lastError: null });
  } catch (err) {
    appStore.set({ lastError: (err as Error).message });
  }
}

export async function call<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const r = await fn();
    appStore.set({ lastError: null });
    return r;
  } catch (err) {
    appStore.set({ lastError: (err as Error).message });
    return undefined;
  }
}
