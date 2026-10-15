/**
 * macOS 版の PC 操作エンジン (CoreGraphics + アクセシビリティ API) を共通インターフェースにまとめる。
 */
import { isMacAvailable, mac } from './bindings';
import { MacInputController } from './input';
import { AxClient, MacUiDriver } from './ax-client';
import { findWindow, findWindowByTitle, listProcesses, listWindows } from './windows';
import { listApplications, macLauncher } from './apps';
import type { WindowRef } from './ax-core';
import type { Automation, StartApp, WindowDriver, WindowInfo } from '../types';
import { sleep, type SpeedProfile } from '../util';

export interface MacAutomation extends Automation {
  ax: AxClient;
}

export function createMacAutomation(opts: { speed: () => SpeedProfile }): MacAutomation {
  let error: string | null = null;
  const available = isMacAvailable();
  if (!available) {
    try {
      mac();
    } catch (err) {
      error = (err as Error).message;
    }
  }

  const ax = new AxClient();
  /**
   * 最前面のアプリの pid。AX への問い合わせは非同期なので、最後に分かった値を使い、裏で更新する。
   * (ウィンドウ列挙は同期 API のため)
   */
  let frontPid: number | null = null;
  let frontAt = 0;
  const refreshFront = () => {
    if (!available || Date.now() - frontAt < 300) return;
    frontAt = Date.now();
    ax.frontmostPid()
      .then((pid) => {
        frontPid = pid;
      })
      .catch(() => undefined);
  };

  const refOf = (w: WindowInfo): WindowRef => ({ pid: w.pid, windowId: w.hwnd, rect: w.rect, title: w.title });
  const mustFind = (id: number): WindowInfo => {
    const w = findWindow(id);
    if (!w) throw new Error(`ウィンドウ (id=${id}) は存在しないか、画面に表示されていません`);
    return w;
  };

  const windows: WindowDriver = {
    list: (exclude) => {
      refreshFront();
      return listWindows(exclude, frontPid);
    },
    foreground: (exclude = []) => {
      refreshFront();
      const fg = listWindows(exclude, frontPid).find((w) => w.foreground) ?? null;
      return fg;
    },
    pidOf: (id) => mustFind(id).pid,
    titleOf: (id) => findWindow(id)?.title ?? '',
    findByTitle: (q, exclude) => findWindowByTitle(q, exclude, frontPid),
    focus: async (id) => {
      const w = mustFind(id);
      await ax.focusWindow(refOf(w));
      await sleep(120);
      const pid = await ax.frontmostPid().catch(() => null);
      frontPid = pid;
      frontAt = Date.now();
      return pid === w.pid;
    },
    action: async (id, action) => {
      await ax.windowAction(refOf(mustFind(id)), action);
    },
    setBounds: async (id, bounds) => {
      await ax.setBounds(refOf(mustFind(id)), bounds);
    },
    activateApp: (pid) => ax.activateApp(pid),
    sync: async () => {
      if (!available) return;
      frontPid = await ax.frontmostPid().catch(() => frontPid);
      frontAt = Date.now();
    },
  };

  let appsCache: { at: number; apps: StartApp[] } | null = null;
  const apps = async (): Promise<StartApp[]> => {
    if (appsCache && Date.now() - appsCache.at < 5 * 60_000) return appsCache.apps;
    const list = await listApplications();
    appsCache = { at: Date.now(), apps: list };
    return list;
  };

  const ui = new MacUiDriver(
    ax,
    (id) => {
      const w = id !== undefined ? findWindow(id) : windows.foreground([process.pid]);
      return w ? refOf(w) : null;
    },
    apps,
  );

  refreshFront();
  return {
    platform: 'darwin',
    available,
    error,
    input: new MacInputController(opts.speed),
    windows,
    processes: { list: () => listProcesses() },
    ui,
    apps: macLauncher,
    ax,
  };
}
