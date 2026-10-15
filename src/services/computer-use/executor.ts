/**
 * ComputerUseExecutor — 検証済みのツール呼び出しを PC 操作エンジンへ橋渡しする。
 *
 * - AI の座標 (スクリーンショット画像座標) を物理座標に変換して入力を注入する。
 * - 操作後は待機してから再撮影し、画面変化の有無を結果に含める (実行結果の確認)。
 * - Gumi 自身のウィンドウは操作・列挙の対象外。
 * - 返すテキストは機密情報のマスキングを通す。
 */
import type { Settings } from '../settings/schema';
import type { Automation, MouseButton, UiElement, WindowInfo } from '../automation/types';
import type { CaptureOptions, CaptureResult, DisplayInfo } from '../screenshots/capture';
import type { ShellApi, StartApp } from '../automation/types';
import type { KnownFolders } from '../automation/files';
import type { ContentPart } from '../ai/types';
import type { Point, Rect } from '../../types/character';
import * as files from '../automation/files';
import { parseCombo, resolveKey, isForbiddenCombo, acceleratorToCombo, pasteCombo } from '../automation/keys';
import { SPEED_PROFILES, sleep, throwIfAborted } from '../automation/util';
import {
  createFrame,
  imageToScreen,
  rectCenter,
  screenRectToImage,
  screenToImage,
  overlapArea,
  type CaptureFrame,
} from './coords';
import { compareFingerprints, describeChange } from '../screenshots/diff';
import { redactSecrets, matchBlockedKeyword } from './redact';
import { truncate } from './tools';
import { MAX_FETCHED_SITES, formatWebSearch, runWebSearch } from '../web/search';

export interface ExecutorDeps {
  /** OS ごとの PC 操作エンジン (Windows / macOS) */
  automation: Automation;
  settings: () => Settings;
  clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
  shell: ShellApi & { trashItem(path: string): Promise<void> };
  knownFolders: KnownFolders;
  protectedRoots: string[];
  /** Gumi 自身のプロセス ID (操作対象から除外) */
  excludePids: number[];
  displays: () => DisplayInfo[];
  capture: (opts: CaptureOptions) => Promise<CaptureResult>;
  /** 撮影前後に Gumi を隠す処理 (設定で有効な場合) */
  gumi: { excludeFromCapture(): Promise<void>; includeInCapture(): void };
}

export interface ToolOutcome {
  content: ContentPart[];
  isError: boolean;
  /** UI 表示用の短い結果 */
  summary: string;
  screenChanged?: boolean | null;
  sentImage?: boolean;
}

export interface ObserveResult {
  parts: ContentPart[];
  summary: string;
  sentImage: boolean;
  blocked: string | null;
}

class ToolError extends Error {}

export class ComputerUseExecutor {
  private frame: CaptureFrame | null = null;
  private targetDisplayId: number | null = null;
  private lastFingerprint: Uint8Array | null = null;
  private elementRects = new Map<number, Rect>();
  private startAppsCache: { at: number; apps: StartApp[] } | null = null;
  vision = true;

  constructor(private readonly deps: ExecutorDeps) {}

  private get settings() {
    return this.deps.settings();
  }

  private get input() {
    return this.deps.automation.input;
  }

  private get win() {
    return this.deps.automation.windows;
  }

  private get ui() {
    return this.deps.automation.ui;
  }

  private get isMac() {
    return this.deps.automation.platform === 'darwin';
  }

  private get speed() {
    return SPEED_PROFILES[this.settings.agent.speed];
  }

  // ------------------------------------------------------------------
  // 対象ディスプレイと座標フレーム
  // ------------------------------------------------------------------

  /** タスク開始時に対象ディスプレイを決める */
  prepareTask(): void {
    this.elementRects.clear();
    this.lastFingerprint = null;
    const displays = this.deps.displays();
    const scope = this.settings.screenshot.scope;
    let target: DisplayInfo | undefined;
    if (scope === 'primary-display') target = displays.find((d) => d.primary);
    else {
      try {
        const c = this.input.getCursor();
        target = displays.find((d) => contains(d.physical, c));
      } catch {
        /* 操作エンジン不可 */
      }
    }
    target ??= displays.find((d) => d.primary) ?? displays[0];
    this.targetDisplayId = target?.id ?? null;
    this.frame = target ? createFrame(target.physical, this.settings.screenshot.maxLongEdge, target) : null;
  }

  private targetDisplay(): DisplayInfo {
    const displays = this.deps.displays();
    const d = displays.find((x) => x.id === this.targetDisplayId) ?? displays.find((x) => x.primary) ?? displays[0];
    if (!d) throw new ToolError('ディスプレイが見つかりません');
    return d;
  }

  currentFrame(): CaptureFrame {
    if (!this.frame) {
      const d = this.targetDisplay();
      this.frame = createFrame(d.physical, this.settings.screenshot.maxLongEdge, d);
    }
    return this.frame;
  }

  /** 画像座標を物理座標に変換する (予約クリック用に公開) */
  resolvePoint(x: number, y: number): Point {
    return this.toScreen(x, y);
  }

  /** 予約したクリックを物理座標で実行する */
  async clickPhysical(p: Point, button: MouseButton, clicks: number, signal: AbortSignal): Promise<void> {
    await this.input.click({ x: p.x, y: p.y, button, clicks, signal });
  }

  private toScreen(x: number, y: number): Point {
    const f = this.currentFrame();
    const tol = 2;
    if (x < -tol || y < -tol || x > f.imageWidth + tol || y > f.imageHeight + tol) {
      throw new ToolError(
        `Coordinate (${x}, ${y}) is outside the screenshot (${f.imageWidth}x${f.imageHeight}). Take a screenshot and use its pixel coordinates.`,
      );
    }
    return imageToScreen(f, {
      x: Math.min(Math.max(0, x), f.imageWidth - 1),
      y: Math.min(Math.max(0, y), f.imageHeight - 1),
    });
  }

  private toImage(p: Point): Point {
    return screenToImage(this.currentFrame(), p);
  }

  // ------------------------------------------------------------------
  // 観察 (スクリーンショット)
  // ------------------------------------------------------------------

  /** 画面を撮影して AI へ渡すコンテンツを作る */
  async observe(opts: { image: boolean; header?: string }): Promise<ObserveResult> {
    const s = this.settings.screenshot;
    const display = this.targetDisplay();
    let region: Rect | undefined;
    let fg: WindowInfo | null = null;
    await this.win.sync?.().catch(() => undefined);
    try {
      fg = this.win.foreground();
    } catch {
      fg = null;
    }
    if (fg && this.deps.excludePids.includes(fg.pid)) fg = null;
    if (s.scope === 'active-window' && fg && !fg.minimized && overlapArea(fg.rect, display.physical) > 0) {
      region = fg.rect;
    }

    const lines: string[] = [];
    if (opts.header) lines.push(opts.header);
    lines.push(`Active window: ${fg ? `"${fg.title}" (${fg.processName}, hwnd=${fg.hwnd})` : '(none / desktop)'}`);

    if (!opts.image || !this.vision) {
      // 画像なしでも座標フレームは維持する
      this.frame = createFrame(region ?? display.physical, s.maxLongEdge, display);
      return { parts: [{ type: 'text', text: lines.join('\n') }], summary: 'テキスト情報のみ取得', sentImage: false, blocked: null };
    }

    // 機密の可能性があるウィンドウが表示されている場合は撮影しない
    const blocked = this.findBlockedWindow(display);
    if (blocked) {
      this.frame = createFrame(region ?? display.physical, s.maxLongEdge, display);
      lines.push(
        `Screenshot was NOT taken because a window that may contain sensitive information is visible ("${blocked}"). Ask the user (ask_user) to close or hide it before continuing.`,
      );
      return {
        parts: [{ type: 'text', text: lines.join('\n') }],
        summary: `機密の可能性があるウィンドウ「${blocked}」のため撮影を中止`,
        sentImage: false,
        blocked,
      };
    }

    if (s.hideGumiDuringCapture) await this.deps.gumi.excludeFromCapture();
    let shot: CaptureResult;
    try {
      shot = await this.deps.capture({
        display,
        region,
        maxLongEdge: s.maxLongEdge,
        jpegQuality: s.jpegQuality,
      });
    } finally {
      if (s.hideGumiDuringCapture) this.deps.gumi.includeInCapture();
    }
    this.frame = shot.frame;
    this.lastFingerprint = shot.fingerprint;
    let cursorText = '';
    try {
      const c = this.toImage(this.input.getCursor());
      cursorText = `, cursor at (${c.x}, ${c.y})`;
    } catch {
      /* ignore */
    }
    lines.push(
      `Screenshot: display ${display.index + 1}${display.primary ? ' (primary)' : ''}${region ? ' — active window only' : ''}, image ${shot.frame.imageWidth}x${shot.frame.imageHeight}px${cursorText}.`,
    );
    return {
      parts: [
        { type: 'text', text: lines.join('\n') },
        { type: 'image', mediaType: shot.mediaType, data: shot.base64 },
      ],
      summary: `画面を撮影 (${shot.frame.imageWidth}×${shot.frame.imageHeight}, ${Math.round(shot.bytes / 1024)}KB)`,
      sentImage: true,
      blocked: null,
    };
  }

  private findBlockedWindow(display: DisplayInfo): string | null {
    const keywords = this.settings.screenshot.blockedWindowKeywords;
    if (keywords.length === 0) return null;
    try {
      for (const w of this.win.list(this.deps.excludePids)) {
        if (w.minimized || overlapArea(w.rect, display.physical) === 0) continue;
        const hit = matchBlockedKeyword(w.title, keywords);
        if (hit) return w.title;
      }
    } catch {
      /* 列挙できない場合はチェックを省略 */
    }
    return null;
  }

  // ------------------------------------------------------------------
  // 実行
  // ------------------------------------------------------------------

  async execute(
    name: string,
    args: Record<string, unknown>,
    opts: { signal: AbortSignal; verify: boolean },
  ): Promise<ToolOutcome> {
    try {
      throwIfAborted(opts.signal);
      const r = await this.dispatch(name, args, opts.signal);
      if (r.image) {
        return { content: r.image.parts, isError: false, summary: r.image.summary, sentImage: r.image.sentImage };
      }
      const text = this.mask(r.text);
      const content: ContentPart[] = [{ type: 'text', text }];
      let screenChanged: boolean | null = null;
      let sentImage = false;
      if (opts.verify) {
        await sleep(this.speed.settleMs, opts.signal);
        const before = this.lastFingerprint;
        const obs = await this.observe({ image: this.settings.agent.screenshotAfterAction });
        if (obs.sentImage) {
          const change = compareFingerprints(before, this.lastFingerprint);
          screenChanged = change.changed;
          content.push({ type: 'text', text: `Result check: ${change.changed ? 'screen changed' : 'NO visible change on screen'}.` });
          r.summary += ` — ${describeChange(change)}`;
        }
        content.push(...obs.parts);
        sentImage = obs.sentImage;
      }
      return { content, isError: false, summary: r.summary, screenChanged, sentImage };
    } catch (err) {
      if (opts.signal.aborted) throw err;
      const msg = (err as Error).message || String(err);
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true, summary: `失敗: ${msg}` };
    }
  }

  private mask(text: string): string {
    if (!this.settings.screenshot.redactSecrets) return text;
    return redactSecrets(text).text;
  }

  private ensureNotGumi(hwnd: number) {
    const pid = this.win.pidOf(hwnd);
    if (this.deps.excludePids.includes(pid)) throw new ToolError('Gumi 自身のウィンドウは操作できません');
  }

  private button(v: unknown): MouseButton {
    return v === 'right' || v === 'middle' ? v : 'left';
  }

  private async dispatch(
    name: string,
    a: Record<string, any>,
    signal: AbortSignal,
  ): Promise<{ text: string; summary: string; image?: ObserveResult }> {
    const input = this.input;
    if (WINDOW_TOOLS.has(name)) await this.win.sync?.().catch(() => undefined);
    switch (name) {
      // ---------- 観察 ----------
      case 'screenshot': {
        if (a.display !== undefined) {
          const d = this.deps.displays()[a.display];
          if (!d) throw new ToolError(`Display index ${a.display} does not exist.`);
          this.targetDisplayId = d.id;
        }
        const obs = await this.observe({ image: true });
        return { text: '', summary: obs.summary, image: obs };
      }
      case 'list_displays': {
        const lines = this.deps.displays().map(
          (d) =>
            `index=${d.index}${d.primary ? ' (primary)' : ''}${d.id === this.targetDisplayId ? ' [current target]' : ''}: ${d.physical.width}x${d.physical.height}px, scale ${Math.round(d.scaleFactor * 100)}%, origin (${d.physical.x}, ${d.physical.y})`,
        );
        return { text: lines.join('\n'), summary: `${lines.length} 台のディスプレイ` };
      }
      case 'get_cursor_position': {
        const c = this.toImage(input.getCursor());
        return { text: `Cursor at (${c.x}, ${c.y})`, summary: `カーソル (${c.x}, ${c.y})` };
      }
      case 'list_windows': {
        const ws = this.win.list(this.deps.excludePids).slice(0, 40);
        const lines = ws.map((w) => this.formatWindow(w));
        return { text: lines.join('\n') || '(no windows)', summary: `${ws.length} 個のウィンドウ` };
      }
      case 'get_active_window': {
        const w = this.win.foreground();
        if (!w || this.deps.excludePids.includes(w.pid)) return { text: 'No active application window.', summary: 'アクティブウィンドウなし' };
        return { text: this.formatWindow(w), summary: `アクティブ: ${truncate(w.title, 40)}` };
      }
      case 'get_ui_elements': {
        let hwnd: number | undefined = a.hwnd;
        if (hwnd) this.ensureNotGumi(hwnd);
        else {
          const fg = this.win.foreground();
          if (!fg || this.deps.excludePids.includes(fg.pid)) throw new ToolError('No active application window. Focus a window first.');
          hwnd = fg.hwnd;
        }
        const tree = await this.ui.listElements({
          hwnd,
          interactiveOnly: a.interactive_only ?? true,
          maxCount: a.max_elements ?? 150,
          budgetMs: 5000,
        });
        const lines = tree.elements.map((e) => this.formatElement(e));
        const header = `Window "${tree.window}" — ${tree.elements.length} elements${tree.truncated ? ' (truncated)' : ''}. Coordinates are element centers in image space.`;
        return { text: [header, ...lines].join('\n'), summary: `UI 要素 ${tree.elements.length} 件` };
      }
      case 'get_element_at': {
        const p = this.toScreen(a.x, a.y);
        const e = await this.ui.elementAt(p.x, p.y);
        if (!e) return { text: 'No element at that point.', summary: '要素なし' };
        return { text: this.formatElement(e), summary: `${e.type} "${truncate(e.name, 30)}"` };
      }
      case 'list_processes': {
        const procs = this.deps.automation.processes.list();
        const windows = this.win.list(this.deps.excludePids);
        const filter = (a.name_filter as string | undefined)?.toLowerCase();
        const groups = new Map<string, { pids: number[]; titles: string[]; hung: boolean }>();
        for (const p of procs) {
          if (filter && !p.name.toLowerCase().includes(filter)) continue;
          const g = groups.get(p.name) ?? { pids: [], titles: [], hung: false };
          g.pids.push(p.pid);
          groups.set(p.name, g);
        }
        for (const w of windows) {
          const g = [...groups.entries()].find(([, v]) => v.pids.includes(w.pid));
          if (g) {
            g[1].titles.push(w.title);
            if (!w.responding) g[1].hung = true;
          }
        }
        const lines = [...groups.entries()]
          .sort((x, y) => y[1].titles.length - x[1].titles.length)
          .slice(0, 80)
          .map(
            ([n, g]) =>
              `${n} ×${g.pids.length} (pid ${g.pids.slice(0, 3).join(',')})${g.titles.length ? ` windows: ${g.titles.slice(0, 3).map((t) => `"${truncate(t, 50)}"`).join(', ')}` : ''}${g.hung ? ' [NOT RESPONDING]' : ''}`,
          );
        return { text: lines.join('\n') || 'No matching process.', summary: `${groups.size} 種類のプロセス` };
      }
      case 'wait': {
        await sleep(Math.round(a.seconds * 1000), signal);
        return { text: `Waited ${a.seconds}s.`, summary: `${a.seconds} 秒待機` };
      }

      // ---------- マウス ----------
      case 'mouse_move': {
        const p = this.toScreen(a.x, a.y);
        await input.moveTo(p.x, p.y, { signal });
        return { text: `Moved cursor to (${a.x}, ${a.y}).`, summary: 'カーソル移動' };
      }
      case 'mouse_click':
      case 'double_click':
      case 'right_click': {
        const p = this.toScreen(a.x, a.y);
        const btn = name === 'right_click' ? 'right' : this.button(a.button);
        const clicks = name === 'double_click' ? 2 : (a.clicks ?? 1);
        const modifiers = ((a.modifiers as string[] | undefined) ?? []).map((k) => resolveKey(k));
        await input.click({ x: p.x, y: p.y, button: btn, clicks, modifiers, signal });
        return { text: `Clicked ${btn} x${clicks} at (${a.x}, ${a.y}).`, summary: 'クリックしました' };
      }
      case 'mouse_down':
      case 'mouse_up': {
        if (a.x !== undefined && a.y !== undefined) {
          const p = this.toScreen(a.x, a.y);
          await input.moveTo(p.x, p.y, { signal });
        }
        if (name === 'mouse_down') await input.mouseDown(this.button(a.button));
        else await input.mouseUp(this.button(a.button));
        return { text: `${name} ${a.button} done.`, summary: name === 'mouse_down' ? 'ボタン押下' : 'ボタン解放' };
      }
      case 'mouse_hold': {
        const p = this.toScreen(a.x, a.y);
        await input.hold({ x: p.x, y: p.y, button: this.button(a.button), durationMs: a.duration_ms, signal });
        return { text: `Held ${a.button} for ${a.duration_ms}ms.`, summary: '長押ししました' };
      }
      case 'drag': {
        const from = this.toScreen(a.start_x, a.start_y);
        const to = this.toScreen(a.end_x, a.end_y);
        await input.drag({ from, to, button: this.button(a.button), durationMs: a.duration_ms, signal });
        return { text: 'Drag completed.', summary: 'ドラッグしました' };
      }
      case 'scroll': {
        let pos: Point | undefined;
        if (a.x !== undefined && a.y !== undefined) pos = this.toScreen(a.x, a.y);
        await input.scroll({ x: pos?.x, y: pos?.y, direction: a.direction, amount: a.amount ?? 3, signal });
        return { text: `Scrolled ${a.direction} ${a.amount ?? 3} notches.`, summary: 'スクロールしました' };
      }
      case 'click_element':
      case 'move_to_element': {
        const id = a.element_id as number;
        const action = name === 'move_to_element' ? 'hover' : (a.action as string);
        if (action === 'invoke') {
          const method = await this.ui.invoke(id);
          if (method) return { text: `Element #${id} invoked via ${method} pattern.`, summary: `要素を実行 (${method})` };
        }
        if (action === 'focus') {
          await this.ui.focus(id);
          return { text: `Element #${id} focused.`, summary: '要素にフォーカス' };
        }
        const rect = await this.ui.rect(id).catch(() => this.elementRects.get(id));
        if (!rect) throw new ToolError(`Element #${id} not found. Call get_ui_elements again.`);
        const c = rectCenter(rect);
        if (action === 'hover') {
          await input.moveTo(c.x, c.y, { signal });
          return { text: `Moved to element #${id}.`, summary: '要素へ移動' };
        }
        await input.click({
          x: c.x,
          y: c.y,
          button: action === 'right_click' ? 'right' : 'left',
          clicks: action === 'double_click' ? 2 : 1,
          signal,
        });
        return { text: `Clicked element #${id} at its center.`, summary: '要素をクリック' };
      }
      case 'set_element_value': {
        await this.ui.setValue(a.element_id, a.value);
        return { text: `Value of element #${a.element_id} set.`, summary: '値を設定しました' };
      }

      // ---------- キーボード ----------
      case 'type_text': {
        const text = String(a.text);
        let method = (a.method as string | undefined) ?? this.settings.agent.textInputMethod;
        // macOS は日本語入力 (IME) が有効だと 1 文字ずつの入力が変換されることがあるので、貼り付けを使う
        if (method === 'auto') method = this.isMac || text.length > 200 ? 'clipboard' : 'unicode';
        if (method === 'clipboard') await this.pasteText(text, signal);
        else await input.typeUnicode(text, signal);
        if (a.press_enter) await input.pressCombo([resolveKey('enter')], { signal });
        return {
          text: `Typed ${text.length} characters via ${method}${a.press_enter ? ' and pressed Enter' : ''}.`,
          summary: `${text.length} 文字を入力`,
        };
      }
      case 'press_keys': {
        const combo = parseCombo(a.keys);
        const sys = this.settings.system;
        const extra = [sys.emergencyStopShortcut, sys.pauseShortcut].map((k) => acceleratorToCombo(k));
        if (isForbiddenCombo(combo, extra)) throw new ToolError(`The key combination "${a.keys}" is not allowed.`);
        await input.pressCombo(combo, { repeat: a.repeat, signal });
        return { text: `Pressed ${a.keys}${a.repeat > 1 ? ` x${a.repeat}` : ''}.`, summary: `キー ${a.keys}` };
      }
      case 'key_down':
      case 'key_up':
      case 'hold_key': {
        const spec = resolveKey(a.key);
        if (name === 'key_down') await input.keyDown(spec);
        else if (name === 'key_up') await input.keyUp(spec);
        else await input.holdKey(spec, a.duration_ms, signal);
        return { text: `${name} ${spec.name} done.`, summary: `${name} ${spec.name}` };
      }

      // ---------- アプリ / ウィンドウ ----------
      case 'launch_app': {
        const r = await this.deps.automation.apps.launch(a.name, a.args ?? [], {
          shell: this.deps.shell,
          startApps: () => this.startApps(),
        });
        await sleep(this.speed.settleMs * 2, signal);
        return { text: `Launched "${r.label}" (${r.method}: ${r.target}).`, summary: `「${r.label}」を起動` };
      }
      case 'open_url': {
        let url: URL;
        try {
          url = new URL(String(a.url));
        } catch {
          throw new ToolError('Invalid URL.');
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ToolError('Only http(s) URLs can be opened.');
        await this.deps.shell.openExternal(url.toString());
        await sleep(this.speed.settleMs * 2, signal);
        return { text: `Opened ${url.toString()} in the default browser.`, summary: 'URL を開きました' };
      }
      case 'focus_window': {
        let hwnd: number | undefined = a.hwnd;
        if (!hwnd && a.title) hwnd = this.win.findByTitle(a.title, this.deps.excludePids)?.hwnd;
        if (!hwnd) throw new ToolError(`Window not found: ${a.title ?? ''}`);
        this.ensureNotGumi(hwnd);
        const ok = await this.win.focus(hwnd, input);
        const title = this.win.titleOf(hwnd);
        const os = this.isMac ? 'macOS' : 'Windows';
        return {
          text: ok ? `Focused "${title}".` : `Tried to focus "${title}" but ${os} did not allow it; click on the window instead.`,
          summary: ok ? `「${truncate(title, 30)}」をアクティブ化` : 'アクティブ化できませんでした',
        };
      }
      case 'window_action': {
        this.ensureNotGumi(a.hwnd);
        const title = this.win.titleOf(a.hwnd);
        await this.win.action(a.hwnd, a.action);
        return { text: `${a.action} sent to "${title}".`, summary: `「${truncate(title, 30)}」: ${a.action}` };
      }
      case 'move_window': {
        this.ensureNotGumi(a.hwnd);
        const p = this.toScreen(a.x, a.y);
        const f = this.currentFrame();
        const sx = f.region.width / f.imageWidth;
        const sy = f.region.height / f.imageHeight;
        await this.win.setBounds(a.hwnd, {
          x: p.x,
          y: p.y,
          width: a.width !== undefined ? Math.round(a.width * sx) : undefined,
          height: a.height !== undefined ? Math.round(a.height * sy) : undefined,
        });
        return { text: 'Window moved.', summary: 'ウィンドウを移動しました' };
      }

      // ---------- Web 検索 ----------
      case 'web_search': {
        const out = await runWebSearch(String(a.query), { pages: a.fetch_pages ?? MAX_FETCHED_SITES, signal });
        const fetched = out.pages.filter((p) => !('error' in p)).length;
        return {
          text: formatWebSearch(out),
          summary: `検索結果 ${out.results.length} 件、本文取得 ${fetched}/${out.pages.length} サイト`,
        };
      }

      // ---------- クリップボード ----------
      case 'clipboard_read': {
        const t = await this.deps.clipboard.readText();
        return {
          text: t ? `Clipboard text:\n${t.slice(0, 20000)}` : 'Clipboard is empty (or contains no text).',
          summary: `クリップボード (${t.length} 文字)`,
        };
      }
      case 'clipboard_write': {
        await this.deps.clipboard.writeText(String(a.text));
        return { text: 'Clipboard updated.', summary: 'クリップボードへコピー' };
      }

      // ---------- ファイル ----------
      case 'list_directory': {
        const dir = this.safePath(a.path);
        const r = await files.listDirectory(dir);
        const lines = r.entries.map(
          (e) => `${e.type === 'directory' ? '[DIR] ' : ''}${e.name}${e.type === 'file' ? ` (${formatSize(e.size)})` : ''}`,
        );
        return {
          text: `${r.path} — ${r.total} items${r.total > r.entries.length ? ` (showing ${r.entries.length})` : ''}\n${lines.join('\n')}`,
          summary: `${r.total} 項目`,
        };
      }
      case 'read_text_file': {
        const p = this.safePath(a.path);
        const r = await files.readTextFile(p, a.max_bytes);
        return {
          text: `${p} (${formatSize(r.size)})${r.truncated ? ' [truncated]' : ''}:\n${r.text}`,
          summary: `ファイルを読み取り (${formatSize(r.size)})`,
        };
      }
      case 'create_folder': {
        const p = this.safePath(a.path);
        const r = await files.createFolder(p);
        return { text: r.created ? `Created folder ${p}` : `Folder already exists: ${p}`, summary: r.created ? 'フォルダを作成' : 'フォルダは既に存在' };
      }
      case 'move_path': {
        const dest = await files.movePath(this.safePath(a.source), this.safePath(a.destination));
        return { text: `Moved to ${dest}`, summary: '移動しました' };
      }
      case 'copy_path': {
        const dest = await files.copyPath(this.safePath(a.source), this.safePath(a.destination));
        return { text: `Copied to ${dest}`, summary: 'コピーしました' };
      }
      case 'rename_path': {
        const dest = await files.renamePath(this.safePath(a.path), a.new_name);
        return { text: `Renamed to ${dest}`, summary: '名前を変更しました' };
      }
      case 'write_text_file': {
        const p = this.safePath(a.path);
        const r = await files.writeTextFile(p, a.content, a.overwrite);
        return { text: `${r.overwritten ? 'Overwrote' : 'Created'} ${p}`, summary: r.overwritten ? '上書き保存' : 'ファイルを作成' };
      }
      case 'delete_path': {
        const p = this.safePath(a.path);
        if (!(await files.pathExists(p))) throw new ToolError(`Not found: ${p}`);
        await this.deps.shell.trashItem(p);
        return { text: `Moved ${p} to the ${this.isMac ? 'Trash' : 'Recycle Bin'}.`, summary: 'ごみ箱へ移動しました' };
      }
      default:
        throw new ToolError(`Tool "${name}" is not executable here.`);
    }
  }

  private safePath(input: string): string {
    return files.resolveSafe(input, { folders: this.deps.knownFolders, protectedRoots: this.deps.protectedRoots });
  }

  private async pasteText(text: string, signal: AbortSignal) {
    const cb = this.deps.clipboard;
    const saved = await cb.readText().catch(() => '');
    await cb.writeText(text);
    try {
      await sleep(50, signal);
      await this.input.pressCombo(parseCombo(pasteCombo()), { signal });
      await sleep(400, signal);
    } finally {
      // 元のクリップボード内容を復元する
      await cb.writeText(saved).catch(() => undefined);
    }
  }

  private async startApps(): Promise<StartApp[]> {
    if (this.startAppsCache && Date.now() - this.startAppsCache.at < 5 * 60_000) return this.startAppsCache.apps;
    const apps = await this.ui.startApps();
    this.startAppsCache = { at: Date.now(), apps };
    return apps;
  }

  private formatWindow(w: WindowInfo): string {
    const r = screenRectToImage(this.currentFrame(), w.rect);
    const flags = [w.foreground && 'FOREGROUND', w.minimized && 'minimized', w.maximized && 'maximized', !w.responding && 'NOT RESPONDING']
      .filter(Boolean)
      .join(', ');
    return `hwnd=${w.hwnd} "${truncate(w.title, 80)}" [${w.processName}] at (${r.x}, ${r.y}) ${r.width}x${r.height}${flags ? ` {${flags}}` : ''}`;
  }

  private formatElement(e: UiElement): string {
    this.elementRects.set(e.id, e.rect);
    const c = this.toImage(rectCenter(e.rect));
    const parts = [`[${e.id}] ${e.type}`];
    if (e.name) parts.push(`"${truncate(e.name, 80)}"`);
    parts.push(`@(${c.x}, ${c.y})`);
    if (e.automationId) parts.push(`aid=${truncate(e.automationId, 30)}`);
    if (e.value !== undefined && e.value !== '') parts.push(`value="${truncate(this.mask(e.value), 60)}"`);
    if (e.toggleState) parts.push(`toggle=${e.toggleState}`);
    if (!e.enabled) parts.push('(disabled)');
    if (e.focused) parts.push('(focused)');
    if (e.patterns.length) parts.push(`{${e.patterns.join(',')}}`);
    return parts.join(' ');
  }
}

/** 前面のウィンドウの情報を使うツール */
const WINDOW_TOOLS = new Set(['list_windows', 'get_active_window', 'get_ui_elements', 'list_processes', 'focus_window']);

function contains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}
