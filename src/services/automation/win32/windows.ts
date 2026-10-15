/**
 * ウィンドウ列挙・アクティブ化・移動・サイズ変更・最小化/最大化・終了。
 * 座標は物理ピクセル。
 */
import {
  win32,
  readWideString,
  DWMWA_CLOAKED,
  DWMWA_EXTENDED_FRAME_BOUNDS,
  GWL_EXSTYLE,
  GW_OWNER,
  SW_MAXIMIZE,
  SW_MINIMIZE,
  SW_RESTORE,
  SW_SHOW,
  SWP_NOACTIVATE,
  SWP_NOSIZE,
  SWP_NOZORDER,
  WM_CLOSE,
  WS_EX_TOOLWINDOW,
} from './bindings';
import { getProcessName } from './processes';
import type { Rect } from '../../../types/character';
import type { WindowInfo } from '../types';
import { sleep } from '../util';

export type { WindowInfo };

export function getWindowTitle(hwnd: number): string {
  const api = win32();
  const len = api.GetWindowTextLengthW(hwnd);
  if (len <= 0) return '';
  const buf = Buffer.alloc((len + 2) * 2);
  const n = api.GetWindowTextW(hwnd, buf, len + 1);
  return readWideString(buf, n);
}

export function getClassName(hwnd: number): string {
  const buf = Buffer.alloc(512);
  const n = win32().GetClassNameW(hwnd, buf, 256);
  return readWideString(buf, n);
}

export function getWindowPid(hwnd: number): { pid: number; threadId: number } {
  const buf = Buffer.alloc(4);
  const threadId = win32().GetWindowThreadProcessId(hwnd, buf);
  return { pid: buf.readUInt32LE(0), threadId };
}

function readRect(buf: Buffer): Rect {
  const left = buf.readInt32LE(0);
  const top = buf.readInt32LE(4);
  const right = buf.readInt32LE(8);
  const bottom = buf.readInt32LE(12);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 影を除いた見た目どおりのウィンドウ矩形 (DWM 拡張フレーム) */
export function getWindowRect(hwnd: number): Rect {
  const api = win32();
  const buf = Buffer.alloc(16);
  if (api.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, buf, 16) === 0) return readRect(buf);
  if (api.GetWindowRect(hwnd, buf)) return readRect(buf);
  throw new Error('ウィンドウ矩形を取得できませんでした');
}

function isCloaked(hwnd: number): boolean {
  const buf = Buffer.alloc(4);
  if (win32().DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, buf, 4) !== 0) return false;
  return buf.readUInt32LE(0) !== 0;
}

/** Alt+Tab に現れるような通常のトップレベルウィンドウか */
function isAppWindow(hwnd: number): boolean {
  const api = win32();
  if (!api.IsWindowVisible(hwnd)) return false;
  if (isCloaked(hwnd)) return false;
  const ex = api.GetWindowLongW(hwnd, GWL_EXSTYLE);
  if (ex & WS_EX_TOOLWINDOW) return false;
  if (api.GetWindow(hwnd, GW_OWNER) !== 0) return false;
  return api.GetWindowTextLengthW(hwnd) > 0;
}

export function describeWindow(hwnd: number, fg = win32().GetForegroundWindow()): WindowInfo {
  const api = win32();
  const { pid } = getWindowPid(hwnd);
  return {
    hwnd,
    title: getWindowTitle(hwnd),
    className: getClassName(hwnd),
    pid,
    processName: getProcessName(pid) ?? '',
    rect: getWindowRect(hwnd),
    minimized: api.IsIconic(hwnd) !== 0,
    maximized: api.IsZoomed(hwnd) !== 0,
    foreground: hwnd === fg,
    responding: api.IsHungAppWindow(hwnd) === 0,
  };
}

/**
 * 表示中のアプリケーションウィンドウを Z オーダー順 (手前から) に列挙する。
 * @param excludePids 除外するプロセス ID (Gumi 自身など)
 */
export function listWindows(excludePids: number[] = []): WindowInfo[] {
  const api = win32();
  const handles: number[] = [];
  api.EnumWindows((hwnd) => {
    handles.push(hwnd);
    return 1;
  }, 0);
  const fg = api.GetForegroundWindow();
  const out: WindowInfo[] = [];
  for (const h of handles) {
    try {
      if (!isAppWindow(h)) continue;
      const info = describeWindow(h, fg);
      if (excludePids.includes(info.pid)) continue;
      out.push(info);
    } catch {
      /* 列挙中に閉じたウィンドウは無視 */
    }
  }
  return out;
}

export function getForegroundWindow(): WindowInfo | null {
  const h = win32().GetForegroundWindow();
  if (!h) return null;
  try {
    return describeWindow(h, h);
  } catch {
    return null;
  }
}

export function assertWindow(hwnd: number): void {
  if (!win32().IsWindow(hwnd)) throw new Error(`ウィンドウ (hwnd=${hwnd}) は存在しません`);
}

/**
 * ウィンドウを前面に出してアクティブにする。
 * Windows のフォアグラウンドロック制限を回避するため、入力スレッドを一時的に接続する。
 */
export async function focusWindow(hwnd: number, pressAlt?: () => Promise<void>): Promise<boolean> {
  const api = win32();
  assertWindow(hwnd);
  if (api.IsIconic(hwnd)) api.ShowWindow(hwnd, SW_RESTORE);
  else api.ShowWindow(hwnd, SW_SHOW);

  if (api.SetForegroundWindow(hwnd) && api.GetForegroundWindow() === hwnd) return true;

  // Alt キーを送るとフォアグラウンド変更が許可される
  if (pressAlt) {
    await pressAlt();
    if (api.SetForegroundWindow(hwnd) && api.GetForegroundWindow() === hwnd) return true;
  }

  const fg = api.GetForegroundWindow();
  const fgThread = fg ? getWindowPid(fg).threadId : 0;
  const cur = api.GetCurrentThreadId();
  const target = getWindowPid(hwnd).threadId;
  try {
    if (fgThread && fgThread !== cur) api.AttachThreadInput(cur, fgThread, 1);
    if (target && target !== cur) api.AttachThreadInput(cur, target, 1);
    api.BringWindowToTop(hwnd);
    api.SetForegroundWindow(hwnd);
  } finally {
    if (fgThread && fgThread !== cur) api.AttachThreadInput(cur, fgThread, 0);
    if (target && target !== cur) api.AttachThreadInput(cur, target, 0);
  }
  await sleep(50);
  return api.GetForegroundWindow() === hwnd;
}

export function minimizeWindow(hwnd: number) {
  assertWindow(hwnd);
  win32().ShowWindow(hwnd, SW_MINIMIZE);
}

export function maximizeWindow(hwnd: number) {
  assertWindow(hwnd);
  win32().ShowWindow(hwnd, SW_MAXIMIZE);
}

export function restoreWindow(hwnd: number) {
  assertWindow(hwnd);
  win32().ShowWindow(hwnd, SW_RESTORE);
}

/** WM_CLOSE を送る (アプリ側が保存確認ダイアログを出す場合がある) */
export function closeWindow(hwnd: number) {
  assertWindow(hwnd);
  if (!win32().PostMessageW(hwnd, WM_CLOSE, 0, 0)) throw new Error('ウィンドウへ終了要求を送れませんでした');
}

/**
 * ウィンドウを移動 / サイズ変更する。width/height 省略時は移動のみ。
 * DWM の不可視枠を考慮し、見た目の矩形が指定値になるよう補正する。
 */
export function setWindowBounds(hwnd: number, bounds: { x: number; y: number; width?: number; height?: number }) {
  const api = win32();
  assertWindow(hwnd);
  if (api.IsZoomed(hwnd) || api.IsIconic(hwnd)) api.ShowWindow(hwnd, SW_RESTORE);
  const outer = Buffer.alloc(16);
  api.GetWindowRect(hwnd, outer);
  const o = readRect(outer);
  const visible = getWindowRect(hwnd);
  // 不可視の枠 (影) の幅
  const insetL = visible.x - o.x;
  const insetT = visible.y - o.y;
  const insetR = o.x + o.width - (visible.x + visible.width);
  const insetB = o.y + o.height - (visible.y + visible.height);
  const resize = bounds.width !== undefined && bounds.height !== undefined;
  const ok = api.SetWindowPos(
    hwnd,
    0,
    Math.round(bounds.x - insetL),
    Math.round(bounds.y - insetT),
    resize ? Math.round((bounds.width ?? 0) + insetL + insetR) : 0,
    resize ? Math.round((bounds.height ?? 0) + insetT + insetB) : 0,
    SWP_NOZORDER | SWP_NOACTIVATE | (resize ? 0 : SWP_NOSIZE),
  );
  if (!ok) throw new Error('ウィンドウの移動/サイズ変更に失敗しました (権限が不足している可能性があります)');
}

/** タイトル (部分一致・大文字小文字無視) でウィンドウを探す */
export function findWindowByTitle(query: string, excludePids: number[] = []): WindowInfo | null {
  const q = query.toLowerCase();
  const all = listWindows(excludePids);
  return (
    all.find((w) => w.title.toLowerCase() === q) ??
    all.find((w) => w.title.toLowerCase().includes(q)) ??
    all.find((w) => w.processName.toLowerCase().replace(/\.exe$/, '') === q.replace(/\.exe$/, '')) ??
    null
  );
}
