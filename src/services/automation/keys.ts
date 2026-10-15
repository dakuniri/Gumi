/**
 * キー名 -> キーコードの変換と、ショートカット文字列の解析 (純粋関数)。
 * Windows は仮想キーコード (VK)、macOS は CoreGraphics のキーコード (kVK_*) を返す。
 */

export type KeyPlatform = 'win32' | 'darwin';

export function currentKeyPlatform(): KeyPlatform {
  return typeof process !== 'undefined' && process.platform === 'darwin' ? 'darwin' : 'win32';
}

// ------------------------------------------------------------------
// Windows (Virtual-Key codes)
// ------------------------------------------------------------------
const VK: Record<string, number> = {
  backspace: 0x08,
  tab: 0x09,
  clear: 0x0c,
  enter: 0x0d,
  shift: 0x10,
  ctrl: 0x11,
  alt: 0x12,
  pause: 0x13,
  capslock: 0x14,
  kana: 0x15,
  kanji: 0x19,
  escape: 0x1b,
  convert: 0x1c, // 変換
  nonconvert: 0x1d, // 無変換
  space: 0x20,
  pageup: 0x21,
  pagedown: 0x22,
  end: 0x23,
  home: 0x24,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  printscreen: 0x2c,
  insert: 0x2d,
  delete: 0x2e,
  win: 0x5b,
  rwin: 0x5c,
  apps: 0x5d,
  numpad0: 0x60,
  numpad1: 0x61,
  numpad2: 0x62,
  numpad3: 0x63,
  numpad4: 0x64,
  numpad5: 0x65,
  numpad6: 0x66,
  numpad7: 0x67,
  numpad8: 0x68,
  numpad9: 0x69,
  multiply: 0x6a,
  add: 0x6b,
  subtract: 0x6d,
  decimal: 0x6e,
  divide: 0x6f,
  numlock: 0x90,
  scrolllock: 0x91,
  lshift: 0xa0,
  rshift: 0xa1,
  lctrl: 0xa2,
  rctrl: 0xa3,
  lalt: 0xa4,
  ralt: 0xa5,
  browserback: 0xa6,
  browserforward: 0xa7,
  browserrefresh: 0xa8,
  volumemute: 0xad,
  volumedown: 0xae,
  volumeup: 0xaf,
  medianext: 0xb0,
  mediaprev: 0xb1,
  mediastop: 0xb2,
  mediaplaypause: 0xb3,
  // OEM (日本語配列でも VK は同じだが刻印が異なる場合がある)
  semicolon: 0xba,
  plus: 0xbb,
  comma: 0xbc,
  minus: 0xbd,
  period: 0xbe,
  slash: 0xbf,
  backquote: 0xc0,
  bracketleft: 0xdb,
  backslash: 0xdc,
  bracketright: 0xdd,
  quote: 0xde,
  zenkaku: 0xf3, // 半角/全角 (OEM_AUTO)
  hankaku: 0xf4,
};

/** 拡張キーフラグ (KEYEVENTF_EXTENDEDKEY) が必要な VK */
const EXTENDED = new Set<number>([
  0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2c, 0x2d, 0x2e, 0x5b, 0x5c, 0x5d, 0x6f, 0x90, 0xa3,
  0xa5, 0xa6, 0xa7, 0xa8, 0xad, 0xae, 0xaf, 0xb0, 0xb1, 0xb2, 0xb3,
]);

// ------------------------------------------------------------------
// macOS (kVK_* : US 配列の物理位置。日本語配列でも同じ位置のキーになる)
// ------------------------------------------------------------------
const MAC: Record<string, number> = {
  a: 0x00, s: 0x01, d: 0x02, f: 0x03, h: 0x04, g: 0x05, z: 0x06, x: 0x07, c: 0x08, v: 0x09,
  b: 0x0b, q: 0x0c, w: 0x0d, e: 0x0e, r: 0x0f, y: 0x10, t: 0x11,
  '1': 0x12, '2': 0x13, '3': 0x14, '4': 0x15, '6': 0x16, '5': 0x17, plus: 0x18, '9': 0x19, '7': 0x1a,
  minus: 0x1b, '8': 0x1c, '0': 0x1d, bracketright: 0x1e, o: 0x1f, u: 0x20, bracketleft: 0x21, i: 0x22,
  p: 0x23, enter: 0x24, l: 0x25, j: 0x26, quote: 0x27, k: 0x28, semicolon: 0x29, backslash: 0x2a,
  comma: 0x2b, slash: 0x2c, n: 0x2d, m: 0x2e, period: 0x2f, tab: 0x30, space: 0x31, backquote: 0x32,
  backspace: 0x33, escape: 0x35, rcmd: 0x36, cmd: 0x37, shift: 0x38, capslock: 0x39, alt: 0x3a,
  ctrl: 0x3b, rshift: 0x3c, ralt: 0x3d, rctrl: 0x3e, fn: 0x3f, f17: 0x40, decimal: 0x41, multiply: 0x43,
  add: 0x45, clear: 0x47, volumeup: 0x48, volumedown: 0x49, volumemute: 0x4a, divide: 0x4b,
  numpadenter: 0x4c, subtract: 0x4e, f18: 0x4f, f19: 0x50, numpadequals: 0x51,
  numpad0: 0x52, numpad1: 0x53, numpad2: 0x54, numpad3: 0x55, numpad4: 0x56, numpad5: 0x57,
  numpad6: 0x58, numpad7: 0x59, f20: 0x5a, numpad8: 0x5b, numpad9: 0x5c,
  yen: 0x5d, underscore: 0x5e, eisu: 0x66, kana: 0x68,
  f5: 0x60, f6: 0x61, f7: 0x62, f3: 0x63, f8: 0x64, f9: 0x65, f11: 0x67, f13: 0x69, f16: 0x6a,
  f14: 0x6b, f10: 0x6d, f12: 0x6f, f15: 0x71, help: 0x72, home: 0x73, pageup: 0x74, delete: 0x75,
  f4: 0x76, end: 0x77, f2: 0x78, pagedown: 0x79, f1: 0x7a, left: 0x7b, right: 0x7c, down: 0x7d, up: 0x7e,
  lshift: 0x38, lctrl: 0x3b, lalt: 0x3a, lcmd: 0x37,
};

/** macOS の修飾キーフラグ (CGEventFlags) */
export const MAC_FLAGS: Record<string, number> = {
  shift: 0x00020000,
  ctrl: 0x00040000,
  alt: 0x00080000,
  cmd: 0x00100000,
  fn: 0x00800000,
};

const COMMON_ALIASES: Record<string, string> = {
  control: 'ctrl',
  ctl: 'ctrl',
  option: 'alt',
  opt: 'alt',
  menu: 'alt',
  return: 'enter',
  esc: 'escape',
  del: 'delete',
  ins: 'insert',
  pgup: 'pageup',
  pgdn: 'pagedown',
  pagedn: 'pagedown',
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
  bs: 'backspace',
  back: 'backspace',
  prtsc: 'printscreen',
  printscr: 'printscreen',
  context: 'apps',
  contextmenu: 'apps',
  spacebar: 'space',
  ' ': 'space',
  '半角/全角': 'zenkaku',
  '半角全角': 'zenkaku',
  '全角': 'zenkaku',
  '変換': 'convert',
  '無変換': 'nonconvert',
  'かな': 'kana',
  '英数': 'eisu',
  ';': 'semicolon',
  '=': 'plus',
  ',': 'comma',
  '-': 'minus',
  '.': 'period',
  '/': 'slash',
  '`': 'backquote',
  '[': 'bracketleft',
  '\\': 'backslash',
  ']': 'bracketright',
  "'": 'quote',
  '*': 'multiply',
};

/** Windows キー / Command キーの呼び名は OS ごとに正規化先が違う */
const WIN_META_ALIASES: Record<string, string> = {
  windows: 'win',
  super: 'win',
  meta: 'win',
  cmd: 'win',
  command: 'win',
  lwin: 'win',
};
const MAC_META_ALIASES: Record<string, string> = {
  win: 'cmd',
  windows: 'cmd',
  super: 'cmd',
  meta: 'cmd',
  command: 'cmd',
  lwin: 'cmd',
  rwin: 'rcmd',
  // Windows の名前で来たキーを Mac の近いキーに読み替える
  insert: 'help',
  numpadenter: 'numpadenter',
  convert: 'kana',
  nonconvert: 'eisu',
  zenkaku: 'kana',
};

const MODIFIER_NAMES = new Set(['shift', 'ctrl', 'alt', 'win', 'cmd', 'fn', 'lshift', 'rshift', 'lctrl', 'rctrl', 'lalt', 'ralt', 'rwin', 'rcmd', 'lcmd']);

export interface KeySpec {
  name: string;
  /** Windows: VK / macOS: kVK キーコード */
  vk: number;
  extended: boolean;
}

export function isModifierKey(k: KeySpec): boolean {
  return MODIFIER_NAMES.has(k.name);
}

export function normalizeKeyName(name: string, platform: KeyPlatform = currentKeyPlatform()): string {
  const raw = name.trim();
  if (raw === ' ') return 'space';
  const lower = raw.toLowerCase();
  const common = COMMON_ALIASES[raw] ?? COMMON_ALIASES[lower] ?? lower;
  const meta = platform === 'darwin' ? MAC_META_ALIASES : WIN_META_ALIASES;
  return meta[common] ?? common;
}

/** 単一キー名をキーコードに変換する。不明なキーは例外。 */
export function resolveKey(name: string, platform: KeyPlatform = currentKeyPlatform()): KeySpec {
  const n = normalizeKeyName(name, platform);
  if (platform === 'darwin') {
    const code = MAC[n];
    if (code === undefined) {
      throw new Error(`macOS では使えない、または不明なキー名です: "${name}" (Command は cmd、Option は alt)`);
    }
    return { name: n, vk: code, extended: false };
  }
  let vk: number | undefined = VK[n];
  if (vk === undefined) {
    if (/^[a-z]$/.test(n)) vk = n.toUpperCase().charCodeAt(0);
    else if (/^[0-9]$/.test(n)) vk = n.charCodeAt(0);
    else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(n)) vk = 0x70 + Number(n.slice(1)) - 1;
  }
  if (vk === undefined) throw new Error(`不明なキー名です: "${name}"`);
  return { name: n, vk, extended: EXTENDED.has(vk) };
}

/**
 * "ctrl+shift+s" / "Cmd + C" / ["ctrl","c"] のようなショートカット指定を解析する。
 * "+" 自体を押したい場合は "ctrl+plus" のように名前で指定する。
 */
export function parseCombo(input: string | string[], platform: KeyPlatform = currentKeyPlatform()): KeySpec[] {
  const parts = Array.isArray(input)
    ? input
    : input
        .split('+')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
  if (parts.length === 0) throw new Error('キーが指定されていません');
  if (parts.length > 6) throw new Error('同時押しできるキーは 6 個までです');
  const keys = parts.map((p) => resolveKey(p, platform));
  // 修飾キーを先に押すよう並べ替え (相対順序は保持)
  const mods = keys.filter(isModifierKey);
  const rest = keys.filter((k) => !isModifierKey(k));
  return [...mods, ...rest];
}

export function comboToString(keys: KeySpec[]): string {
  return keys.map((k) => k.name).join('+');
}

/** AI からは絶対に送信させないキー組み合わせ (両 OS) */
const FORBIDDEN_COMBOS: string[][] = [
  ['ctrl', 'alt', 'delete'],
  ['win', 'l'], // 画面ロック (Windows)
  ['ctrl', 'cmd', 'q'], // 画面ロック (macOS)
  ['cmd', 'alt', 'escape'], // 強制終了ウィンドウ (macOS)
  ['cmd', 'shift', 'q'], // ログアウト (macOS)
  ['cmd', 'shift', 'backspace'], // ゴミ箱を空にする (macOS)
  ['cmd', 'alt', 'shift', 'backspace'], // 確認なしでゴミ箱を空にする (macOS)
];

/** 送信前に確認が必要な (影響の大きい) キー組み合わせ */
const RISKY_COMBOS: string[][] = [
  ['win', 'r'], // ファイル名を指定して実行
  ['win', 'x'], // 管理メニュー
  ['ctrl', 'shift', 'escape'], // タスクマネージャー
  ['shift', 'delete'], // 完全削除
  ['alt', 'f4'], // ウィンドウ/アプリ終了
  ['ctrl', 'shift', 'delete'], // 閲覧データ削除
  ['cmd', 'q'], // アプリ終了 (macOS)
  ['cmd', 'backspace'], // ゴミ箱に入れる (macOS Finder)
  ['cmd', 'alt', 'backspace'], // すぐに削除 (macOS Finder)
];

function canonical(keys: KeySpec[]): string[] {
  return keys.map((k) => {
    switch (k.name) {
      case 'lctrl':
      case 'rctrl':
        return 'ctrl';
      case 'lalt':
      case 'ralt':
        return 'alt';
      case 'lshift':
      case 'rshift':
        return 'shift';
      case 'rwin':
        return 'win';
      case 'rcmd':
      case 'lcmd':
        return 'cmd';
      default:
        return k.name;
    }
  });
}

function matches(keys: KeySpec[], combo: string[]): boolean {
  const names = new Set(canonical(keys));
  return combo.length === names.size && combo.every((c) => names.has(c));
}

export function isForbiddenCombo(keys: KeySpec[], extraForbidden: string[][] = []): boolean {
  return [...FORBIDDEN_COMBOS, ...extraForbidden].some((c) => matches(keys, c));
}

export function isRiskyCombo(keys: KeySpec[]): boolean {
  return RISKY_COMBOS.some((c) => matches(keys, c));
}

/** Electron のアクセラレータ文字列 ("Control+Alt+Escape") をキー名配列に変換する */
export function acceleratorToCombo(accel: string, platform: KeyPlatform = currentKeyPlatform()): string[] {
  return accel
    .split('+')
    .map((s) => s.trim().toLowerCase())
    .map((s) =>
      s === 'commandorcontrol' || s === 'cmdorctrl' ? (platform === 'darwin' ? 'cmd' : 'ctrl') : normalizeKeyName(s, platform),
    );
}

/** 貼り付けのショートカット (Windows: ctrl+v / macOS: cmd+v) */
export function pasteCombo(platform: KeyPlatform = currentKeyPlatform()): string {
  return platform === 'darwin' ? 'cmd+v' : 'ctrl+v';
}
