/**
 * Gumi — Electron Main Process エントリーポイント。
 */
import { app, dialog } from 'electron';
import path from 'node:path';
import { hardenApp, hardenSession } from './security';
import { createServices, type AppServices } from './services';
import { registerIpc } from '../ipc/handlers';
import { ShortcutManager } from '../system/shortcuts';
import { GumiTray } from '../system/tray';
import { UserActivityMonitor } from '../system/user-activity';
import { applyLaunchAtLogin } from '../system/autostart';
import { openSettingsWindow } from '../windows/settings-window';
import type { Settings } from '../../src/services/settings/schema';
import { isBusyPhase } from '../../src/types/agent';

app.setAppUserModelId('com.gumi.desktop');

// 設定・API キー・履歴の保存先を %APPDATA%\Gumi に固定する。
// アプリ名やバージョンが変わっても同じ場所を使うので、アップデートしても消えない
// (インストーラーはアンインストール時も AppData を削除しない設定)。
app.setPath('userData', path.join(app.getPath('appData'), 'Gumi'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let services: AppServices | null = null;
  let quitting = false;

  app.on('second-instance', () => {
    services?.character.openInput();
  });

  hardenApp();

  app.on('render-process-gone', (_e, wc, details) => {
    console.error(`[gumi] renderer gone (${wc.getURL()}): ${details.reason} exit=${details.exitCode}`);
  });
  app.on('child-process-gone', (_e, details) => {
    console.error(`[gumi] child process gone: ${details.type} ${details.reason} exit=${details.exitCode}`);
  });

  app.whenReady().then(async () => {
    hardenSession();
    // macOS: Dock にアイコンを出さない (メニューバーのアイコンと円だけで使う。パッケージ版は LSUIElement でも指定)
    if (process.platform === 'darwin') app.dock?.hide();
    const shortcuts = new ShortcutManager({
      stop: () => services?.tasks.stop(),
      togglePause: () => {
        if (!services) return;
        if (services.tasks.isPaused()) services.tasks.resume();
        else services.tasks.pause('ショートカットで一時停止しました');
      },
    });

    try {
      services = await createServices(() => shortcuts.getErrors());
    } catch (err) {
      dialog.showErrorBox('Gumi を起動できませんでした', String((err as Error)?.stack ?? err));
      app.quit();
      return;
    }
    const svc = services;

    registerIpc(svc);
    svc.character.create();
    svc.aiCursor.create();
    svc.aiCursor.setEnabled(svc.store.get().appearance.aiCursor);

    const applySystemSettings = (s: Settings, prev?: Settings) => {
      shortcuts.apply({ stop: s.system.emergencyStopShortcut, pause: s.system.pauseShortcut });
      if (!prev || prev.system.launchAtLogin !== s.system.launchAtLogin) {
        const err = applyLaunchAtLogin(s.system.launchAtLogin);
        if (err) console.warn('[gumi] auto-start:', err);
      }
    };
    applySystemSettings(svc.store.get());

    // ---- 円のクリック: 円の横に入力欄を開閉 (作業中は円の上のボタンで一時停止・停止) ----
    svc.character.on('click', () => {
      if (!isBusyPhase(svc.tasks.getStatus().phase)) svc.character.toggleInput();
    });

    // ---- トレイ ----
    const tray = new GumiTray({
      openInput: () => svc.character.openInput(),
      openSettings: () => openSettingsWindow(),
      pause: () => svc.tasks.pause(),
      resume: () => svc.tasks.resume(),
      stop: () => svc.tasks.stop(),
      toggleVisible: () => svc.character.setVisible(!svc.store.get().character.visible),
      isVisible: () => svc.store.get().character.visible,
      quit: () => app.quit(),
    });
    tray.create();
    svc.tasks.on('status', (st) => tray.update(st));

    svc.store.on('changed', (s: Settings, prev: Settings) => {
      svc.character.applyWindowSettings(prev);
      applySystemSettings(s, prev);
      tray.refresh();
    });

    // ---- ユーザー操作の検知で自動一時停止 ----
    if (svc.automation.available) {
      const monitor = new UserActivityMonitor({
        input: svc.automation.input,
        // AI が実際にマウス / キーボードを操作している間だけ監視する (考えている間は止めない)
        shouldWatch: () => svc.store.get().agent.pauseOnUserInput && svc.tasks.getStatus().phase === 'acting',
        isGumiInteraction: () => svc.character.cursorOverGumi() || svc.character.isFocused(),
        onUserInput: () => {
          // 円の上の一時停止ボタンが「再開」に変わる (パネルなどは出さない)
          svc.tasks.pause('あなたの操作を検出したため一時停止しました');
        },
      });
      monitor.start();
      app.on('will-quit', () => monitor.stop());
    }

    if (!svc.automation.available) {
      console.warn('[gumi] automation unavailable:', svc.automation.error);
    }

    app.on('before-quit', (e) => {
      if (quitting) return;
      quitting = true;
      e.preventDefault();
      void (async () => {
        try {
          await svc.tasks.shutdown();
          await svc.store.flush();
        } finally {
          svc.automation.ui.dispose();
          svc.character.dispose();
          shortcuts.dispose();
          tray.dispose();
          app.exit(0);
        }
      })();
    });
  });

  // 常駐アプリなので、設定ウィンドウを閉じても終了しない
  app.on('window-all-closed', () => {
    /* keep running (tray) */
  });
}
