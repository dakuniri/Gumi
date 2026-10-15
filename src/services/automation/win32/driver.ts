/**
 * Windows 版の PC 操作エンジン (Win32 + UI Automation) を共通インターフェースにまとめる。
 */
import { isWin32Available, win32 } from './bindings';
import { InputController } from './input';
import * as win from './windows';
import { listProcesses } from './processes';
import { UiaClient } from '../uia/uia-client';
import { windowsLauncher } from '../apps';
import { resolveKey } from '../keys';
import type { Automation, InputDriver, WindowDriver } from '../types';
import type { SpeedProfile } from '../util';

export const windowsWindows: WindowDriver = {
  list: (exclude) => win.listWindows(exclude),
  foreground: (exclude = []) => {
    const w = win.getForegroundWindow();
    return w && !exclude.includes(w.pid) ? w : null;
  },
  pidOf: (id) => win.getWindowPid(id).pid,
  titleOf: (id) => win.getWindowTitle(id),
  findByTitle: (q, exclude) => win.findWindowByTitle(q, exclude),
  focus: (id, input: InputDriver) => win.focusWindow(id, () => input.pressCombo([resolveKey('alt', 'win32')])),
  action: async (id, action) => {
    if (action === 'minimize') win.minimizeWindow(id);
    else if (action === 'maximize') win.maximizeWindow(id);
    else if (action === 'restore') win.restoreWindow(id);
    else win.closeWindow(id);
  },
  setBounds: async (id, bounds) => win.setWindowBounds(id, bounds),
};

export function createWindowsAutomation(opts: { speed: () => SpeedProfile; workDir: string }): Automation {
  let error: string | null = null;
  const available = isWin32Available();
  if (!available) {
    try {
      win32();
    } catch (err) {
      error = (err as Error).message;
    }
  }
  return {
    platform: 'win32',
    available,
    error,
    input: new InputController(opts.speed),
    windows: windowsWindows,
    processes: { list: () => listProcesses() },
    ui: new UiaClient(opts.workDir),
    apps: windowsLauncher,
  };
}
