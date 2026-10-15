/**
 * CoreFoundation / Accessibility の値の読み書きヘルパー (macOS)。
 * 文字列は UTF-16 (CFStringCreateWithCharacters / CFStringGetCharacters) でやり取りするので日本語も壊れない。
 */
import {
  mac,
  kAXErrorAPIDisabled,
  kAXErrorSuccess,
  kAXValueCGPointType,
  kAXValueCGSizeType,
  kCFNumberDoubleType,
  kCFNumberSInt64Type,
} from './bindings';
import type { Point } from '../../../types/character';

type Ptr = unknown;

const stringCache = new Map<string, Ptr>();

/** CFString を作る (同じ文字列はキャッシュして使い回す。キャッシュしたものは解放しない) */
export function cfstr(s: string): Ptr {
  const cached = stringCache.get(s);
  if (cached) return cached;
  const p = cfstrNew(s);
  stringCache.set(s, p);
  return p;
}

/** CFString を新しく作る (呼び出し側で CFRelease すること) */
export function cfstrNew(s: string): Ptr {
  const buf = Buffer.from(s, 'utf16le');
  return mac().CFStringCreateWithCharacters(null, buf, s.length);
}

export function release(p: Ptr | null | undefined): void {
  if (p) mac().CFRelease(p);
}

export function readString(p: Ptr): string | null {
  const api = mac();
  if (!p || api.CFGetTypeID(p) !== api.CFStringGetTypeID()) return null;
  const len = api.CFStringGetLength(p);
  if (len <= 0) return '';
  const n = Math.min(len, 20000);
  const buf = Buffer.alloc(n * 2);
  api.CFStringGetCharacters(p, { location: 0, length: n }, buf);
  return buf.toString('utf16le');
}

export function readNumber(p: Ptr): number | null {
  const api = mac();
  if (!p) return null;
  const t = api.CFGetTypeID(p);
  if (t === api.CFBooleanGetTypeID()) return api.CFBooleanGetValue(p) ? 1 : 0;
  if (t !== api.CFNumberGetTypeID()) return null;
  const buf = Buffer.alloc(8);
  if (api.CFNumberGetValue(p, kCFNumberDoubleType, buf)) return buf.readDoubleLE(0);
  if (api.CFNumberGetValue(p, kCFNumberSInt64Type, buf)) return Number(buf.readBigInt64LE(0));
  return null;
}

export function readBool(p: Ptr): boolean | null {
  const n = readNumber(p);
  return n === null ? null : n !== 0;
}

/** CFArray を JS 配列にする (要素は借用。配列を解放したら使えないので、使う側で CFRetain する) */
export function arrayItems(arr: Ptr): Ptr[] {
  const api = mac();
  if (!arr || api.CFGetTypeID(arr) !== api.CFArrayGetTypeID()) return [];
  const n = api.CFArrayGetCount(arr);
  const out: Ptr[] = [];
  for (let i = 0; i < n; i++) out.push(api.CFArrayGetValueAtIndex(arr, i));
  return out;
}

export function dictGet(dict: Ptr, key: string): Ptr {
  return mac().CFDictionaryGetValue(dict, cfstr(key));
}

// ---- CFBoolean (kCFBooleanTrue / False はデータシンボルなので、プロパティリストから作る) ----
let cfTrue: Ptr = null;
let cfFalse: Ptr = null;

export function plist(xml: string): Ptr {
  const api = mac();
  const bytes = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0">${xml}</plist>`, 'utf8');
  const data = api.CFDataCreate(null, bytes, bytes.length);
  try {
    return api.CFPropertyListCreateWithData(null, data, 0, null, null);
  } finally {
    api.CFRelease(data);
  }
}

export function cfBool(v: boolean): Ptr {
  if (v) return (cfTrue ??= plist('<true/>'));
  return (cfFalse ??= plist('<false/>'));
}

// ---- Accessibility ----

export class AxError extends Error {
  constructor(
    readonly code: number,
    what: string,
  ) {
    super(
      code === kAXErrorAPIDisabled
        ? 'アクセシビリティの許可がありません。システム設定 > プライバシーとセキュリティ > アクセシビリティ で Gumi を許可してください'
        : `${what} に失敗しました (AXError ${code})`,
    );
    this.name = 'AxError';
  }
}

/** 属性値をコピーして返す (呼び出し側で release)。値が無ければ null */
export function axCopy(el: Ptr, attr: string): Ptr {
  const out: Ptr[] = [null];
  const err = mac().AXUIElementCopyAttributeValue(el, cfstr(attr), out);
  if (err === kAXErrorAPIDisabled) throw new AxError(err, attr);
  return err === kAXErrorSuccess ? out[0] : null;
}

export function axString(el: Ptr, attr: string): string | null {
  const v = axCopy(el, attr);
  try {
    return readString(v);
  } finally {
    release(v);
  }
}

export function axBool(el: Ptr, attr: string): boolean | null {
  const v = axCopy(el, attr);
  try {
    return readBool(v);
  } finally {
    release(v);
  }
}

/** AXPosition / AXSize を読む */
export function axPoint(el: Ptr, attr: 'AXPosition' | 'AXSize'): Point | null {
  const api = mac();
  const v = axCopy(el, attr);
  if (!v) return null;
  try {
    if (api.CFGetTypeID(v) !== api.AXValueGetTypeID()) return null;
    const buf = Buffer.alloc(16);
    const type = attr === 'AXPosition' ? kAXValueCGPointType : kAXValueCGSizeType;
    if (!api.AXValueGetValue(v, type, buf)) return null;
    return { x: buf.readDoubleLE(0), y: buf.readDoubleLE(8) };
  } finally {
    api.CFRelease(v);
  }
}

/** 子要素などの配列属性を、保持 (CFRetain) した要素の配列として返す。各要素は呼び出し側で release */
export function axElements(el: Ptr, attr: string): Ptr[] {
  const api = mac();
  const arr = axCopy(el, attr);
  if (!arr) return [];
  try {
    return arrayItems(arr).map((x) => api.CFRetain(x));
  } finally {
    api.CFRelease(arr);
  }
}

export function axActions(el: Ptr): string[] {
  const out: Ptr[] = [null];
  const err = mac().AXUIElementCopyActionNames(el, out);
  if (err !== kAXErrorSuccess || !out[0]) return [];
  try {
    return arrayItems(out[0])
      .map((s) => readString(s))
      .filter((s): s is string => !!s);
  } finally {
    release(out[0]);
  }
}

export function axSettable(el: Ptr, attr: string): boolean {
  const out = [false];
  return mac().AXUIElementIsAttributeSettable(el, cfstr(attr), out) === kAXErrorSuccess && !!out[0];
}

export function axSet(el: Ptr, attr: string, value: Ptr, what = attr): void {
  const err = mac().AXUIElementSetAttributeValue(el, cfstr(attr), value);
  if (err !== kAXErrorSuccess) throw new AxError(err, what);
}

export function axSetPoint(el: Ptr, attr: 'AXPosition' | 'AXSize', p: Point): void {
  const api = mac();
  const buf = Buffer.alloc(16);
  buf.writeDoubleLE(p.x, 0);
  buf.writeDoubleLE(p.y, 8);
  const v = api.AXValueCreate(attr === 'AXPosition' ? kAXValueCGPointType : kAXValueCGSizeType, buf);
  try {
    axSet(el, attr, v);
  } finally {
    api.CFRelease(v);
  }
}

export function axPerform(el: Ptr, action: string): void {
  const err = mac().AXUIElementPerformAction(el, cfstr(action));
  if (err !== kAXErrorSuccess) throw new AxError(err, action);
}

export function axPid(el: Ptr): number | null {
  const out = [0];
  return mac().AXUIElementGetPid(el, out) === kAXErrorSuccess ? out[0] : null;
}
