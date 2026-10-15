import { BrowserWindow } from 'electron';
import { createAppWindow } from './factory';

let win: BrowserWindow | null = null;

export function openSettingsWindow(opts: { tab?: string } = {}): BrowserWindow {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (opts.tab) win.webContents.send('settings:navigate', { tab: opts.tab });
    return win;
  }
  win = createAppWindow('settings', {
    width: 940,
    height: 700,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Gumi 設定',
    autoHideMenuBar: true,
    backgroundColor: '#F6F7F9',
  });
  win.setMenu(null);
  win.once('ready-to-show', () => {
    win?.show();
    if (opts.tab) win?.webContents.send('settings:navigate', { tab: opts.tab });
  });
  win.on('closed', () => {
    win = null;
  });
  return win;
}
