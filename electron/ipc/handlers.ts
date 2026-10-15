/**
 * IPC ハンドラーの登録。
 * - 送信元フレームがアプリ自身のページであることを確認
 * - 引数を zod で検証
 * - 例外は { ok: false, error } として Renderer に返す (スタックトレース等は渡さない)
 */
import { app, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';
import { isAppUrl } from '../main/app-paths';
import { invokeSchemas, sendSchemas } from './schemas';
import type { InvokeEnvelope, InvokeMap, SendMap } from '../../src/types/ipc';
import type { AppServices } from '../main/services';
import type { ProviderId, SettingsPatch } from '../../src/services/settings/schema';
import { listModels, testConnection } from '../../src/services/ai/factory';
import { openSettingsWindow } from '../windows/settings-window';
import { missingPermission, permissionStatus, requestPermission } from '../system/permissions';

type InvokeHandlers = {
  [K in keyof InvokeMap]: (...args: InvokeMap[K]['args']) => Promise<InvokeMap[K]['result']> | InvokeMap[K]['result'];
};
type SendHandlers = { [K in keyof SendMap]: (payload: SendMap[K], event: IpcMainEvent) => void };

function trusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  return isAppUrl(url);
}

export function registerIpc(svc: AppServices): void {
  const handlers: InvokeHandlers = {
    'app:get-initial-state': () => ({
      settings: svc.store.getPublic(),
      agent: svc.tasks.getStatus(),
      character: svc.character.getState(),
      version: app.getVersion(),
      platform: process.platform === 'darwin' ? 'darwin' : 'win32',
      automationAvailable: svc.automation.available,
      automationError: svc.automation.error,
      shortcutErrors: svc.shortcutErrors(),
    }),
    'app:quit': () => {
      setTimeout(() => app.quit(), 50);
    },
    'settings:update': (patch) => {
      svc.store.update(patch as SettingsPatch);
      return svc.store.getPublic();
    },
    'settings:reset': () => {
      svc.store.reset();
      return svc.store.getPublic();
    },
    'settings:set-api-key': ({ provider, key }) => {
      svc.store.setApiKey(provider, key);
      return svc.store.getPublic();
    },
    'settings:clear-api-key': ({ provider }) => {
      svc.store.clearApiKey(provider);
      return svc.store.getPublic();
    },
    'settings:test-connection': async ({ provider }) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60_000);
      try {
        const r = await testConnection(svc.providerConfig(provider as ProviderId), ctrl.signal);
        return { reply: r.reply, ms: r.ms };
      } finally {
        clearTimeout(timer);
      }
    },
    'settings:list-models': async ({ provider }) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      try {
        const models = await listModels(svc.providerConfig(provider as ProviderId), ctrl.signal);
        const sorted = models.sort((a, b) => a.id.localeCompare(b.id)).slice(0, 500);
        // 取得したモデル一覧も保存しておき、次回から候補としてすぐ表示する
        svc.store.update({
          ai: { modelCache: { [provider]: { ids: sorted.map((m) => m.id.slice(0, 200)), fetchedAt: Date.now() } } },
        });
        return sorted;
      } finally {
        clearTimeout(timer);
      }
    },
    'agent:start': ({ text }) => {
      if (!svc.automation.available) {
        throw new Error(`PC 操作エンジンを利用できません: ${svc.automation.error ?? '不明なエラー'}`);
      }
      // macOS: アクセシビリティ / 画面収録 の許可が無いと操作も撮影もできない
      const missing = missingPermission();
      if (missing) throw new Error(missing);
      svc.character.interaction('typing');
      const r = svc.tasks.start(text);
      // 送信できたら入力欄を閉じる (円に収納するアニメーションになる)
      svc.character.closeInput();
      return r;
    },
    'agent:pause': () => svc.tasks.pause(),
    'agent:resume': () => svc.tasks.resume(),
    'agent:stop': () => svc.tasks.stop(),
    'agent:approve': ({ id, approved, remember }) => svc.tasks.respondApproval(id, approved, remember),
    'agent:answer': ({ id, text }) => svc.tasks.answerQuestion(id, text),
    'history:list': () => svc.history.list(),
    'history:get': ({ id }) => svc.history.get(id),
    'history:operations': () => svc.history.operations(),
    'history:clear': async () => {
      await svc.history.clear();
    },
    'window:open-settings': ({ tab }) => {
      openSettingsWindow({ tab });
    },
    'character:move-to-corner': ({ corner }) => svc.character.moveToCorner(corner),
    'character:set-visible': ({ visible }) => svc.character.setVisible(visible),
    'system:permissions': () => permissionStatus(),
    'system:request-permission': ({ kind }) => requestPermission(kind),
  };

  for (const channel of Object.keys(handlers) as (keyof InvokeMap)[]) {
    const schema = invokeSchemas[channel] as z.ZodType;
    ipcMain.handle(channel, async (event, ...args): Promise<InvokeEnvelope<unknown>> => {
      if (!trusted(event)) return { ok: false, error: '不正な送信元です' };
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: `引数が不正です: ${parsed.error.issues.map((i) => i.message).join(', ')}` };
      }
      try {
        const fn = handlers[channel] as (...a: unknown[]) => unknown;
        const data = await fn(...(parsed.data as unknown[]));
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: (err as Error).message || String(err) };
      }
    });
  }

  const sendHandlers: SendHandlers = {
    'character:pointer-down': (_p, event) => {
      if (event.sender.id === svc.character.face.webContents.id) svc.character.pointerDownEvent();
    },
    'character:pointer-up': (_p, event) => {
      if (event.sender.id === svc.character.face.webContents.id) svc.character.pointerUp();
    },
    'character:interaction': ({ kind }) => svc.character.interaction(kind),
    'character:bubble': ({ action }, event) => {
      if (event.sender.id !== svc.character.face.webContents.id) return;
      svc.character.closeBubbles();
      if (action === 'settings') {
        openSettingsWindow();
      } else {
        // 円の上の切り替えは白と黒だけ (亜夢のときは白に戻す。亜夢は設定画面からだけ選べる)
        const color = svc.store.get().appearance.color === 'white' ? 'black' : 'white';
        svc.store.update({ appearance: { color } });
      }
    },
    'character:open-input': (_p, event) => {
      if (event.sender.id === svc.character.face.webContents.id) svc.character.openInput();
    },
    'character:close-input': (_p, event) => {
      if (event.sender.id === svc.character.face.webContents.id) svc.character.closeInput();
    },
    'character:dismiss-result': (_p, event) => {
      if (event.sender.id === svc.character.face.webContents.id) svc.character.dismissResult();
    },
    'character:result-size': ({ height }, event) => {
      if (event.sender.id === svc.character.face.webContents.id) svc.character.setResultHeight(height);
    },
  };

  for (const channel of Object.keys(sendHandlers) as (keyof SendMap)[]) {
    const schema = sendSchemas[channel] as z.ZodType;
    ipcMain.on(channel, (event, payload) => {
      if (process.env.GUMI_DEBUG) console.log('[gumi:debug] ipc', channel, JSON.stringify(payload), trusted(event));
      if (!trusted(event)) return;
      const parsed = schema.safeParse(payload ?? {});
      if (!parsed.success) return;
      (sendHandlers[channel] as (p: unknown, e: IpcMainEvent) => void)(parsed.data, event);
    });
  }
}
