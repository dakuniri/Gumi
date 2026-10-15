/**
 * AI が操作しているカーソルの位置に「<」の形 (先端が左上) のカーソルを表示するオーバーレイ。
 * - クリック透過・フォーカスしない小さな透明ウィンドウ
 * - 操作エンジンがカーソルを動かすたびに追従する (Windows は物理座標 -> DIP に変換、macOS はポイントのまま)
 * - タスク中だけ表示し、AI が画面を撮影する間はキャプチャから除外する (画面上では消えない)
 */
import { BrowserWindow, screen } from 'electron';
import type { Point } from '../../src/types/character';
import { CURSOR_HOTSPOT, CURSOR_WINDOW } from '../../src/services/layout/ai-cursor';
import { createAppWindow } from './factory';

export class AiCursorOverlay {
  private win: BrowserWindow | null = null;
  private shown = false;
  private enabled = true;

  create(): void {
    this.win = createAppWindow('cursor', {
      width: CURSOR_WINDOW,
      height: CURSOR_WINDOW,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      thickFrame: false,
      show: false,
      backgroundColor: '#00000000',
      title: 'Gumi AI カーソル',
    });
    this.win.setIgnoreMouseEvents(true);
    this.win.setAlwaysOnTop(true, 'screen-saver');
    if (process.platform === 'darwin') this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.hide();
  }

  /** AI がカーソルを動かした位置 (入力座標系: Windows は物理ピクセル、macOS はポイント) */
  moveToScreen(p: Point): void {
    const w = this.win;
    if (!w || w.isDestroyed() || !this.enabled) return;
    const dip = process.platform === 'win32' ? screen.screenToDipPoint(p) : p;
    w.setPosition(Math.round(dip.x - CURSOR_HOTSPOT.x), Math.round(dip.y - CURSOR_HOTSPOT.y));
    if (!this.shown) {
      this.shown = true;
      w.showInactive();
      w.moveTop();
    }
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed() && this.shown) this.win.hide();
    this.shown = false;
  }

  /** AI の撮影中だけキャプチャ対象から外す (画面上では表示されたまま) */
  setCaptureExcluded(excluded: boolean): void {
    if (this.win && !this.win.isDestroyed()) this.win.setContentProtection(excluded);
  }

  isOwnWindow(id: number): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.webContents.id === id;
  }
}
