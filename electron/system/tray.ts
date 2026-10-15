/**
 * タスクトレイ常駐アイコン。
 * Gumi が動作中であることを常に可視化し (秘密裏に動作しない)、停止・設定・終了へすぐアクセスできるようにする。
 */
import { Menu, Tray, nativeImage, app } from 'electron';
import { assetPath } from '../main/app-paths';
import type { AgentStatus } from '../../src/types/agent';
import { isBusyPhase } from '../../src/types/agent';

export interface TrayHandlers {
  openInput: () => void;
  openSettings: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  toggleVisible: () => void;
  isVisible: () => boolean;
  quit: () => void;
}

export class GumiTray {
  private tray: Tray | null = null;
  private status: AgentStatus | null = null;

  constructor(private readonly handlers: TrayHandlers) {}

  create(): void {
    let icon = nativeImage.createFromPath(assetPath('icons', 'tray.png'));
    if (process.platform === 'darwin' && !icon.isEmpty()) {
      // メニューバー用: 小さくしてテンプレート画像にする (明るい / 暗いメニューバーに合わせて色が変わる)
      icon = icon.resize({ width: 18, height: 18, quality: 'best' });
      icon.setTemplateImage(true);
    }
    this.tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    this.tray.setToolTip('Gumi');
    this.tray.on('click', () => this.handlers.openInput());
    this.refresh();
  }

  update(status: AgentStatus): void {
    this.status = status;
    this.refresh();
  }

  refresh(): void {
    if (!this.tray) return;
    const st = this.status;
    const busy = !!st && isBusyPhase(st.phase);
    const paused = st?.phase === 'paused';
    const label = !st || st.phase === 'idle' ? '待機中' : busy ? (paused ? '一時停止中' : '作業中') : '待機中';
    // 作業中は、AI に送信している内容の概要と予約クリックの件数も表示する (Windows の上限 127 文字)
    const lines = [`Gumi - ${label}${busy && st?.task ? `: ${st.task.text.slice(0, 30)}` : ''}`];
    if (busy && st?.lastTransmission) lines.push(st.lastTransmission);
    if (busy && st && st.scheduled.length) lines.push(`クリック予約 ${st.scheduled.length} 件`);
    this.tray.setToolTip(lines.join('\n').slice(0, 127));
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Gumi ${app.getVersion()} — ${label}`, enabled: false },
        { type: 'separator' },
        { label: '指示を入力', click: () => this.handlers.openInput() },
        paused
          ? { label: '再開', click: () => this.handlers.resume() }
          : { label: '一時停止', enabled: busy, click: () => this.handlers.pause() },
        { label: 'タスクを停止', enabled: busy, click: () => this.handlers.stop() },
        { type: 'separator' },
        {
          label: 'キャラクターを表示',
          type: 'checkbox',
          checked: this.handlers.isVisible(),
          click: () => this.handlers.toggleVisible(),
        },
        { label: '設定…', click: () => this.handlers.openSettings() },
        { type: 'separator' },
        { label: 'Gumi を終了', click: () => this.handlers.quit() },
      ]),
    );
  }

  dispose(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
