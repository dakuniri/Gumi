/**
 * マウス・キーボード入力の注入 (macOS / CoreGraphics の CGEvent)。
 *
 * - 座標はグローバル表示座標 (ポイント)。Electron の DIP と同じ。
 * - 修飾キーは押下中のものを追跡し、すべてのイベントに CGEventFlags として付ける
 *   (macOS は修飾キーの状態をイベントのフラグで判定するため)。
 * - ダブルクリックはクリック回数 (kCGMouseEventClickState) を付けて送る。
 * - ボタンを押したままの移動は Dragged イベントにする (ドラッグ & ドロップのため)。
 * - アクセシビリティの許可が無いと CGEventPost は黙って無視されるので、事前に確認して分かりやすいエラーにする。
 */
import {
  mac,
  kCGAnyInputEventType,
  kCGEventLeftMouseDown,
  kCGEventLeftMouseDragged,
  kCGEventLeftMouseUp,
  kCGEventMouseMoved,
  kCGEventOtherMouseDown,
  kCGEventOtherMouseDragged,
  kCGEventOtherMouseUp,
  kCGEventRightMouseDown,
  kCGEventRightMouseDragged,
  kCGEventRightMouseUp,
  kCGEventSourceStateCombinedSessionState,
  kCGEventSourceStateHIDSystemState,
  kCGHIDEventTap,
  kCGMouseButtonCenter,
  kCGMouseButtonLeft,
  kCGMouseButtonRight,
  kCGMouseEventClickState,
  kCGScrollEventUnitLine,
} from './bindings';
import { MAC_FLAGS, resolveKey as resolveKeyFor, type KeySpec } from '../keys';
import type { InputDriver, InputHooks, MouseButton, ScrollDirection } from '../types';
import { sleep, throwIfAborted, type SpeedProfile } from '../util';
import type { Point, Rect } from '../../../types/character';

const resolveKey = (name: string) => resolveKeyFor(name, 'darwin');

const BUTTONS: Record<MouseButton, { down: number; up: number; drag: number; code: number }> = {
  left: { down: kCGEventLeftMouseDown, up: kCGEventLeftMouseUp, drag: kCGEventLeftMouseDragged, code: kCGMouseButtonLeft },
  right: { down: kCGEventRightMouseDown, up: kCGEventRightMouseUp, drag: kCGEventRightMouseDragged, code: kCGMouseButtonRight },
  middle: {
    down: kCGEventOtherMouseDown,
    up: kCGEventOtherMouseUp,
    drag: kCGEventOtherMouseDragged,
    code: kCGMouseButtonCenter,
  },
};

/** 修飾キー名 -> CGEventFlags */
function modifierFlag(name: string): number {
  switch (name) {
    case 'shift':
    case 'lshift':
    case 'rshift':
      return MAC_FLAGS.shift;
    case 'ctrl':
    case 'lctrl':
    case 'rctrl':
      return MAC_FLAGS.ctrl;
    case 'alt':
    case 'lalt':
    case 'ralt':
      return MAC_FLAGS.alt;
    case 'cmd':
    case 'lcmd':
    case 'rcmd':
      return MAC_FLAGS.cmd;
    case 'fn':
      return MAC_FLAGS.fn;
    default:
      return 0;
  }
}

/** 物理的に押されたままに見える場合に解放する修飾キー (kVK) */
const MODIFIER_KEYCODES = [0x37, 0x36, 0x38, 0x3c, 0x3a, 0x3d, 0x3b, 0x3e, 0x3f];

/** 1 ノッチあたりのスクロール行数 (Windows の既定と同じ 3 行) */
const LINES_PER_NOTCH = 3;

export class AccessibilityDeniedError extends Error {
  constructor() {
    super(
      'マウス・キーボードを操作する許可がありません。システム設定 > プライバシーとセキュリティ > アクセシビリティ で Gumi をオンにしてください (オンにした後は Gumi の再起動が必要な場合があります)',
    );
    this.name = 'AccessibilityDeniedError';
  }
}

export class MacInputController implements InputDriver {
  private pressedKeys = new Map<number, KeySpec>();
  private pressedButtons = new Set<MouseButton>();
  lastInjectionAt = 0;
  hooks: InputHooks = {};
  private injectingDepth = 0;
  private source: unknown = null;
  private trustedAt = 0;

  constructor(private readonly speed: () => SpeedProfile) {}

  get injecting(): boolean {
    return this.injectingDepth > 0;
  }

  private src(): unknown {
    // HID システム状態のソース: ハードウェア入力と同じ扱いになり、アプリに届きやすい
    this.source ??= mac().CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    return this.source;
  }

  /** アクセシビリティの許可を確認する (結果は 2 秒キャッシュ) */
  private ensureTrusted(): void {
    if (Date.now() - this.trustedAt < 2000) return;
    if (!mac().AXIsProcessTrusted()) throw new AccessibilityDeniedError();
    this.trustedAt = Date.now();
  }

  /** 押下中の修飾キーのフラグ */
  private flags(): number {
    let f = 0;
    for (const k of this.pressedKeys.values()) f |= modifierFlag(k.name);
    return f;
  }

  private post(event: unknown, flags = this.flags()): void {
    const api = mac();
    try {
      api.CGEventSetFlags(event, flags);
      api.CGEventPost(kCGHIDEventTap, event);
    } finally {
      api.CFRelease(event);
    }
    this.lastInjectionAt = Date.now();
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    this.ensureTrusted();
    if (this.injectingDepth === 0) this.hooks.before?.();
    this.injectingDepth++;
    try {
      return await fn();
    } finally {
      this.injectingDepth = Math.max(0, this.injectingDepth - 1);
      this.lastInjectionAt = Date.now();
      if (this.injectingDepth === 0) this.hooks.after?.();
    }
  }

  /** 接続中のディスプレイの矩形 (ポイント) */
  displays(): Rect[] {
    const api = mac();
    const ids = Buffer.alloc(4 * 32);
    const count = Buffer.alloc(4);
    if (api.CGGetActiveDisplayList(32, ids, count) !== 0) return [];
    const n = count.readUInt32LE(0);
    const out: Rect[] = [];
    for (let i = 0; i < n; i++) {
      const b = api.CGDisplayBounds(ids.readUInt32LE(i * 4));
      out.push({ x: b.x, y: b.y, width: b.width, height: b.height });
    }
    return out;
  }

  virtualScreen(): Rect {
    const ds = this.displays();
    if (ds.length === 0) {
      const b = mac().CGDisplayBounds(mac().CGMainDisplayID());
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    }
    const x = Math.min(...ds.map((d) => d.x));
    const y = Math.min(...ds.map((d) => d.y));
    const r = Math.max(...ds.map((d) => d.x + d.width));
    const btm = Math.max(...ds.map((d) => d.y + d.height));
    return { x, y, width: r - x, height: btm - y };
  }

  getCursor(): Point {
    const api = mac();
    const ev = api.CGEventCreate(null);
    if (!ev) throw new Error('カーソル位置を取得できませんでした');
    try {
      const p = api.CGEventGetLocation(ev);
      return { x: Math.round(p.x), y: Math.round(p.y) };
    } finally {
      api.CFRelease(ev);
    }
  }

  private onScreen(p: Point): boolean {
    const ds = this.displays();
    if (ds.length === 0) return true;
    return ds.some((d) => p.x >= d.x && p.y >= d.y && p.x < d.x + d.width && p.y < d.y + d.height);
  }

  /** ボタン押下中ならドラッグ、そうでなければ移動のイベントを送る */
  private sendMove(x: number, y: number): void {
    const api = mac();
    const held = [...this.pressedButtons][0];
    const type = held ? BUTTONS[held].drag : kCGEventMouseMoved;
    const code = held ? BUTTONS[held].code : kCGMouseButtonLeft;
    const pos = { x, y };
    this.hooks.moved?.({ x: Math.round(x), y: Math.round(y) });
    this.post(api.CGEventCreateMouseEvent(this.src(), type, pos, code));
  }

  async moveTo(x: number, y: number, opts: { smooth?: boolean; durationMs?: number; signal?: AbortSignal } = {}) {
    const target = { x: Math.round(x), y: Math.round(y) };
    if (!this.onScreen(target)) throw new Error(`座標 (${target.x}, ${target.y}) は画面外です`);
    await this.guard(async () => {
      const smooth = opts.smooth ?? true;
      const duration = opts.durationMs ?? this.speed().moveDurationMs;
      const start = this.getCursor();
      const dist = Math.hypot(target.x - start.x, target.y - start.y);
      if (smooth && duration > 0 && dist > 3) {
        const steps = Math.max(2, Math.min(60, Math.round(duration / 10)));
        for (let i = 1; i <= steps; i++) {
          throwIfAborted(opts.signal);
          const t = i / steps;
          const e = 1 - Math.pow(1 - t, 3);
          this.sendMove(start.x + (target.x - start.x) * e, start.y + (target.y - start.y) * e);
          await sleep(duration / steps, opts.signal);
        }
      } else {
        this.sendMove(target.x, target.y);
      }
      this.hooks.moved?.(target);
    });
  }

  private sendButton(button: MouseButton, down: boolean, clickState = 1): void {
    const api = mac();
    const b = BUTTONS[button];
    const pos = this.getCursor();
    const ev = api.CGEventCreateMouseEvent(this.src(), down ? b.down : b.up, pos, b.code);
    api.CGEventSetIntegerValueField(ev, kCGMouseEventClickState, clickState);
    this.post(ev);
    if (down) this.pressedButtons.add(button);
    else this.pressedButtons.delete(button);
  }

  async mouseDown(button: MouseButton = 'left') {
    await this.guard(async () => this.sendButton(button, true));
  }

  async mouseUp(button: MouseButton = 'left') {
    await this.guard(async () => this.sendButton(button, false));
  }

  async click(opts: {
    x?: number;
    y?: number;
    button?: MouseButton;
    clicks?: number;
    modifiers?: KeySpec[];
    signal?: AbortSignal;
  }) {
    const button = opts.button ?? 'left';
    const clicks = Math.max(1, Math.min(3, opts.clicks ?? 1));
    await this.guard(async () => {
      if (opts.x !== undefined && opts.y !== undefined) {
        await this.moveTo(opts.x, opts.y, { signal: opts.signal });
        await sleep(30, opts.signal);
      }
      const mods = opts.modifiers ?? [];
      for (const m of mods) await this.keyDown(m);
      try {
        for (let i = 0; i < clicks; i++) {
          throwIfAborted(opts.signal);
          // 2 回目以降はクリック回数を増やして送る (ダブルクリック / トリプルクリックとして認識させる)
          this.sendButton(button, true, i + 1);
          await sleep(25);
          this.sendButton(button, false, i + 1);
          if (i < clicks - 1) await sleep(Math.min(80, this.speed().clickGapMs));
        }
      } finally {
        for (const m of [...mods].reverse()) await this.keyUp(m);
      }
    });
  }

  async hold(opts: { x?: number; y?: number; button?: MouseButton; durationMs: number; signal?: AbortSignal }) {
    const button = opts.button ?? 'left';
    await this.guard(async () => {
      if (opts.x !== undefined && opts.y !== undefined) await this.moveTo(opts.x, opts.y, { signal: opts.signal });
      await this.mouseDown(button);
      try {
        await sleep(opts.durationMs, opts.signal);
      } finally {
        await this.mouseUp(button);
      }
    });
  }

  async drag(opts: { from: Point; to: Point; button?: MouseButton; durationMs?: number; signal?: AbortSignal }) {
    const button = opts.button ?? 'left';
    await this.guard(async () => {
      await this.moveTo(opts.from.x, opts.from.y, { signal: opts.signal });
      await sleep(60, opts.signal);
      await this.mouseDown(button);
      try {
        await sleep(80, opts.signal);
        // ドラッグ開始のしきい値を超えるよう少しずらしてから移動する
        this.sendMove(opts.from.x + 4, opts.from.y + 4);
        await sleep(40, opts.signal);
        await this.moveTo(opts.to.x, opts.to.y, {
          smooth: true,
          durationMs: Math.max(200, opts.durationMs ?? 500),
          signal: opts.signal,
        });
        await sleep(120, opts.signal);
      } finally {
        await this.mouseUp(button);
      }
    });
  }

  async scroll(opts: { x?: number; y?: number; direction: ScrollDirection; amount: number; signal?: AbortSignal }) {
    const notches = Math.max(1, Math.min(50, Math.round(opts.amount)));
    await this.guard(async () => {
      if (opts.x !== undefined && opts.y !== undefined) await this.moveTo(opts.x, opts.y, { signal: opts.signal });
      const api = mac();
      for (let i = 0; i < notches; i++) {
        throwIfAborted(opts.signal);
        // wheel1: 縦 (正 = 上) / wheel2: 横 (正 = 左)
        const v = opts.direction === 'up' ? LINES_PER_NOTCH : opts.direction === 'down' ? -LINES_PER_NOTCH : 0;
        const h = opts.direction === 'left' ? LINES_PER_NOTCH : opts.direction === 'right' ? -LINES_PER_NOTCH : 0;
        this.post(api.CGEventCreateScrollWheelEvent2(this.src(), kCGScrollEventUnitLine, 2, v, h, 0));
        await sleep(30, opts.signal);
      }
    });
  }

  private sendKey(spec: KeySpec, down: boolean): void {
    const api = mac();
    if (down) this.pressedKeys.set(spec.vk, spec);
    else this.pressedKeys.delete(spec.vk);
    // 修飾キー自身のイベントにも、押下後 (離した後) の状態のフラグを付ける
    this.post(api.CGEventCreateKeyboardEvent(this.src(), spec.vk, down));
  }

  async keyDown(spec: KeySpec) {
    await this.guard(async () => this.sendKey(spec, true));
  }

  async keyUp(spec: KeySpec) {
    await this.guard(async () => this.sendKey(spec, false));
  }

  async pressCombo(keys: KeySpec[], opts: { repeat?: number; signal?: AbortSignal } = {}) {
    const repeat = Math.max(1, Math.min(100, opts.repeat ?? 1));
    await this.guard(async () => {
      for (let r = 0; r < repeat; r++) {
        throwIfAborted(opts.signal);
        const pressed: KeySpec[] = [];
        try {
          for (const k of keys) {
            this.sendKey(k, true);
            pressed.push(k);
            await sleep(15);
          }
          await sleep(30);
        } finally {
          for (const k of pressed.reverse()) {
            this.sendKey(k, false);
            await sleep(10);
          }
        }
        if (r < repeat - 1) await sleep(Math.max(20, this.speed().keyDelayMs * 3), opts.signal);
      }
    });
  }

  async holdKey(spec: KeySpec, durationMs: number, signal?: AbortSignal) {
    await this.guard(async () => {
      this.sendKey(spec, true);
      try {
        await sleep(durationMs, signal);
      } finally {
        this.sendKey(spec, false);
      }
    });
  }

  /**
   * Unicode 文字として直接入力する (CGEventKeyboardSetUnicodeString)。
   * 修飾キーのフラグは付けない (押下中の Command などで別のショートカットにならないように)。
   */
  async typeUnicode(text: string, signal?: AbortSignal) {
    const delay = this.speed().keyDelayMs;
    await this.guard(async () => {
      const api = mac();
      for (const ch of Array.from(text.replace(/\r\n/g, '\n'))) {
        throwIfAborted(signal);
        if (ch === '\n') await this.pressCombo([resolveKey('enter')]);
        else if (ch === '\t') await this.pressCombo([resolveKey('tab')]);
        else {
          const units = Buffer.from(ch, 'utf16le');
          const len = units.length / 2;
          const down = api.CGEventCreateKeyboardEvent(this.src(), 0, true);
          api.CGEventKeyboardSetUnicodeString(down, len, units);
          this.post(down, 0);
          const up = api.CGEventCreateKeyboardEvent(this.src(), 0, false);
          api.CGEventKeyboardSetUnicodeString(up, len, units);
          this.post(up, 0);
        }
        if (delay > 0) await sleep(delay);
      }
    });
  }

  releaseAll(): { keys: number; buttons: number } {
    let keys = 0;
    let buttons = 0;
    let api: ReturnType<typeof mac>;
    try {
      api = mac();
    } catch {
      return { keys, buttons };
    }
    for (const spec of [...this.pressedKeys.values()].reverse()) {
      try {
        this.sendKey(spec, false);
        keys++;
      } catch {
        /* 続行 */
      }
    }
    this.pressedKeys.clear();
    for (const b of [...this.pressedButtons]) {
      try {
        this.sendButton(b, false);
        buttons++;
      } catch {
        /* 続行 */
      }
    }
    this.pressedButtons.clear();
    // 修飾キーが押されたままに見える場合への保険
    for (const code of MODIFIER_KEYCODES) {
      try {
        if (api.CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, code)) {
          this.post(api.CGEventCreateKeyboardEvent(this.src(), code, false), 0);
          keys++;
        }
      } catch {
        /* 続行 */
      }
    }
    this.injectingDepth = 0;
    return { keys, buttons };
  }

  /** システム全体で最後に入力があってからの経過ミリ秒 */
  msSinceLastInput(): number {
    const sec = mac().CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType);
    return Math.max(0, Math.round(sec * 1000));
  }

  isMouseButtonDown(button: MouseButton = 'left'): boolean {
    return mac().CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, BUTTONS[button].code);
  }
}
