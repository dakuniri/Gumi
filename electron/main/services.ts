/**
 * Main Process のサービス群を生成して結線する。
 */
import { app, clipboard, safeStorage, shell, BrowserWindow, Notification } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore } from '../../src/services/settings/store';
import type { ProviderId, Settings } from '../../src/services/settings/schema';
import { HistoryStore } from '../../src/services/tasks/history-store';
import { TaskManager } from '../../src/services/tasks/task-manager';
import { createAutomation } from '../../src/services/automation';
import type { Automation } from '../../src/services/automation/types';
import { ComputerUseExecutor } from '../../src/services/computer-use/executor';
import { captureScreen, listDisplays } from '../../src/services/screenshots/capture';
import { defaultProtectedRoots, type KnownFolders } from '../../src/services/automation/files';
import { SPEED_PROFILES } from '../../src/services/automation/util';
import { createSession } from '../../src/services/ai/factory';
import type { ProviderConfig } from '../../src/services/ai/types';
import type { AgentStatus, LogEntry } from '../../src/types/agent';
import { isBusyPhase } from '../../src/types/agent';
import { AiCursorOverlay } from '../windows/cursor-overlay';
import { CharacterController } from '../windows/character-controller';

export interface AppServices {
  store: SettingsStore;
  history: HistoryStore;
  tasks: TaskManager;
  executor: ComputerUseExecutor;
  character: CharacterController;
  aiCursor: AiCursorOverlay;
  /** OS ごとの PC 操作エンジン */
  automation: Automation;
  providerConfig: (provider?: ProviderId) => ProviderConfig;
  shortcutErrors: () => string[];
  broadcast: (channel: string, payload: unknown) => void;
}

export function knownFolders(): KnownFolders {
  return {
    home: app.getPath('home'),
    desktop: app.getPath('desktop'),
    documents: app.getPath('documents'),
    downloads: app.getPath('downloads'),
    pictures: app.getPath('pictures'),
    music: app.getPath('music'),
    videos: app.getPath('videos'),
  };
}

export async function createServices(shortcutErrors: () => string[]): Promise<AppServices> {
  const userData = app.getPath('userData');
  const store = new SettingsStore(userData, safeStorage);
  store.loadSync();

  const history = new HistoryStore(path.join(userData, 'history.json'), () => store.get().history);
  await history.load();

  // ---- PC 操作エンジン ----
  const automation = createAutomation({
    speed: () => SPEED_PROFILES[store.get().agent.speed],
    workDir: path.join(userData, 'runtime'),
  });
  const { available, input } = automation;

  const services = {} as AppServices;

  const character: CharacterController = new CharacterController({
    store,
    agentStatus: (): AgentStatus => tasks.getStatus(),
    isLeftButtonDown: () => {
      if (!available) return null;
      try {
        return input.isMouseButtonDown('left');
      } catch {
        return null;
      }
    },
    focusReturn: process.platform === 'darwin' && available ? focusReturn(automation) : undefined,
  });

  // AI が動かしているカーソルの位置に「<」の形のカーソルを表示する
  const aiCursor = new AiCursorOverlay();

  // 入力注入中は Gumi のウィンドウをクリック透過にする (AI のクリックが Gumi に当たらないように)
  input.hooks = {
    before: () => character.setInjecting(true),
    after: () => character.setInjecting(false),
    moved: (p) => {
      if (isBusyPhase(tasks.getStatus().phase)) aiCursor.moveToScreen(p);
    },
  };

  const executor: ComputerUseExecutor = new ComputerUseExecutor({
    automation,
    settings: () => store.get(),
    clipboard: { readText: () => clipboard.readText(), writeText: (t) => clipboard.writeText(t) },
    shell: {
      openPath: (p) => shell.openPath(p),
      openExternal: (url) => shell.openExternal(url),
      trashItem: (p) => shell.trashItem(p),
    },
    knownFolders: knownFolders(),
    protectedRoots: [
      ...defaultProtectedRoots(),
      path.normalize(userData),
      path.normalize(appBundleRoot()),
    ],
    excludePids: [process.pid],
    displays: () => listDisplays(),
    capture: (opts) => captureScreen(opts),
    gumi: {
      excludeFromCapture: async (): Promise<void> => {
        aiCursor.setCaptureExcluded(true);
        character.excludeFromCapture();
        // 反映は即時だが、念のため 1 フレーム待つ
        await new Promise((r) => setTimeout(r, 16));
      },
      includeInCapture: () => {
        aiCursor.setCaptureExcluded(false);
        character.includeInCapture();
      },
    },
  });

  const providerConfig = (provider?: ProviderId): ProviderConfig => {
    const s = store.get();
    const id = provider ?? s.ai.provider;
    const profile = s.ai.profiles[id];
    return {
      provider: id,
      model: profile.model,
      endpoint: profile.endpoint,
      apiKey: store.getApiKey(id),
      maxTokens: profile.maxTokens,
      temperature: profile.temperature,
      supportsVision: profile.supportsVision,
      supportsTools: profile.supportsTools,
      maxRetries: s.agent.autoRetry ? s.agent.maxApiRetries : 0,
    };
  };

  const tasks: TaskManager = new TaskManager({
    settings: () => store.get(),
    providerConfig: () => providerConfig(),
    agentDeps: { executor, createSession },
    environment: () => {
      const displays = listDisplays();
      return {
        now: new Date(),
        os: osLabel(),
        displays: displays
          .map((d) => `#${d.index}${d.primary ? ' primary' : ''} ${d.physical.width}x${d.physical.height} @${Math.round(d.scaleFactor * 100)}%`)
          .join(', '),
        folders: { ...knownFolders() },
      };
    },
    history,
    releaseInput: () => (available ? input.releaseAll() : { keys: 0, buttons: 0 }),
  });

  const broadcast = (channel: string, payload: unknown) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  };

  Object.assign(services, {
    store,
    history,
    tasks,
    executor,
    character,
    aiCursor,
    automation,
    providerConfig,
    shortcutErrors,
    broadcast,
  } satisfies AppServices);

  // ---- イベント結線 ----
  let prevPhase: AgentStatus['phase'] = 'idle';
  tasks.on('status', (st: AgentStatus) => {
    broadcast('agent:status', st);
    if (!isBusyPhase(st.phase)) aiCursor.hide();
    if (st.phase !== prevPhase) {
      const ended = st.phase === 'completed' || st.phase === 'failed' || st.phase === 'stopped';
      // 円が見えているときは円のチェックマーク等で伝わるので、非表示のときだけ通知する
      if (ended && !store.get().character.visible) notifyTaskEnd(st);
      if (st.phase === 'thinking' && prevPhase === 'idle') character.interaction('typing');
      prevPhase = st.phase;
    }
  });
  tasks.on('log', (entry: LogEntry) => broadcast('agent:log', entry));

  store.on('changed', (s: Settings) => {
    aiCursor.setEnabled(s.appearance.aiCursor);
    broadcast('settings:changed', store.getPublic());
  });

  return services;
}

/** macOS: 入力欄を開く前に前面だったアプリへ、閉じた後にフォーカスを戻す */
function focusReturn(automation: Automation): { remember(): void; restore(): void } {
  let pid: number | null = null;
  return {
    remember: () => {
      try {
        // 手前から並んでいるので、Gumi 以外で一番手前のウィンドウのアプリ
        pid = automation.windows.list([process.pid])[0]?.pid ?? null;
      } catch {
        pid = null;
      }
    },
    restore: () => {
      const target = pid;
      pid = null;
      if (target) void automation.windows.activateApp?.(target).catch(() => undefined);
    },
  };
}

function osLabel(): string {
  const ver = process.getSystemVersion();
  if (process.platform === 'darwin') return `macOS ${ver} (${os.arch()})`;
  return `Windows ${ver} (${os.arch()})`;
}

/** アプリ本体の場所 (操作対象から保護する)。macOS は .app バンドル全体 */
function appBundleRoot(): string {
  const exeDir = path.dirname(process.execPath);
  if (process.platform === 'darwin') {
    const i = exeDir.indexOf('.app/');
    if (i >= 0) return exeDir.slice(0, i + 4);
  }
  return exeDir;
}

function notifyTaskEnd(st: AgentStatus) {
  if (!Notification.isSupported()) return;
  const title = st.phase === 'completed' ? 'Gumi: タスク完了' : st.phase === 'stopped' ? 'Gumi: タスクを停止しました' : 'Gumi: タスクを完了できませんでした';
  try {
    new Notification({ title, body: (st.summary ?? '').slice(0, 200), silent: st.phase === 'stopped' }).show();
  } catch {
    /* 通知不可 */
  }
}
