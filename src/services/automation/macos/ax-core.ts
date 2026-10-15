/**
 * アクセシビリティ API (AXUIElement) による UI 要素の取得・操作とウィンドウ操作 (macOS)。
 * 応答しないアプリで呼び出しが止まっても UI が固まらないよう、ワーカースレッド (ax-worker) 上で動かす。
 *
 * 要素 ID はワーカー内のキャッシュ (保持した AXUIElement) の番号。get_ui_elements のたびに振り直す。
 */
import { mac, kAXErrorSuccess } from './bindings';
import {
  AxError,
  axActions,
  axBool,
  axCopy,
  axElements,
  axPerform,
  axPid,
  axPoint,
  axSet,
  axSetPoint,
  axSettable,
  axString,
  cfBool,
  cfstrNew,
  plist,
  readNumber,
  readString,
  release,
} from './cf';
import type { Rect } from '../../../types/character';
import type { UiElement, UiTree, WindowAction } from '../types';

type Ptr = unknown;

/** AX 呼び出し 1 回あたりの最大待ち時間 (秒) */
const MESSAGING_TIMEOUT = 1.0;

/** 操作できる (AI に見せる価値がある) 役割 */
const INTERACTIVE_ROLES = new Set([
  'AXButton',
  'AXCheckBox',
  'AXRadioButton',
  'AXTextField',
  'AXTextArea',
  'AXComboBox',
  'AXPopUpButton',
  'AXMenuButton',
  'AXMenuItem',
  'AXMenuBarItem',
  'AXLink',
  'AXSlider',
  'AXIncrementor',
  'AXStepper',
  'AXDisclosureTriangle',
  'AXColorWell',
  'AXSearchField',
  'AXTab',
  'AXDockItem',
]);

/** 役割だけでは分からないので、押せるか (AXPress) を確認する役割 */
const MAYBE_INTERACTIVE = new Set(['AXGroup', 'AXImage', 'AXStaticText', 'AXCell', 'AXRow']);

const TEXT_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField']);

/** 中身を辿らない役割 (大量の子を持つが操作対象にならない) */
const SKIP_CHILDREN = new Set(['AXScrollBar', 'AXRuler', 'AXValueIndicator']);

export interface WindowRef {
  pid: number;
  windowId: number;
  rect?: Rect;
  title?: string;
}

// ---------------------------------------------------------------------------
// 要素キャッシュ
// ---------------------------------------------------------------------------

const cache = new Map<number, Ptr>();
let nextId = 1;
const MAX_CACHE = 3000;

function remember(el: Ptr): number {
  if (cache.size >= MAX_CACHE) clearCache();
  const id = nextId++;
  cache.set(id, el);
  return id;
}

export function clearCache(): void {
  for (const el of cache.values()) release(el);
  cache.clear();
  nextId = 1;
}

function cached(id: number): Ptr {
  const el = cache.get(id);
  if (!el) throw new Error(`Element #${id} not found. Call get_ui_elements again.`);
  return el;
}

// ---------------------------------------------------------------------------
// 権限
// ---------------------------------------------------------------------------

export function trusted(prompt = false): boolean {
  const api = mac();
  if (!prompt) return api.AXIsProcessTrusted();
  const opts = plist('<dict><key>AXTrustedCheckOptionPrompt</key><true/></dict>');
  try {
    return api.AXIsProcessTrustedWithOptions(opts);
  } finally {
    release(opts);
  }
}

function assertTrusted(): void {
  if (!mac().AXIsProcessTrusted()) throw new AxError(-25211, 'accessibility');
}

// ---------------------------------------------------------------------------
// ウィンドウ
// ---------------------------------------------------------------------------

function appElement(pid: number): Ptr {
  const api = mac();
  const app = api.AXUIElementCreateApplication(pid);
  if (!app) throw new Error(`アプリ (pid=${pid}) に接続できませんでした`);
  api.AXUIElementSetMessagingTimeout(app, MESSAGING_TIMEOUT);
  return app;
}

function windowIdOf(el: Ptr): number | null {
  const fn = mac()._AXUIElementGetWindow;
  if (!fn) return null;
  const out = [0];
  try {
    return fn(el, out) === kAXErrorSuccess ? out[0] : null;
  } catch {
    return null;
  }
}

function rectOf(el: Ptr): Rect | null {
  const pos = axPoint(el, 'AXPosition');
  const size = axPoint(el, 'AXSize');
  if (!pos || !size) return null;
  return { x: Math.round(pos.x), y: Math.round(pos.y), width: Math.round(size.x), height: Math.round(size.y) };
}

function near(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;
}

/** CGWindowID に対応する AX ウィンドウを探す (保持して返すので呼び出し側で release) */
export function findWindow(ref: WindowRef): Ptr {
  assertTrusted();
  const app = appElement(ref.pid);
  try {
    const windows = axElements(app, 'AXWindows');
    let hit: Ptr = null;
    // 1) ウィンドウ ID  2) 位置とサイズ  3) タイトル の順で照合する
    for (const w of windows) if (!hit && windowIdOf(w) === ref.windowId) hit = w;
    if (!hit && ref.rect) {
      for (const w of windows) {
        const r = rectOf(w);
        if (!hit && r && near(r, ref.rect)) hit = w;
      }
    }
    if (!hit && ref.title) for (const w of windows) if (!hit && axString(w, 'AXTitle') === ref.title) hit = w;
    if (!hit && windows.length === 1) hit = windows[0];
    for (const w of windows) if (w !== hit) release(w);
    if (!hit) throw new Error('ウィンドウが見つかりませんでした (閉じられたか、別のデスクトップにある可能性があります)');
    return hit;
  } finally {
    release(app);
  }
}

/** アプリを前面に出す */
export function activateApp(pid: number): boolean {
  assertTrusted();
  const app = appElement(pid);
  try {
    axSet(app, 'AXFrontmost', cfBool(true), 'アプリのアクティブ化');
    return true;
  } catch {
    return false;
  } finally {
    release(app);
  }
}

export function focusWindow(ref: WindowRef): boolean {
  const w = findWindow(ref);
  try {
    if (axBool(w, 'AXMinimized')) axSet(w, 'AXMinimized', cfBool(false), 'ウィンドウの復元');
    activateApp(ref.pid);
    try {
      axPerform(w, 'AXRaise');
    } catch {
      /* AXRaise に対応しないウィンドウもある */
    }
    try {
      axSet(w, 'AXMain', cfBool(true));
    } catch {
      /* 無視 */
    }
    return true;
  } finally {
    release(w);
  }
}

function pressButton(w: Ptr, attr: string, what: string): void {
  const btn = axCopy(w, attr);
  if (!btn) throw new Error(`このウィンドウは${what}できません`);
  try {
    axPerform(btn, 'AXPress');
  } finally {
    release(btn);
  }
}

export function windowAction(ref: WindowRef, action: WindowAction): void {
  const w = findWindow(ref);
  try {
    switch (action) {
      case 'minimize':
        axSet(w, 'AXMinimized', cfBool(true), '最小化');
        break;
      case 'restore':
        if (axBool(w, 'AXMinimized')) axSet(w, 'AXMinimized', cfBool(false), '復元');
        else if (axBool(w, 'AXFullScreen')) axSet(w, 'AXFullScreen', cfBool(false), 'フルスクリーン解除');
        activateApp(ref.pid);
        break;
      case 'maximize':
        // macOS の「拡大/縮小」(緑ボタンの Option クリック相当) は AXZoomButton を押す
        pressButton(w, 'AXZoomButton', '拡大');
        break;
      case 'close':
        pressButton(w, 'AXCloseButton', '閉じることが');
        break;
    }
  } finally {
    release(w);
  }
}

export function setWindowBounds(ref: WindowRef, b: { x: number; y: number; width?: number; height?: number }): void {
  const w = findWindow(ref);
  try {
    if (axBool(w, 'AXFullScreen')) throw new Error('フルスクリーンのウィンドウは移動できません');
    axSetPoint(w, 'AXPosition', { x: b.x, y: b.y });
    if (b.width !== undefined && b.height !== undefined) {
      if (!axSettable(w, 'AXSize')) throw new Error('このウィンドウはサイズを変更できません');
      axSetPoint(w, 'AXSize', { x: b.width, y: b.height });
      // サイズ変更で位置がずれることがあるので、もう一度合わせる
      axSetPoint(w, 'AXPosition', { x: b.x, y: b.y });
    }
  } finally {
    release(w);
  }
}

// ---------------------------------------------------------------------------
// UI 要素
// ---------------------------------------------------------------------------

function strip(role: string | null): string {
  return (role ?? '').replace(/^AX/, '');
}

function describe(el: Ptr, rect: Rect, role: string): UiElement {
  const subrole = axString(el, 'AXSubrole');
  const title = axString(el, 'AXTitle');
  const desc = axString(el, 'AXDescription');
  const help = axString(el, 'AXHelp');
  const placeholder = axString(el, 'AXPlaceholderValue');
  const identifier = axString(el, 'AXIdentifier');
  const password = subrole === 'AXSecureTextField';

  let value: string | undefined;
  let toggleState: string | undefined;
  const raw = axCopy(el, 'AXValue');
  try {
    const s = readString(raw);
    const n = s === null ? readNumber(raw) : null;
    if (role === 'AXCheckBox' || role === 'AXRadioButton' || role === 'AXDisclosureTriangle') {
      if (n !== null) toggleState = n === 1 ? 'On' : n === 2 ? 'Indeterminate' : 'Off';
    } else if (!password && s !== null) {
      value = s.slice(0, 500);
    } else if (!password && n !== null) {
      value = String(Math.round(n * 1000) / 1000);
    }
  } finally {
    release(raw);
  }

  const actions = axActions(el).map(strip);
  const patterns = [...new Set(actions.map((a) => (a === 'Press' ? 'Invoke' : a)))];
  if (TEXT_ROLES.has(role) || axSettable(el, 'AXValue')) patterns.push('Value');

  let name = title || desc || '';
  if (!name && role === 'AXStaticText' && value) name = value;
  if (!name) name = placeholder || help || '';

  return {
    id: remember(mac().CFRetain(el)),
    name: name.slice(0, 200),
    type: strip(subrole && subrole !== 'AXStandardWindow' ? subrole : role),
    automationId: identifier ?? '',
    className: role,
    rect,
    enabled: axBool(el, 'AXEnabled') ?? true,
    focused: axBool(el, 'AXFocused') ?? false,
    patterns,
    value: TEXT_ROLES.has(role) || role === 'AXSlider' || role === 'AXStaticText' ? value : undefined,
    password: password || undefined,
    toggleState,
  };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function listElements(
  ref: WindowRef,
  opts: { maxCount?: number; maxDepth?: number; interactiveOnly?: boolean; budgetMs?: number },
): UiTree {
  const started = Date.now();
  const maxCount = opts.maxCount ?? 150;
  const maxDepth = opts.maxDepth ?? 30;
  const budget = opts.budgetMs ?? 5000;
  const interactiveOnly = opts.interactiveOnly ?? true;
  clearCache();

  const win = findWindow(ref);
  const windowTitle = axString(win, 'AXTitle') ?? ref.title ?? '';
  const winRect = rectOf(win) ?? ref.rect ?? { x: -1e6, y: -1e6, width: 2e6, height: 2e6 };
  const elements: UiElement[] = [];
  let truncated = false;

  // 幅優先で辿る (手前・上位の要素から順に)
  const queue: Array<{ el: Ptr; depth: number }> = [{ el: win, depth: 0 }];
  try {
    while (queue.length > 0) {
      if (elements.length >= maxCount || Date.now() - started > budget) {
        truncated = true;
        break;
      }
      const { el, depth } = queue.shift()!;
      try {
        const role = axString(el, 'AXRole') ?? '';
        const rect = depth > 0 ? rectOf(el) : null;
        const visible = !!rect && rect.width > 0 && rect.height > 0 && intersects(rect, winRect);
        if (rect && visible) {
          let include = !interactiveOnly || INTERACTIVE_ROLES.has(role);
          if (!include && MAYBE_INTERACTIVE.has(role)) include = axActions(el).includes('AXPress');
          if (include && (interactiveOnly || role !== 'AXGroup' || axString(el, 'AXTitle'))) {
            elements.push(describe(el, rect, role));
          }
        }
        if (depth < maxDepth && !SKIP_CHILDREN.has(role) && (depth === 0 || visible || !rect)) {
          for (const c of axElements(el, 'AXChildren')) queue.push({ el: c, depth: depth + 1 });
        }
      } catch (err) {
        if (err instanceof AxError && err.code === -25211) throw err;
        /* 途中で消えた要素などは無視 */
      } finally {
        release(el);
      }
    }
  } finally {
    for (const q of queue) release(q.el);
  }
  return { window: windowTitle, elements, truncated, elapsedMs: Date.now() - started };
}

export function elementAt(x: number, y: number): UiElement | null {
  assertTrusted();
  const api = mac();
  const sys = api.AXUIElementCreateSystemWide();
  try {
    api.AXUIElementSetMessagingTimeout(sys, MESSAGING_TIMEOUT);
    const out: Ptr[] = [null];
    if (api.AXUIElementCopyElementAtPosition(sys, x, y, out) !== kAXErrorSuccess || !out[0]) return null;
    const el = out[0];
    try {
      const rect = rectOf(el) ?? { x, y, width: 1, height: 1 };
      return describe(el, rect, axString(el, 'AXRole') ?? '');
    } finally {
      release(el);
    }
  } finally {
    release(sys);
  }
}

export function focusedElement(): UiElement | null {
  assertTrusted();
  const api = mac();
  const sys = api.AXUIElementCreateSystemWide();
  try {
    api.AXUIElementSetMessagingTimeout(sys, MESSAGING_TIMEOUT);
    const el = axCopy(sys, 'AXFocusedUIElement');
    if (!el) return null;
    try {
      const rect = rectOf(el) ?? { x: 0, y: 0, width: 0, height: 0 };
      return describe(el, rect, axString(el, 'AXRole') ?? '');
    } finally {
      release(el);
    }
  } finally {
    release(sys);
  }
}

/** 既定の操作を実行する。対応する操作が無ければ null */
export function invoke(id: number): string | null {
  const el = cached(id);
  const actions = axActions(el);
  for (const a of ['AXPress', 'AXConfirm', 'AXPick', 'AXOpen', 'AXShowMenu']) {
    if (actions.includes(a)) {
      axPerform(el, a);
      return strip(a);
    }
  }
  return null;
}

export function setValue(id: number, value: string): void {
  const el = cached(id);
  if (!axSettable(el, 'AXValue')) throw new Error(`Element #${id} does not accept a value. Click it and use type_text instead.`);
  try {
    axSet(el, 'AXFocused', cfBool(true));
  } catch {
    /* フォーカスできなくても値は設定できる場合がある */
  }
  const s = cfstrNew(value);
  try {
    axSet(el, 'AXValue', s, '値の設定');
  } finally {
    release(s);
  }
}

export function focus(id: number): void {
  const el = cached(id);
  // 要素のウィンドウとアプリを前面に出してからフォーカスする
  const pid = axPid(el);
  if (pid) activateApp(pid);
  axSet(el, 'AXFocused', cfBool(true), 'フォーカス');
}

export function rect(id: number): Rect {
  const r = rectOf(cached(id));
  if (!r) throw new Error(`Element #${id} has no position.`);
  return r;
}

/** 前面のアプリの pid (AXFocusedApplication) */
export function frontmostPid(): number | null {
  const api = mac();
  const sys = api.AXUIElementCreateSystemWide();
  try {
    api.AXUIElementSetMessagingTimeout(sys, MESSAGING_TIMEOUT);
    const app = axCopy(sys, 'AXFocusedApplication');
    if (!app) return null;
    try {
      return axPid(app);
    } finally {
      release(app);
    }
  } finally {
    release(sys);
  }
}

export function ping(): Record<string, unknown> {
  return { trusted: mac().AXIsProcessTrusted(), windowIdApi: !!mac()._AXUIElementGetWindow };
}

/** ワーカーの処理表 */
export const handlers = {
  ping: () => ping(),
  trusted: (a: { prompt?: boolean }) => trusted(a.prompt),
  list: (a: { ref: WindowRef; opts: Parameters<typeof listElements>[1] }) => listElements(a.ref, a.opts),
  at: (a: { x: number; y: number }) => elementAt(a.x, a.y),
  focused: () => focusedElement(),
  invoke: (a: { id: number }) => invoke(a.id),
  setValue: (a: { id: number; value: string }) => setValue(a.id, a.value),
  focus: (a: { id: number }) => focus(a.id),
  rect: (a: { id: number }) => rect(a.id),
  focusWindow: (a: { ref: WindowRef }) => focusWindow(a.ref),
  windowAction: (a: { ref: WindowRef; action: WindowAction }) => windowAction(a.ref, a.action),
  setBounds: (a: { ref: WindowRef; bounds: { x: number; y: number; width?: number; height?: number } }) =>
    setWindowBounds(a.ref, a.bounds),
  activateApp: (a: { pid: number }) => activateApp(a.pid),
  frontmostPid: () => frontmostPid(),
} as const;

export type AxOp = keyof typeof handlers;
