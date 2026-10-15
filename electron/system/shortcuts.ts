/**
 * グローバルショートカット (緊急停止 / 一時停止・再開)。
 * どのアプリがアクティブでも効くため、AI が意図しない操作を始めてもすぐに止められる。
 */
import { globalShortcut } from 'electron';

export interface ShortcutConfig {
  stop: string;
  pause: string;
}

export class ShortcutManager {
  private errors: string[] = [];
  private current: ShortcutConfig | null = null;

  constructor(private readonly handlers: { stop: () => void; togglePause: () => void }) {}

  apply(cfg: ShortcutConfig): void {
    if (this.current && this.current.stop === cfg.stop && this.current.pause === cfg.pause) return;
    globalShortcut.unregisterAll();
    this.errors = [];
    this.current = cfg;
    this.register(cfg.stop, '緊急停止', this.handlers.stop);
    if (cfg.pause && cfg.pause !== cfg.stop) this.register(cfg.pause, '一時停止/再開', this.handlers.togglePause);
  }

  private register(accel: string, label: string, fn: () => void) {
    if (!accel) return;
    try {
      const ok = globalShortcut.register(accel, fn);
      if (!ok) this.errors.push(`${label} のショートカット「${accel}」は他のアプリが使用中のため登録できませんでした`);
    } catch (err) {
      this.errors.push(`${label} のショートカット「${accel}」が不正です: ${(err as Error).message}`);
    }
  }

  getErrors(): string[] {
    return [...this.errors];
  }

  dispose(): void {
    globalShortcut.unregisterAll();
  }
}
