/**
 * Win32 API バインディング (koffi FFI)。
 *
 * - ネイティブアドオンのビルドを必要としない koffi を使って user32 / kernel32 / dwmapi を呼び出す。
 * - HWND / HANDLE は `intptr` (JS number) として扱う。
 * - Win32 の BOOL は 4 バイト int なので `int` で受け取る (C99 bool ではない)。
 * - 構造体は Buffer で直接レイアウトする (koffi の union/struct 変換に依存しない)。
 *
 * Electron の Main Process は Per-Monitor DPI Aware V2 で動作するため、
 * ここで扱う座標はすべて物理ピクセル (仮想スクリーン座標) となる。
 */
import koffi from 'koffi';

export interface Win32Api {
  // user32 - input
  SendInput(count: number, inputs: Buffer, size: number): number;
  SetCursorPos(x: number, y: number): number;
  GetCursorPos(point: Buffer): number;
  GetSystemMetrics(index: number): number;
  MapVirtualKeyW(code: number, mapType: number): number;
  GetAsyncKeyState(vk: number): number;
  GetLastInputInfo(info: Buffer): number;
  // user32 - windows
  GetForegroundWindow(): number;
  SetForegroundWindow(hwnd: number): number;
  BringWindowToTop(hwnd: number): number;
  ShowWindow(hwnd: number, cmd: number): number;
  IsWindow(hwnd: number): number;
  IsWindowVisible(hwnd: number): number;
  IsIconic(hwnd: number): number;
  IsZoomed(hwnd: number): number;
  IsHungAppWindow(hwnd: number): number;
  GetWindowTextW(hwnd: number, buf: Buffer, max: number): number;
  GetWindowTextLengthW(hwnd: number): number;
  GetClassNameW(hwnd: number, buf: Buffer, max: number): number;
  GetWindowThreadProcessId(hwnd: number, pid: Buffer): number;
  GetWindowRect(hwnd: number, rect: Buffer): number;
  SetWindowPos(hwnd: number, after: number, x: number, y: number, cx: number, cy: number, flags: number): number;
  PostMessageW(hwnd: number, msg: number, wParam: number, lParam: number): number;
  EnumWindows(cb: (hwnd: number, lParam: number) => number, lParam: number): number;
  GetWindowLongW(hwnd: number, index: number): number;
  GetWindow(hwnd: number, cmd: number): number;
  AttachThreadInput(idAttach: number, idAttachTo: number, attach: number): number;
  // kernel32
  GetCurrentThreadId(): number;
  GetCurrentProcessId(): number;
  GetTickCount(): number;
  CreateToolhelp32Snapshot(flags: number, pid: number): number;
  Process32FirstW(snapshot: number, entry: Buffer): number;
  Process32NextW(snapshot: number, entry: Buffer): number;
  CloseHandle(handle: number): number;
  OpenProcess(access: number, inherit: number, pid: number): number;
  QueryFullProcessImageNameW(proc: number, flags: number, buf: Buffer, size: Buffer): number;
  // dwmapi
  DwmGetWindowAttribute(hwnd: number, attr: number, out: Buffer, size: number): number;
}

let api: Win32Api | null = null;
let loadError: Error | null = null;

export const IS_64BIT = process.arch === 'x64' || process.arch === 'arm64';
export const POINTER_SIZE = IS_64BIT ? 8 : 4;

function load(): Win32Api {
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const dwmapi = koffi.load('dwmapi.dll');

  // EnumWindows のコールバック型 (名前で参照される)
  koffi.proto('int __stdcall GumiEnumWindowsProc(intptr hwnd, intptr lParam)');

  const u = (decl: string) => user32.func(decl);
  const k = (decl: string) => kernel32.func(decl);

  return {
    SendInput: u('uint32 __stdcall SendInput(uint32 cInputs, void *pInputs, int cbSize)'),
    SetCursorPos: u('int __stdcall SetCursorPos(int x, int y)'),
    GetCursorPos: u('int __stdcall GetCursorPos(void *lpPoint)'),
    GetSystemMetrics: u('int __stdcall GetSystemMetrics(int nIndex)'),
    MapVirtualKeyW: u('uint32 __stdcall MapVirtualKeyW(uint32 uCode, uint32 uMapType)'),
    GetAsyncKeyState: u('int16 __stdcall GetAsyncKeyState(int vKey)'),
    GetLastInputInfo: u('int __stdcall GetLastInputInfo(void *plii)'),

    GetForegroundWindow: u('intptr __stdcall GetForegroundWindow()'),
    SetForegroundWindow: u('int __stdcall SetForegroundWindow(intptr hWnd)'),
    BringWindowToTop: u('int __stdcall BringWindowToTop(intptr hWnd)'),
    ShowWindow: u('int __stdcall ShowWindow(intptr hWnd, int nCmdShow)'),
    IsWindow: u('int __stdcall IsWindow(intptr hWnd)'),
    IsWindowVisible: u('int __stdcall IsWindowVisible(intptr hWnd)'),
    IsIconic: u('int __stdcall IsIconic(intptr hWnd)'),
    IsZoomed: u('int __stdcall IsZoomed(intptr hWnd)'),
    IsHungAppWindow: u('int __stdcall IsHungAppWindow(intptr hWnd)'),
    GetWindowTextW: u('int __stdcall GetWindowTextW(intptr hWnd, void *lpString, int nMaxCount)'),
    GetWindowTextLengthW: u('int __stdcall GetWindowTextLengthW(intptr hWnd)'),
    GetClassNameW: u('int __stdcall GetClassNameW(intptr hWnd, void *lpClassName, int nMaxCount)'),
    GetWindowThreadProcessId: u('uint32 __stdcall GetWindowThreadProcessId(intptr hWnd, void *lpdwProcessId)'),
    GetWindowRect: u('int __stdcall GetWindowRect(intptr hWnd, void *lpRect)'),
    SetWindowPos: u(
      'int __stdcall SetWindowPos(intptr hWnd, intptr hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)',
    ),
    PostMessageW: u('int __stdcall PostMessageW(intptr hWnd, uint32 Msg, uintptr wParam, intptr lParam)'),
    EnumWindows: u('int __stdcall EnumWindows(GumiEnumWindowsProc *lpEnumFunc, intptr lParam)'),
    GetWindowLongW: u('int32 __stdcall GetWindowLongW(intptr hWnd, int nIndex)'),
    GetWindow: u('intptr __stdcall GetWindow(intptr hWnd, uint32 uCmd)'),
    AttachThreadInput: u('int __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, int fAttach)'),

    GetCurrentThreadId: k('uint32 __stdcall GetCurrentThreadId()'),
    GetCurrentProcessId: k('uint32 __stdcall GetCurrentProcessId()'),
    GetTickCount: k('uint32 __stdcall GetTickCount()'),
    CreateToolhelp32Snapshot: k('intptr __stdcall CreateToolhelp32Snapshot(uint32 dwFlags, uint32 th32ProcessID)'),
    Process32FirstW: k('int __stdcall Process32FirstW(intptr hSnapshot, void *lppe)'),
    Process32NextW: k('int __stdcall Process32NextW(intptr hSnapshot, void *lppe)'),
    CloseHandle: k('int __stdcall CloseHandle(intptr hObject)'),
    OpenProcess: k('intptr __stdcall OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)'),
    QueryFullProcessImageNameW: k(
      'int __stdcall QueryFullProcessImageNameW(intptr hProcess, uint32 dwFlags, void *lpExeName, void *lpdwSize)',
    ),

    DwmGetWindowAttribute: dwmapi.func(
      'int32 __stdcall DwmGetWindowAttribute(intptr hwnd, uint32 dwAttribute, void *pvAttribute, uint32 cbAttribute)',
    ),
  } as Win32Api;
}

/** Win32 API を取得する。Windows 以外や読み込み失敗時は例外を投げる。 */
export function win32(): Win32Api {
  if (api) return api;
  if (loadError) throw loadError;
  if (process.platform !== 'win32') {
    loadError = new Error('PC 操作エンジンは Windows でのみ利用できます');
    throw loadError;
  }
  try {
    api = load();
    return api;
  } catch (err) {
    loadError = new Error(`Win32 API の読み込みに失敗しました: ${(err as Error).message}`);
    throw loadError;
  }
}

export function isWin32Available(): boolean {
  try {
    win32();
    return true;
  } catch {
    return false;
  }
}

// ---- 定数 ----
export const SM_XVIRTUALSCREEN = 76;
export const SM_YVIRTUALSCREEN = 77;
export const SM_CXVIRTUALSCREEN = 78;
export const SM_CYVIRTUALSCREEN = 79;

export const SW_MAXIMIZE = 3;
export const SW_SHOW = 5;
export const SW_MINIMIZE = 6;
export const SW_RESTORE = 9;

export const WM_CLOSE = 0x0010;
export const GWL_EXSTYLE = -20;
export const WS_EX_TOOLWINDOW = 0x00000080;
export const WS_EX_NOACTIVATE = 0x08000000;
export const GW_OWNER = 4;

export const SWP_NOSIZE = 0x0001;
export const SWP_NOZORDER = 0x0004;
export const SWP_NOACTIVATE = 0x0010;

export const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
export const DWMWA_CLOAKED = 14;

export const TH32CS_SNAPPROCESS = 0x00000002;
export const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
export const INVALID_HANDLE_VALUE = -1;

/** UTF-16 バッファから文字列を取り出す */
export function readWideString(buf: Buffer, chars?: number): string {
  if (chars !== undefined) return buf.toString('utf16le', 0, chars * 2);
  let end = 0;
  while (end + 1 < buf.length && (buf[end] !== 0 || buf[end + 1] !== 0)) end += 2;
  return buf.toString('utf16le', 0, end);
}
