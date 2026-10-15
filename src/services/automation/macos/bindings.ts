/**
 * macOS の C API バインディング (koffi FFI)。ネイティブアドオンのビルドは不要。
 *   CoreGraphics      : マウス・キーボード入力の注入、カーソル位置、ウィンドウ一覧、入力の経過時間
 *   CoreFoundation    : CFString / CFNumber / CFArray / CFDictionary の読み書き
 *   ApplicationServices (HIServices / Accessibility) : UI 要素の取得・操作、ウィンドウ操作、権限確認
 *   libSystem (libproc) : プロセス一覧
 *
 * CF / AX のオブジェクトは koffi の External (不透明なポインタ) として扱い、
 * Copy / Create で得たものは必ず CFRelease する。
 * 座標はグローバル表示座標 (ポイント, メインディスプレイ左上が原点)。
 */
import koffi from 'koffi';

type Ptr = unknown;

export interface CGPointT {
  x: number;
  y: number;
}

export interface CGRectT {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MacApi {
  // CoreGraphics - events
  CGEventSourceCreate(stateId: number): Ptr;
  CGEventCreateMouseEvent(source: Ptr, type: number, pos: CGPointT, button: number): Ptr;
  CGEventCreateKeyboardEvent(source: Ptr, keyCode: number, keyDown: boolean): Ptr;
  CGEventKeyboardSetUnicodeString(event: Ptr, length: number, chars: Buffer): void;
  CGEventSetFlags(event: Ptr, flags: number | bigint): void;
  CGEventSetIntegerValueField(event: Ptr, field: number, value: number | bigint): void;
  CGEventPost(tap: number, event: Ptr): void;
  CGEventCreateScrollWheelEvent2(source: Ptr, units: number, wheelCount: number, w1: number, w2: number, w3: number): Ptr;
  CGEventCreate(source: Ptr): Ptr;
  CGEventGetLocation(event: Ptr): CGPointT;
  CGWarpMouseCursorPosition(pos: CGPointT): number;
  CGEventSourceSecondsSinceLastEventType(stateId: number, eventType: number): number;
  CGEventSourceButtonState(stateId: number, button: number): boolean;
  CGEventSourceKeyState(stateId: number, key: number): boolean;
  // CoreGraphics - displays
  CGGetActiveDisplayList(max: number, displays: Buffer, count: Buffer): number;
  CGDisplayBounds(display: number): CGRectT;
  CGMainDisplayID(): number;
  // CoreGraphics - windows / screen capture permission
  CGWindowListCopyWindowInfo(option: number, relativeTo: number): Ptr;
  CGRectMakeWithDictionaryRepresentation(dict: Ptr, rect: Buffer): boolean;
  CGPreflightScreenCaptureAccess(): boolean;
  CGRequestScreenCaptureAccess(): boolean;
  // CoreFoundation
  CFRelease(cf: Ptr): void;
  CFRetain(cf: Ptr): Ptr;
  CFGetTypeID(cf: Ptr): number;
  CFStringGetTypeID(): number;
  CFNumberGetTypeID(): number;
  CFBooleanGetTypeID(): number;
  CFArrayGetTypeID(): number;
  CFArrayGetCount(arr: Ptr): number;
  CFArrayGetValueAtIndex(arr: Ptr, idx: number): Ptr;
  CFDictionaryGetValue(dict: Ptr, key: Ptr): Ptr;
  CFStringCreateWithCharacters(alloc: Ptr, chars: Buffer, numChars: number): Ptr;
  CFStringGetLength(str: Ptr): number;
  CFStringGetCharacters(str: Ptr, range: { location: number; length: number }, buffer: Buffer): void;
  CFNumberGetValue(num: Ptr, type: number, out: Buffer): boolean;
  CFBooleanGetValue(b: Ptr): boolean;
  CFDataCreate(alloc: Ptr, bytes: Buffer, length: number): Ptr;
  CFPropertyListCreateWithData(alloc: Ptr, data: Ptr, options: number, format: Ptr, error: Ptr): Ptr;
  // Accessibility
  AXIsProcessTrusted(): boolean;
  AXIsProcessTrustedWithOptions(options: Ptr): boolean;
  AXUIElementCreateSystemWide(): Ptr;
  AXUIElementCreateApplication(pid: number): Ptr;
  AXUIElementCopyAttributeValue(el: Ptr, attr: Ptr, out: Ptr[]): number;
  AXUIElementSetAttributeValue(el: Ptr, attr: Ptr, value: Ptr): number;
  AXUIElementIsAttributeSettable(el: Ptr, attr: Ptr, out: boolean[]): number;
  AXUIElementPerformAction(el: Ptr, action: Ptr): number;
  AXUIElementCopyActionNames(el: Ptr, out: Ptr[]): number;
  AXUIElementCopyElementAtPosition(app: Ptr, x: number, y: number, out: Ptr[]): number;
  AXUIElementGetPid(el: Ptr, out: number[]): number;
  AXUIElementSetMessagingTimeout(el: Ptr, seconds: number): number;
  AXValueCreate(type: number, value: Buffer): Ptr;
  AXValueGetValue(value: Ptr, type: number, out: Buffer): boolean;
  AXValueGetTypeID(): number;
  /** 非公開 API (AX 要素 -> CGWindowID)。無い環境では null */
  _AXUIElementGetWindow: ((el: Ptr, out: number[]) => number) | null;
  // libproc
  proc_listallpids(buffer: Buffer | null, size: number): number;
  proc_name(pid: number, buffer: Buffer, size: number): number;
  proc_pidpath(pid: number, buffer: Buffer, size: number): number;
}

let api: MacApi | null = null;
let loadError: Error | null = null;

const FW = '/System/Library/Frameworks';

function load(): MacApi {
  koffi.struct('GumiCGPoint', { x: 'double', y: 'double' });
  koffi.struct('GumiCFRange', { location: 'long', length: 'long' });
  koffi.struct('GumiCGRect', { x: 'double', y: 'double', width: 'double', height: 'double' });

  const CG = koffi.load(`${FW}/CoreGraphics.framework/CoreGraphics`);
  const CF = koffi.load(`${FW}/CoreFoundation.framework/CoreFoundation`);
  const AS = koffi.load(`${FW}/ApplicationServices.framework/ApplicationServices`);
  const SYS = koffi.load('/usr/lib/libSystem.B.dylib');

  const cg = (d: string) => CG.func(d);
  const cf = (d: string) => CF.func(d);
  const ax = (d: string) => AS.func(d);

  return {
    CGEventSourceCreate: cg('void *CGEventSourceCreate(int32_t stateID)'),
    CGEventCreateMouseEvent: cg(
      'void *CGEventCreateMouseEvent(void *source, uint32_t mouseType, GumiCGPoint mouseCursorPosition, uint32_t mouseButton)',
    ),
    CGEventCreateKeyboardEvent: cg('void *CGEventCreateKeyboardEvent(void *source, uint16_t virtualKey, bool keyDown)'),
    CGEventKeyboardSetUnicodeString: cg(
      'void CGEventKeyboardSetUnicodeString(void *event, unsigned long stringLength, void *unicodeString)',
    ),
    CGEventSetFlags: cg('void CGEventSetFlags(void *event, uint64_t flags)'),
    CGEventSetIntegerValueField: cg('void CGEventSetIntegerValueField(void *event, uint32_t field, int64_t value)'),
    CGEventPost: cg('void CGEventPost(uint32_t tap, void *event)'),
    CGEventCreateScrollWheelEvent2: cg(
      'void *CGEventCreateScrollWheelEvent2(void *source, uint32_t units, uint32_t wheelCount, int32_t wheel1, int32_t wheel2, int32_t wheel3)',
    ),
    CGEventCreate: cg('void *CGEventCreate(void *source)'),
    CGEventGetLocation: cg('GumiCGPoint CGEventGetLocation(void *event)'),
    CGWarpMouseCursorPosition: cg('int32_t CGWarpMouseCursorPosition(GumiCGPoint newCursorPosition)'),
    CGEventSourceSecondsSinceLastEventType: cg(
      'double CGEventSourceSecondsSinceLastEventType(int32_t stateID, uint32_t eventType)',
    ),
    CGEventSourceButtonState: cg('bool CGEventSourceButtonState(int32_t stateID, uint32_t button)'),
    CGEventSourceKeyState: cg('bool CGEventSourceKeyState(int32_t stateID, uint16_t key)'),
    CGGetActiveDisplayList: cg('int32_t CGGetActiveDisplayList(uint32_t maxDisplays, void *activeDisplays, void *displayCount)'),
    CGDisplayBounds: cg('GumiCGRect CGDisplayBounds(uint32_t display)'),
    CGMainDisplayID: cg('uint32_t CGMainDisplayID()'),
    CGWindowListCopyWindowInfo: cg('void *CGWindowListCopyWindowInfo(uint32_t option, uint32_t relativeToWindow)'),
    CGRectMakeWithDictionaryRepresentation: cg('bool CGRectMakeWithDictionaryRepresentation(void *dict, void *rect)'),
    CGPreflightScreenCaptureAccess: cg('bool CGPreflightScreenCaptureAccess()'),
    CGRequestScreenCaptureAccess: cg('bool CGRequestScreenCaptureAccess()'),

    CFRelease: cf('void CFRelease(void *cf)'),
    CFRetain: cf('void *CFRetain(void *cf)'),
    CFGetTypeID: cf('unsigned long CFGetTypeID(void *cf)'),
    CFStringGetTypeID: cf('unsigned long CFStringGetTypeID()'),
    CFNumberGetTypeID: cf('unsigned long CFNumberGetTypeID()'),
    CFBooleanGetTypeID: cf('unsigned long CFBooleanGetTypeID()'),
    CFArrayGetTypeID: cf('unsigned long CFArrayGetTypeID()'),
    CFArrayGetCount: cf('long CFArrayGetCount(void *theArray)'),
    CFArrayGetValueAtIndex: cf('void *CFArrayGetValueAtIndex(void *theArray, long idx)'),
    CFDictionaryGetValue: cf('void *CFDictionaryGetValue(void *theDict, void *key)'),
    CFStringCreateWithCharacters: cf('void *CFStringCreateWithCharacters(void *alloc, void *chars, long numChars)'),
    CFStringGetLength: cf('long CFStringGetLength(void *theString)'),
    CFStringGetCharacters: cf('void CFStringGetCharacters(void *theString, GumiCFRange range, void *buffer)'),
    CFNumberGetValue: cf('bool CFNumberGetValue(void *number, long theType, void *valuePtr)'),
    CFBooleanGetValue: cf('bool CFBooleanGetValue(void *boolean)'),
    CFDataCreate: cf('void *CFDataCreate(void *alloc, void *bytes, long length)'),
    CFPropertyListCreateWithData: cf(
      'void *CFPropertyListCreateWithData(void *alloc, void *data, unsigned long options, void *format, void *error)',
    ),

    AXIsProcessTrusted: ax('bool AXIsProcessTrusted()'),
    AXIsProcessTrustedWithOptions: ax('bool AXIsProcessTrustedWithOptions(void *options)'),
    AXUIElementCreateSystemWide: ax('void *AXUIElementCreateSystemWide()'),
    AXUIElementCreateApplication: ax('void *AXUIElementCreateApplication(int32_t pid)'),
    AXUIElementCopyAttributeValue: ax(
      'int32_t AXUIElementCopyAttributeValue(void *element, void *attribute, _Out_ void **value)',
    ),
    AXUIElementSetAttributeValue: ax('int32_t AXUIElementSetAttributeValue(void *element, void *attribute, void *value)'),
    AXUIElementIsAttributeSettable: ax(
      'int32_t AXUIElementIsAttributeSettable(void *element, void *attribute, _Out_ bool *settable)',
    ),
    AXUIElementPerformAction: ax('int32_t AXUIElementPerformAction(void *element, void *action)'),
    AXUIElementCopyActionNames: ax('int32_t AXUIElementCopyActionNames(void *element, _Out_ void **names)'),
    AXUIElementCopyElementAtPosition: ax(
      'int32_t AXUIElementCopyElementAtPosition(void *application, float x, float y, _Out_ void **element)',
    ),
    AXUIElementGetPid: ax('int32_t AXUIElementGetPid(void *element, _Out_ int32_t *pid)'),
    AXUIElementSetMessagingTimeout: ax('int32_t AXUIElementSetMessagingTimeout(void *element, float timeoutInSeconds)'),
    AXValueCreate: ax('void *AXValueCreate(uint32_t theType, void *valuePtr)'),
    AXValueGetValue: ax('bool AXValueGetValue(void *value, uint32_t theType, void *valuePtr)'),
    AXValueGetTypeID: ax('unsigned long AXValueGetTypeID()'),
    _AXUIElementGetWindow: optional(() => ax('int32_t _AXUIElementGetWindow(void *element, _Out_ uint32_t *windowId)')),

    proc_listallpids: SYS.func('int proc_listallpids(void *buffer, int buffersize)'),
    proc_name: SYS.func('int proc_name(int pid, void *buffer, uint32_t buffersize)'),
    proc_pidpath: SYS.func('int proc_pidpath(int pid, void *buffer, uint32_t buffersize)'),
  } as MacApi;
}

function optional<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** macOS の API を取得する。macOS 以外や読み込み失敗時は例外を投げる。 */
export function mac(): MacApi {
  if (api) return api;
  if (loadError) throw loadError;
  if (process.platform !== 'darwin') {
    loadError = new Error('この PC 操作エンジンは macOS 専用です');
    throw loadError;
  }
  try {
    api = load();
    return api;
  } catch (err) {
    loadError = new Error(`macOS の API の読み込みに失敗しました: ${(err as Error).message}`);
    throw loadError;
  }
}

export function isMacAvailable(): boolean {
  try {
    mac();
    return true;
  } catch {
    return false;
  }
}

// ---- 定数 ----
export const kCGEventSourceStateCombinedSessionState = 0;
export const kCGEventSourceStateHIDSystemState = 1;
export const kCGHIDEventTap = 0;
export const kCGAnyInputEventType = 0xffffffff;

export const kCGEventLeftMouseDown = 1;
export const kCGEventLeftMouseUp = 2;
export const kCGEventRightMouseDown = 3;
export const kCGEventRightMouseUp = 4;
export const kCGEventMouseMoved = 5;
export const kCGEventLeftMouseDragged = 6;
export const kCGEventRightMouseDragged = 7;
export const kCGEventOtherMouseDown = 25;
export const kCGEventOtherMouseUp = 26;
export const kCGEventOtherMouseDragged = 27;

export const kCGMouseButtonLeft = 0;
export const kCGMouseButtonRight = 1;
export const kCGMouseButtonCenter = 2;
export const kCGMouseEventClickState = 1;
export const kCGScrollEventUnitLine = 1;

export const kCGWindowListOptionOnScreenOnly = 1;
export const kCGWindowListExcludeDesktopElements = 16;

export const kCFNumberSInt64Type = 4;
export const kCFNumberDoubleType = 13;

export const kAXValueCGPointType = 1;
export const kAXValueCGSizeType = 2;

export const kAXErrorSuccess = 0;
export const kAXErrorAPIDisabled = -25211;
export const kAXErrorNoValue = -25212;
export const kAXErrorAttributeUnsupported = -25205;
export const kAXErrorActionUnsupported = -25206;
export const kAXErrorCannotComplete = -25204;
