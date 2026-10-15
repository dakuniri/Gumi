/**
 * ウィンドウ列挙 (macOS / CGWindowListCopyWindowInfo) とプロセス一覧 (libproc)。
 * 列挙は同期で速い (アプリに問い合わせない)。前面化・移動・最小化などはアクセシビリティ ワーカー経由で行う。
 * ウィンドウ ID は CGWindowID。座標はポイント。
 */
import path from 'node:path';
import {
  mac,
  kCGWindowListExcludeDesktopElements,
  kCGWindowListOptionOnScreenOnly,
} from './bindings';
import { arrayItems, dictGet, readNumber, readString, release } from './cf';
import type { Rect } from '../../../types/character';
import type { ProcessInfo, WindowInfo } from '../types';

/** 通常のアプリケーションウィンドウのレイヤー */
const NORMAL_LAYER = 0;
/** 小さすぎるもの (ツールチップや見えない補助ウィンドウ) は除外 */
const MIN_SIZE = 40;

interface RawWindow {
  id: number;
  pid: number;
  owner: string;
  title: string;
  layer: number;
  alpha: number;
  rect: Rect;
}

function readRect(dict: unknown): Rect | null {
  if (!dict) return null;
  const buf = Buffer.alloc(32);
  if (!mac().CGRectMakeWithDictionaryRepresentation(dict, buf)) return null;
  return {
    x: Math.round(buf.readDoubleLE(0)),
    y: Math.round(buf.readDoubleLE(8)),
    width: Math.round(buf.readDoubleLE(16)),
    height: Math.round(buf.readDoubleLE(24)),
  };
}

/** 画面に表示中のウィンドウを手前から順に取得する */
export function rawWindows(): RawWindow[] {
  const api = mac();
  const list = api.CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, 0);
  if (!list) return [];
  try {
    const out: RawWindow[] = [];
    for (const d of arrayItems(list)) {
      const rect = readRect(dictGet(d, 'kCGWindowBounds'));
      if (!rect) continue;
      out.push({
        id: readNumber(dictGet(d, 'kCGWindowNumber')) ?? 0,
        pid: readNumber(dictGet(d, 'kCGWindowOwnerPID')) ?? 0,
        owner: readString(dictGet(d, 'kCGWindowOwnerName')) ?? '',
        // 画面収録の許可が無いと他のアプリのタイトルは取得できない (空になる)
        title: readString(dictGet(d, 'kCGWindowName')) ?? '',
        layer: readNumber(dictGet(d, 'kCGWindowLayer')) ?? 0,
        alpha: readNumber(dictGet(d, 'kCGWindowAlpha')) ?? 1,
        rect,
      });
    }
    return out;
  } finally {
    release(list);
  }
}

function isAppWindow(w: RawWindow): boolean {
  return (
    w.layer === NORMAL_LAYER &&
    w.alpha > 0 &&
    w.rect.width >= MIN_SIZE &&
    w.rect.height >= MIN_SIZE &&
    w.owner !== 'Window Server' &&
    w.owner !== 'Dock'
  );
}

function toInfo(w: RawWindow, foregroundId: number | null): WindowInfo {
  return {
    hwnd: w.id,
    // タイトルが取れないときはアプリ名を使う
    title: w.title || w.owner,
    className: '',
    pid: w.pid,
    processName: w.owner,
    rect: w.rect,
    minimized: false,
    maximized: false,
    foreground: w.id === foregroundId,
    responding: true,
  };
}

/**
 * 表示中のアプリケーションウィンドウを手前から列挙する。
 * 前面のウィンドウは「最前面のアプリ (frontPid) の一番手前のウィンドウ」。frontPid が不明なら一番手前のもの。
 */
export function listWindows(excludePids: number[] = [], frontPid: number | null = null): WindowInfo[] {
  const all = rawWindows().filter((w) => isAppWindow(w) && !excludePids.includes(w.pid));
  const fg = (frontPid !== null ? all.find((w) => w.pid === frontPid) : undefined) ?? all[0];
  return all.map((w) => toInfo(w, fg?.id ?? null));
}

export function findWindow(id: number): WindowInfo | null {
  return listWindows().find((w) => w.hwnd === id) ?? null;
}

export function findWindowByTitle(query: string, excludePids: number[] = [], frontPid: number | null = null): WindowInfo | null {
  const q = query.toLowerCase().trim();
  const all = listWindows(excludePids, frontPid);
  const app = q.replace(/\.app$/, '');
  return (
    all.find((w) => w.title.toLowerCase() === q) ??
    all.find((w) => w.title.toLowerCase().includes(q)) ??
    all.find((w) => w.processName.toLowerCase() === app) ??
    all.find((w) => w.processName.toLowerCase().includes(app)) ??
    null
  );
}

// ---------------------------------------------------------------------------
// プロセス
// ---------------------------------------------------------------------------

const PROC_PIDPATHINFO_MAXSIZE = 4096;

export function processName(pid: number): string {
  const api = mac();
  const buf = Buffer.alloc(PROC_PIDPATHINFO_MAXSIZE);
  const n = api.proc_pidpath(pid, buf, buf.length);
  if (n > 0) {
    const full = buf.toString('utf8', 0, n);
    // /Applications/Safari.app/Contents/MacOS/Safari -> Safari
    return path.posix.basename(full);
  }
  const short = Buffer.alloc(256);
  const m = api.proc_name(pid, short, short.length);
  return m > 0 ? short.toString('utf8', 0, m) : '';
}

export function listProcesses(): ProcessInfo[] {
  const api = mac();
  const count = api.proc_listallpids(null, 0);
  if (count <= 0) return [];
  // 呼び出しの間に増えても入るよう余裕を持たせる
  const buf = Buffer.alloc((count + 64) * 4);
  const n = api.proc_listallpids(buf, buf.length);
  const out: ProcessInfo[] = [];
  for (let i = 0; i < n; i++) {
    const pid = buf.readInt32LE(i * 4);
    if (pid <= 0) continue;
    const name = processName(pid);
    if (name) out.push({ pid, parentPid: 0, threads: 0, name });
  }
  return out;
}
