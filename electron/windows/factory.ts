import { app, BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';
import { DEV_SERVER_URL, preloadPath, rendererIndexPath } from '../main/app-paths';
import { SECURE_WEB_PREFERENCES } from '../main/security';

export type PageName = 'face' | 'settings' | 'cursor';

export function createAppWindow(page: PageName, options: BrowserWindowConstructorOptions): BrowserWindow {
  const win = new BrowserWindow({
    ...options,
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      preload: preloadPath(),
      devTools: !app.isPackaged,
      backgroundThrottling: page === 'settings',
      ...options.webPreferences,
    },
  });
  if (DEV_SERVER_URL) {
    void win.loadURL(`${DEV_SERVER_URL.replace(/\/$/, '')}/#${page}`);
  } else {
    void win.loadFile(rendererIndexPath(), { hash: page });
  }
  return win;
}
