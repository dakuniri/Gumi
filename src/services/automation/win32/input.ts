/**
 * マウス・キーボード入力の注入 (SendInput)。
 *
 * - すべての座標は物理ピクセル (仮想スクリーン座標)。
 * - 押下中のキー / マウスボタンを追跡し、停止時に {@link InputController.releaseAll} で必ず解放する。
 * - SendInput が 0 を返した場合 (UIPI により管理者権限ウィンドウへの入力がブロックされた等) は例外を投げる。
 */
import {
  win32,
  IS_64BIT,
  SM_CXVIRTUALSCREEN,
  SM_CYVIRTUALSCREEN,
  SM_XVIRTUALSCREEN,
  SM_YVIRTUALSCREEN,
} from './bindings';
import {
  encodeInputs,
  inputLayout,
  toAbsolute,
  toUtf16Units,
  type InputData,
  KEYEVENTF_EXTENDEDKEY,
  KEYEVENTF_KEYUP,
  KEYEVENTF_UNICODE,
  MOUSEEVENTF_ABSOLUTE,
  MOUSEEVENTF_HWHEEL,
  MOUSEEVENTF_LEFTDOWN,
  MOUSEEVENTF_LEFTUP,
  MOUSEEVENTF_MIDDLEDOWN,
  MOUSEEVENTF_MIDDLEUP,
  MOUSEEVENTF_MOVE,
  MOUSEEVENTF_RIGHTDOWN,
  MOUSEEVENTF_RIGHTUP,
  MOUSEEVENTF_VIRTUALDESK,
  MOUSEEVENTF_WHEEL,
  WHEEL_DELTA,
} from './input-struct';
import type { KeySpec } from '../keys';
import { resolveKey as resolveKeyFor } from '../keys';
import type { InputDriver, InputHooks, MouseButton, ScrollDirection } from '../types';
import { sleep, throwIfAborted, type SpeedProfile } from '../util';
import type { Point } from '../../../types/character';

export type { MouseButton, ScrollDirection };

const resolveKey = (name: string) => resolveKeyFor(name, 'win32');

const BUTTON_FLAGS: Record<MouseButton, { down: number; up: number }> = {
  left: { down: MOUSEEVENTF_LEFTDOWN, up: MOUSEEVENTF_LEFTUP },
  right: { down: MOUSEEVENTF_RIGHTDOWN, up: MOUSEEVENTF_RIGHTUP },
  middle: { down: MOUSEEVENTF_MIDDLEDOWN, up: MOUSEEVENTF_MIDDLEUP },
};

const MAPVK_VK_TO_VSC = 0;

export class InputBlockedError extends Error {
  constructor() {
    super(
      '入力がシステムにブロックされました。対象が管理者権限で実行中のウィンドウか、セキュア デスクトップ (UAC 等) の可能性があります。',
    );
    this.name = 'InputBlockedError';
  }
}

export class InputController implements InputDriver {
  private pressedKeys = new Map<number, KeySpec>();
  private pressedButtons = new Set<MouseButton>();
  /** 最後に入力を注入した時刻 (performance.now 相当の ms, Date.now) */
  lastInjectionAt = 0;
  /** 最後に Gumi が設定したカーソル位置 */
  lastCursorSet: Point | null = null;
  private injectingDepth = 0;
  /** 入力注入の直前・直後に呼ばれるフック (Gumi ウィンドウのクリック透過など) */
  hooks: InputHooks = {};

  constructor(private readonly speed: () => SpeedProfile) {}

  get injecting(): boolean {
    return this.injectingDepth > 0;
  }

  private send(inputs: InputData[]): void {
    const api = win32();
    const buf = encodeInputs(inputs, IS_64BIT);
    const sent = api.SendInput(inputs.length, buf, inputLayout(IS_64BIT).size);
    this.lastInjectionAt = Date.now();
    if (sent !== inputs.length) throw new InputBlockedError();
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
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

  virtualScreen() {
    const api = win32();
    return {
      x: api.GetSystemMetrics(SM_XVIRTUALSCREEN),
      y: api.GetSystemMetrics(SM_YVIRTUALSCREEN),
      width: api.GetSystemMetrics(SM_CXVIRTUALSCREEN),
      height: api.GetSystemMetrics(SM_CYVIRTUALSCREEN),
    };
  }

  getCursor(): Point {
    const buf = Buffer.alloc(8);
    if (!win32().GetCursorPos(buf)) throw new Error('カーソル位置を取得できませんでした');
    return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) };
  }

  /** カーソルを指定位置へ移動 (smooth 時はイージングで補間しながら移動) */
  async moveTo(x: number, y: number, opts: { smooth?: boolean; durationMs?: number; signal?: AbortSignal } = {}) {
    const target = { x: Math.round(x), y: Math.round(y) };
    const virt = this.virtualScreen();
    if (
      target.x < virt.x ||
      target.y < virt.y ||
      target.x >= virt.x + virt.width ||
      target.y >= virt.y + virt.height
    ) {
      throw new Error(`座標 (${target.x}, ${target.y}) は画面外です`);
    }
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
          const px = start.x + (target.x - start.x) * e;
          const py = start.y + (target.y - start.y) * e;
          this.sendAbsoluteMove(px, py, virt);
          await sleep(duration / steps, opts.signal);
        }
      } else {
        this.sendAbsoluteMove(target.x, target.y, virt);
      }
      // 正規化座標の丸め誤差を補正
      win32().SetCursorPos(target.x, target.y);
      this.hooks.moved?.(target);
      this.lastCursorSet = target;
    });
  }

  private sendAbsoluteMove(x: number, y: number, virt: ReturnType<InputController['virtualScreen']>) {
    this.hooks.moved?.({ x: Math.round(x), y: Math.round(y) });
    const { dx, dy } = toAbsolute(x, y, virt);
    this.send([
      { type: 'mouse', dx, dy, flags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK },
    ]);
  }

  async mouseDown(button: MouseButton = 'left') {
    await this.guard(async () => {
      this.send([{ type: 'mouse', flags: BUTTON_FLAGS[button].down }]);
      this.pressedButtons.add(button);
    });
  }

  async mouseUp(button: MouseButton = 'left') {
    await this.guard(async () => {
      this.send([{ type: 'mouse', flags: BUTTON_FLAGS[button].up }]);
      this.pressedButtons.delete(button);
    });
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
          this.send([{ type: 'mouse', flags: BUTTON_FLAGS[button].down }]);
          this.pressedButtons.add(button);
          await sleep(25);
          this.send([{ type: 'mouse', flags: BUTTON_FLAGS[button].up }]);
          this.pressedButtons.delete(button);
          if (i < clicks - 1) await sleep(Math.min(80, this.speed().clickGapMs));
        }
      } finally {
        for (const m of [...mods].reverse()) await this.keyUp(m);
      }
    });
  }

  /** ボタンを指定時間押し続ける (長押し) */
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

  async drag(opts: {
    from: Point;
    to: Point;
    button?: MouseButton;
    durationMs?: number;
    signal?: AbortSignal;
  }) {
    const button = opts.button ?? 'left';
    await this.guard(async () => {
      await this.moveTo(opts.from.x, opts.from.y, { signal: opts.signal });
      await sleep(60, opts.signal);
      await this.mouseDown(button);
      try {
        await sleep(80, opts.signal);
        // ドラッグ開始のしきい値を超えるよう少しずらしてから移動する
        const virt = this.virtualScreen();
        this.sendAbsoluteMove(opts.from.x + 4, opts.from.y + 4, virt);
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
      for (let i = 0; i < notches; i++) {
        throwIfAborted(opts.signal);
        const vertical = opts.direction === 'up' || opts.direction === 'down';
        // 縦: 正 = 上方向, 横: 正 = 右方向
        const sign = opts.direction === 'up' || opts.direction === 'right' ? 1 : -1;
        this.send([
          {
            type: 'mouse',
            mouseData: sign * WHEEL_DELTA,
            flags: vertical ? MOUSEEVENTF_WHEEL : MOUSEEVENTF_HWHEEL,
          },
        ]);
        await sleep(30, opts.signal);
      }
    });
  }

  private keyInput(spec: KeySpec, up: boolean): InputData {
    const scan = win32().MapVirtualKeyW(spec.vk, MAPVK_VK_TO_VSC);
    let flags = up ? KEYEVENTF_KEYUP : 0;
    if (spec.extended) flags |= KEYEVENTF_EXTENDEDKEY;
    return { type: 'keyboard', vk: spec.vk, scan, flags };
  }

  async keyDown(spec: KeySpec) {
    await this.guard(async () => {
      this.send([this.keyInput(spec, false)]);
      this.pressedKeys.set(spec.vk, spec);
    });
  }

  async keyUp(spec: KeySpec) {
    await this.guard(async () => {
      this.send([this.keyInput(spec, true)]);
      this.pressedKeys.delete(spec.vk);
    });
  }

  /** ショートカット (同時押し) を送信する */
  async pressCombo(keys: KeySpec[], opts: { repeat?: number; signal?: AbortSignal } = {}) {
    const repeat = Math.max(1, Math.min(100, opts.repeat ?? 1));
    await this.guard(async () => {
      for (let r = 0; r < repeat; r++) {
        throwIfAborted(opts.signal);
        const pressed: KeySpec[] = [];
        try {
          for (const k of keys) {
            await this.keyDown(k);
            pressed.push(k);
            await sleep(15);
          }
          await sleep(30);
        } finally {
          for (const k of pressed.reverse()) {
            await this.keyUp(k);
            await sleep(10);
          }
        }
        if (r < repeat - 1) await sleep(Math.max(20, this.speed().keyDelayMs * 3), opts.signal);
      }
    });
  }

  async holdKey(spec: KeySpec, durationMs: number, signal?: AbortSignal) {
    await this.guard(async () => {
      await this.keyDown(spec);
      try {
        await sleep(durationMs, signal);
      } finally {
        await this.keyUp(spec);
      }
    });
  }

  /**
   * Unicode 文字として直接入力する (KEYEVENTF_UNICODE / VK_PACKET)。
   * IME の変換を経由しないため、日本語 IME が有効でもそのままの文字列が入力される。
   */
  async typeUnicode(text: string, signal?: AbortSignal) {
    const delay = this.speed().keyDelayMs;
    await this.guard(async () => {
      const chars = Array.from(text.replace(/\r\n/g, '\n'));
      for (const ch of chars) {
        throwIfAborted(signal);
        if (ch === '\n') {
          await this.pressCombo([resolveKey('enter')]);
        } else if (ch === '\t') {
          await this.pressCombo([resolveKey('tab')]);
        } else {
          const units = toUtf16Units(ch);
          const downs: InputData[] = units.map((u) => ({ type: 'keyboard', vk: 0, scan: u, flags: KEYEVENTF_UNICODE }));
          const ups: InputData[] = units.map((u) => ({
            type: 'keyboard',
            vk: 0,
            scan: u,
            flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
          }));
          this.send([...downs, ...ups]);
        }
        if (delay > 0) await sleep(delay);
      }
    });
  }

  /** 押下中のすべてのキー・マウスボタンを解放する (停止時に必ず呼ばれる) */
  releaseAll(): { keys: number; buttons: number } {
    let keys = 0;
    let buttons = 0;
    for (const spec of [...this.pressedKeys.values()].reverse()) {
      try {
        this.send([this.keyInput(spec, true)]);
        keys++;
      } catch {
        /* 続行 */
      }
    }
    this.pressedKeys.clear();
    for (const b of this.pressedButtons) {
      try {
        this.send([{ type: 'mouse', flags: BUTTON_FLAGS[b].up }]);
        buttons++;
      } catch {
        /* 続行 */
      }
    }
    this.pressedButtons.clear();
    // 修飾キーが物理的に押されたままに見える場合への保険 (Gumi が押していなくても keyup は無害)
    for (const name of ['shift', 'ctrl', 'alt', 'win']) {
      try {
        const spec = resolveKey(name);
        if (win32().GetAsyncKeyState(spec.vk) & 0x8000) {
          this.send([this.keyInput(spec, true)]);
          keys++;
        }
      } catch {
        /* 続行 */
      }
    }
    this.injectingDepth = 0;
    return { keys, buttons };
  }

  get heldState(): { keys: string[]; buttons: MouseButton[] } {
    return {
      keys: [...this.pressedKeys.values()].map((k) => k.name),
      buttons: [...this.pressedButtons],
    };
  }

  /** システム全体で最後に入力があってからの経過ミリ秒 (GetLastInputInfo / GetTickCount) */
  msSinceLastInput(): number {
    const api = win32();
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE(8, 0);
    api.GetLastInputInfo(buf);
    // 32bit tick のラップアラウンドを考慮
    return (api.GetTickCount() - buf.readUInt32LE(4)) >>> 0;
  }

  isMouseButtonDown(button: MouseButton = 'left'): boolean {
    const vk = button === 'left' ? 0x01 : button === 'right' ? 0x02 : 0x04;
    return (win32().GetAsyncKeyState(vk) & 0x8000) !== 0;
  }
}
