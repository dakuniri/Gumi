/**
 * SendInput 用 INPUT 構造体のバイナリエンコード (純粋関数・テスト可能)。
 *
 * x64/arm64:  sizeof(INPUT) = 40, union は offset 8
 *   MOUSEINPUT  { LONG dx; LONG dy; DWORD mouseData; DWORD dwFlags; DWORD time; ULONG_PTR dwExtraInfo(@24) }
 *   KEYBDINPUT  { WORD wVk; WORD wScan; DWORD dwFlags; DWORD time; ULONG_PTR dwExtraInfo(@16) }
 * ia32: sizeof(INPUT) = 28, union は offset 4
 */

export const INPUT_MOUSE = 0;
export const INPUT_KEYBOARD = 1;

export const MOUSEEVENTF_MOVE = 0x0001;
export const MOUSEEVENTF_LEFTDOWN = 0x0002;
export const MOUSEEVENTF_LEFTUP = 0x0004;
export const MOUSEEVENTF_RIGHTDOWN = 0x0008;
export const MOUSEEVENTF_RIGHTUP = 0x0010;
export const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
export const MOUSEEVENTF_MIDDLEUP = 0x0040;
export const MOUSEEVENTF_XDOWN = 0x0080;
export const MOUSEEVENTF_XUP = 0x0100;
export const MOUSEEVENTF_WHEEL = 0x0800;
export const MOUSEEVENTF_HWHEEL = 0x01000;
export const MOUSEEVENTF_VIRTUALDESK = 0x4000;
export const MOUSEEVENTF_ABSOLUTE = 0x8000;

export const KEYEVENTF_EXTENDEDKEY = 0x0001;
export const KEYEVENTF_KEYUP = 0x0002;
export const KEYEVENTF_UNICODE = 0x0004;
export const KEYEVENTF_SCANCODE = 0x0008;

export const WHEEL_DELTA = 120;

/** Gumi が注入した入力であることを示す dwExtraInfo のマーカー ("GUMI") */
export const GUMI_EXTRA_INFO = 0x47554d49;

export interface MouseInputData {
  type: 'mouse';
  dx?: number;
  dy?: number;
  mouseData?: number;
  flags: number;
}

export interface KeyboardInputData {
  type: 'keyboard';
  vk: number;
  scan: number;
  flags: number;
}

export type InputData = MouseInputData | KeyboardInputData;

/** extra オフセットは union (MOUSEINPUT / KEYBDINPUT) 先頭からの位置 */
export function inputLayout(is64: boolean) {
  return is64
    ? { size: 40, unionOffset: 8, mouseExtraOffset: 24, keyExtraOffset: 16 }
    : { size: 28, unionOffset: 4, mouseExtraOffset: 20, keyExtraOffset: 12 };
}

export function encodeInputs(inputs: InputData[], is64: boolean): Buffer {
  const layout = inputLayout(is64);
  const buf = Buffer.alloc(layout.size * inputs.length);
  inputs.forEach((input, i) => {
    const base = i * layout.size;
    const u = base + layout.unionOffset;
    if (input.type === 'mouse') {
      buf.writeUInt32LE(INPUT_MOUSE, base);
      buf.writeInt32LE(Math.trunc(input.dx ?? 0), u);
      buf.writeInt32LE(Math.trunc(input.dy ?? 0), u + 4);
      // mouseData は DWORD だがホイール量は符号付きなので 2 の補数で書き込む
      buf.writeInt32LE(Math.trunc(input.mouseData ?? 0), u + 8);
      buf.writeUInt32LE(input.flags >>> 0, u + 12);
      buf.writeUInt32LE(0, u + 16); // time
      writePtr(buf, u + layout.mouseExtraOffset, GUMI_EXTRA_INFO, is64);
    } else {
      buf.writeUInt32LE(INPUT_KEYBOARD, base);
      buf.writeUInt16LE(input.vk & 0xffff, u);
      buf.writeUInt16LE(input.scan & 0xffff, u + 2);
      buf.writeUInt32LE(input.flags >>> 0, u + 4);
      buf.writeUInt32LE(0, u + 8); // time
      writePtr(buf, u + layout.keyExtraOffset, GUMI_EXTRA_INFO, is64);
    }
  });
  return buf;
}

function writePtr(buf: Buffer, offset: number, value: number, is64: boolean) {
  if (is64) buf.writeBigUInt64LE(BigInt(value), offset);
  else buf.writeUInt32LE(value >>> 0, offset);
}

/**
 * 物理座標を SendInput の絶対座標 (0..65535, 仮想デスクトップ基準) に正規化する。
 */
export function toAbsolute(
  x: number,
  y: number,
  virt: { x: number; y: number; width: number; height: number },
): { dx: number; dy: number } {
  const w = Math.max(1, virt.width - 1);
  const h = Math.max(1, virt.height - 1);
  return {
    dx: Math.round(((x - virt.x) * 65535) / w),
    dy: Math.round(((y - virt.y) * 65535) / h),
  };
}

/** UTF-16 コードユニット列 (サロゲートペアは 2 ユニット) で文字列を分解する */
export function toUtf16Units(text: string): number[] {
  const units: number[] = [];
  for (let i = 0; i < text.length; i++) units.push(text.charCodeAt(i));
  return units;
}
