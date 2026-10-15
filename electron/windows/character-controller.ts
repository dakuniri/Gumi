/**
 * Gumi (小さな円のウィンドウ) の制御。
 *
 * - 透明・枠なしのウィンドウに白 / 黒の円を描く。円・小さな円・入力欄・ボタンの外側はクリック透過
 *   (カーソル位置から Main が判定)
 * - カーソルを円に合わせると、上に 2 つの小さな円 (設定 / 色変更) を出す
 * - 円をクリックすると横に入力欄を開閉する。作業中は円の上に一時停止・停止ボタンを出す
 * - 承認待ち・質問待ちになったら、入力欄の位置に「許可 / 拒否」や回答欄を出す (別のパネルは出さない)
 * - ドラッグ移動、画面端への吸着、位置の保存と復元、ディスプレイ構成変更時の画面内補正
 */
import { app, BrowserWindow, screen, type Display } from 'electron';
import { EventEmitter } from 'node:events';
import type { SettingsStore } from '../../src/services/settings/store';
import type { Corner, Settings } from '../../src/services/settings/schema';
import type { AgentStatus } from '../../src/types/agent';
import { isBusyPhase } from '../../src/types/agent';
import type { CharacterState, Point, Rect } from '../../src/types/character';
import type { InteractionKind } from '../../src/types/ipc';
import {
  clampFaceCenter,
  cornerCenter,
  faceRectFromCenter,
  quadrantOf,
  snapFaceCenter,
} from '../../src/services/layout/placement';
import { bubbleDirection, inBubbleCorridor, type BubbleDirection } from '../../src/services/layout/bubbles';
import {
  chooseControlsDirection,
  chooseSide,
  hitControl,
  orbWindowSize,
  type ControlsDirection,
  type Prompt,
  type Side,
  type UiMode,
} from '../../src/services/layout/controls';
import { createAppWindow } from './factory';

const TICK_MS = 50;
const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 400;
const DRAG_THRESHOLD = 4;
const WAKING_MS = 900;
const IDLE_AFTER_MS = 25_000;

export interface CharacterControllerDeps {
  store: SettingsStore;
  agentStatus: () => AgentStatus;
  /** 左ボタンが物理的に押されているか (不明なら null) */
  isLeftButtonDown: () => boolean | null;
  /**
   * macOS: 入力欄を開く前に前面だったアプリを覚えておき、閉じたらそのアプリへフォーカスを戻す
   * (macOS では Gumi が前面のアプリになるため。Windows はフォーカスを外すだけで戻る)
   */
  focusReturn?: { remember(): void; restore(): void };
}

export class CharacterController extends EventEmitter {
  face!: BrowserWindow;

  private center: Point = { x: 0, y: 0 };
  private timer: NodeJS.Timeout | null = null;

  // ホバー / 小さな円
  private hover = false;
  private hoverSince = 0;
  private lastInside = 0;
  private bubblesOpen = false;
  private bubbleDir: BubbleDirection = 'up';
  private suppressBubbles = false;

  // 円の横の入力欄 / 作業中のボタン / 承認・質問
  private inputOpen = false;
  private side: Side = 'left';
  private controlsDir: ControlsDirection = 'up';
  private lastMode: UiMode = 'idle';
  private lastPrompt: Prompt = null;
  private lastPhase: AgentStatus['phase'] = 'idle';
  /** 作業後の結果の吹き出し */
  private result: { kind: 'success' | 'error'; text: string } | null = null;
  private resultHeight = 0;

  // ドラッグ
  private pointerDown: { cursor: Point; center: Point } | null = null;
  private pointerDownAt = 0;
  private dragging = false;

  // スリープ
  private lastInteraction = Date.now();
  private sleeping = false;
  private wakingUntil = 0;

  // 入力注入中 (クリック透過)
  private faceIgnoreMouse = true;
  private injecting = false;

  private lastState = '';
  private focusable = false;

  constructor(private readonly deps: CharacterControllerDeps) {
    super();
  }

  private get settings(): Settings {
    return this.deps.store.get();
  }

  private get size(): number {
    return this.settings.character.size;
  }

  // ------------------------------------------------------------------
  // 生成
  // ------------------------------------------------------------------

  create(): void {
    this.center = this.initialCenter();
    const s = this.settings;
    const g = orbWindowSize(this.size);

    this.face = createAppWindow('face', {
      width: g.width,
      height: g.height,
      x: Math.round(this.center.x - g.width / 2),
      y: Math.round(this.center.y - g.height / 2),
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      thickFrame: false,
      // macOS: Gumi が前面でなくても最初のクリックをそのまま受け取る
      acceptFirstMouse: true,
      show: false,
      alwaysOnTop: s.character.alwaysOnTop,
      backgroundColor: '#00000000',
      title: 'Gumi',
    });
    this.face.setIgnoreMouseEvents(true, { forward: true });
    // macOS: すべてのデスクトップ (操作スペース) とフルスクリーンのアプリの上にも表示する
    if (process.platform === 'darwin') this.face.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    this.applyWindowSettings();
    this.face.once('ready-to-show', () => {
      // 起動直後 (特にアップデート直後) は画面の構成が落ち着いていないことがあるので、表示前と少し後に位置を確かめ直す
      this.ensureOnScreen();
      if (this.settings.character.visible) this.face.showInactive();
      setTimeout(() => this.ensureOnScreen(), 3000);
    });

    screen.on('display-metrics-changed', () => this.ensureOnScreen());
    screen.on('display-added', () => this.ensureOnScreen());
    screen.on('display-removed', () => this.ensureOnScreen());

    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.broadcast(true);
  }

  private initialCenter(): Point {
    const c = this.settings.character;
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    if (c.startPosition === 'last' && c.position) {
      const d =
        displays.find((x) => x.id === c.position?.displayId) ??
        screen.getDisplayNearestPoint({ x: Math.round(c.position.x), y: Math.round(c.position.y) });
      return clampFaceCenter({ x: c.position.x, y: c.position.y }, this.size, d.workArea);
    }
    const corner: Corner = c.startPosition === 'last' ? 'bottom-right' : c.startPosition;
    return cornerCenter(corner, this.size, primary.workArea);
  }

  applyWindowSettings(prev?: Settings): void {
    const s = this.settings;
    this.face.setAlwaysOnTop(s.character.alwaysOnTop, 'screen-saver');
    if (!prev || prev.character.size !== s.character.size) {
      this.center = clampFaceCenter(this.center, this.size, this.displayAt(this.center).workArea);
      this.layoutFace();
    }
    if (!prev || prev.character.visible !== s.character.visible) {
      if (s.character.visible) {
        if (!this.face.webContents.isLoading()) this.face.showInactive();
      } else {
        this.closeInput();
        this.closeBubbles();
        this.face.hide();
      }
    }
    if (prev && prev.character.startPosition !== s.character.startPosition && s.character.startPosition !== 'last') {
      this.moveToCorner(s.character.startPosition);
    }
  }

  private layoutFace(): void {
    const g = orbWindowSize(this.size);
    this.face.setBounds({
      x: Math.round(this.center.x - g.width / 2),
      y: Math.round(this.center.y - g.height / 2),
      width: g.width,
      height: g.height,
    });
  }

  private displayAt(p: Point): Display {
    return screen.getDisplayNearestPoint({ x: Math.round(p.x), y: Math.round(p.y) });
  }

  private faceRect(): Rect {
    return faceRectFromCenter(this.center, this.size);
  }

  // ------------------------------------------------------------------
  // ポーリング
  // ------------------------------------------------------------------

  private tick(): void {
    if (this.face.isDestroyed()) return;
    const now = Date.now();
    const cursor = screen.getCursorScreenPoint();
    const visible = this.settings.character.visible;

    // ---- ドラッグ ----
    if (this.pointerDown) {
      const moved = Math.hypot(cursor.x - this.pointerDown.cursor.x, cursor.y - this.pointerDown.cursor.y);
      if (!this.dragging && moved > DRAG_THRESHOLD) {
        this.dragging = true;
        this.closeBubbles();
        this.interaction('click');
      }
      if (this.dragging) {
        this.center = {
          x: this.pointerDown.center.x + (cursor.x - this.pointerDown.cursor.x),
          y: this.pointerDown.center.y + (cursor.y - this.pointerDown.cursor.y),
        };
        this.layoutFace();
      }
      // pointerup を取りこぼした場合の保険
      if (this.deps.isLeftButtonDown() === false && now - this.pointerDownAt > 150) this.pointerUp();
    }

    // ---- 作業の終了: 結果 (AI のまとめ / 失敗の理由) を円の横に出す ----
    const st = this.deps.agentStatus();
    if (st.phase !== this.lastPhase) {
      if ((st.phase === 'completed' || st.phase === 'failed') && st.summary) {
        const wa = this.displayAt(this.center).workArea;
        this.side = chooseSide(this.center, this.size, wa);
        this.controlsDir = chooseControlsDirection(this.center, this.size, wa.y);
        this.result = { kind: st.phase === 'completed' ? 'success' : 'error', text: st.summary };
        this.resultHeight = 0;
      } else if (isBusyPhase(st.phase)) {
        this.result = null;
      }
      this.lastPhase = st.phase;
      this.broadcast(true);
    }

    // ---- 表示モード (入力中 / 作業中 / 通常) と承認・質問 ----
    const mode = this.mode();
    const prompt = this.prompt();
    if (mode !== this.lastMode || prompt !== this.lastPrompt) {
      const wa = this.displayAt(this.center).workArea;
      if (mode === 'task' && this.lastMode !== 'task') {
        // 作業中ボタンを出す方向を決め、ホバーの小さな円は閉じる
        this.controlsDir = chooseControlsDirection(this.center, this.size, wa.y);
        this.closeBubbles();
      }
      if (prompt && !this.lastPrompt) {
        // 承認・質問を入力欄の位置に出す。質問は文字を入力できるようアクティブにする
        this.side = chooseSide(this.center, this.size, wa);
        this.wake();
        if (prompt === 'question') this.activate();
      }
      if (!prompt && this.lastPrompt && !this.inputOpen) this.setFocusable(false);
      this.lastMode = mode;
      this.lastPrompt = prompt;
      this.broadcast(true);
    }

    // ---- ホバー ----
    const rel = { x: cursor.x - this.center.x, y: cursor.y - this.center.y };
    const target = visible ? hitControl(rel, this.size, this.hitState(), 3) : null;
    const onCircle = target === 'orb';
    const onBubble = target === 'settings' || target === 'color';
    const inCorridor = this.bubblesOpen && inBubbleCorridor(rel, this.size, this.bubbleDir);

    if (onCircle !== this.hover) {
      this.hover = onCircle;
      this.hoverSince = now;
      if (onCircle) this.interaction('hover');
    }
    if (!onCircle && !onBubble && !inCorridor) this.suppressBubbles = false;

    // カーソルを合わせたら小さな円を出す (入力中・作業中・ドラッグ中は出さない)
    if (
      mode === 'idle' &&
      this.hover &&
      !this.bubblesOpen &&
      !this.dragging &&
      !this.pointerDown &&
      !this.suppressBubbles &&
      now - this.hoverSince >= OPEN_DELAY_MS
    ) {
      this.openBubbles();
    }
    // 円・小さな円・入力欄・ボタンの上だけマウスを受け付け、それ以外は背後のアプリへ透過する
    this.setFaceIgnoreMouse(!(target !== null || this.pointerDown !== null));

    if (onCircle || onBubble || inCorridor) this.lastInside = now;
    if (this.bubblesOpen && now - this.lastInside > CLOSE_DELAY_MS) this.closeBubbles();

    // ---- スリープ (円が薄くなるだけ。PC はスリープさせない) ----
    const busy = isBusyPhase(this.deps.agentStatus().phase);
    if (busy) this.lastInteraction = Math.max(this.lastInteraction, now - 1000);
    const c = this.settings.character;
    if (
      !this.sleeping &&
      c.sleepEnabled &&
      !busy &&
      !this.inputOpen &&
      !this.bubblesOpen &&
      !this.hover &&
      !this.dragging &&
      now - this.lastInteraction > c.sleepAfterSec * 1000
    ) {
      this.sleeping = true;
    }
    if (this.sleeping && (!c.sleepEnabled || busy)) this.wake();

    this.broadcast();
  }

  // ------------------------------------------------------------------
  // 入力欄 / 作業中ボタン / 承認・質問
  // ------------------------------------------------------------------

  private mode(): UiMode {
    if (isBusyPhase(this.deps.agentStatus().phase)) return 'task';
    return this.inputOpen ? 'input' : 'idle';
  }

  private prompt(): Prompt {
    const st = this.deps.agentStatus();
    if (st.pendingApproval) return 'approval';
    if (st.pendingQuestion) return 'question';
    return null;
  }

  private hitState() {
    return {
      mode: this.mode(),
      prompt: this.prompt(),
      resultHeight: this.result && this.mode() === 'idle' ? this.resultHeight : null,
      side: this.side,
      controlsDir: this.controlsDir,
      bubblesOpen: this.bubblesOpen,
      bubbleDir: this.bubbleDir,
    };
  }

  /** 文字を入力できるよう、このときだけウィンドウをアクティブにできるようにする */
  private activate(): void {
    if (process.platform === 'darwin' && !this.focusable) {
      this.deps.focusReturn?.remember();
      // Dock に出ないアプリは、明示的に前面のアプリにしないとキー入力を受け取れない
      app.focus({ steal: true });
    }
    this.setFocusable(true);
    this.face.focus();
  }

  /**
   * Electron (Windows) の setFocusable はタスクバー表示 (skipTaskbar) も切り替えてしまい、
   * タスクバーにボタンが出たりウィンドウが描き直されてちらつくので、毎回タスクバー非表示に戻す。
   */
  private setFocusable(focusable: boolean): void {
    if (this.face.isDestroyed()) return;
    const wasFocusable = this.focusable;
    this.focusable = focusable;
    this.face.setFocusable(focusable);
    this.face.setSkipTaskbar(true);
    if (process.platform === 'darwin' && wasFocusable && !focusable) this.deps.focusReturn?.restore();
  }

  /** 結果の吹き出しを閉じる */
  dismissResult(): void {
    if (!this.result) return;
    this.result = null;
    this.resultHeight = 0;
    this.broadcast(true);
  }

  /** Renderer が測った結果の吹き出しの高さ (クリックを受け付ける範囲に使う) */
  setResultHeight(height: number): void {
    this.resultHeight = Math.round(height);
  }

  /** 円の横に入力欄を出す (左に余白が無ければ右) */
  openInput(): void {
    if (!this.settings.character.visible || this.mode() === 'task') return;
    this.result = null;
    this.resultHeight = 0;
    const wa = this.displayAt(this.center).workArea;
    this.side = chooseSide(this.center, this.size, wa);
    this.controlsDir = chooseControlsDirection(this.center, this.size, wa.y);
    this.inputOpen = true;
    this.wake();
    this.interaction('typing');
    this.closeBubbles();
    this.activate();
    this.broadcast(true);
  }

  /** 入力欄を閉じる (送信後は円に収納するアニメーションになる) */
  closeInput(): void {
    if (!this.inputOpen) return;
    this.inputOpen = false;
    if (!this.prompt()) this.setFocusable(false);
    this.broadcast(true);
  }

  toggleInput(): void {
    if (this.inputOpen) this.closeInput();
    else this.openInput();
  }

  // ------------------------------------------------------------------
  // 小さな円 (設定 / 色変更)
  // ------------------------------------------------------------------

  private openBubbles(): void {
    this.bubbleDir = bubbleDirection(this.center, this.size, this.displayAt(this.center).workArea.y);
    this.bubblesOpen = true;
    this.lastInside = Date.now();
    this.broadcast(true);
  }

  closeBubbles(): void {
    if (!this.bubblesOpen) return;
    this.bubblesOpen = false;
    this.suppressBubbles = true;
    this.broadcast(true);
  }

  // ------------------------------------------------------------------
  // 入力イベント (Renderer から)
  // ------------------------------------------------------------------

  private setFaceIgnoreMouse(ignore: boolean): void {
    if (ignore === this.faceIgnoreMouse) return;
    this.faceIgnoreMouse = ignore;
    if (!this.injecting && !this.face.isDestroyed()) this.face.setIgnoreMouseEvents(ignore, { forward: true });
  }

  pointerDownEvent(): void {
    this.pointerDown = { cursor: screen.getCursorScreenPoint(), center: { ...this.center } };
    this.pointerDownAt = Date.now();
    this.interaction('click');
  }

  pointerUp(): void {
    if (!this.pointerDown) return;
    const wasDragging = this.dragging;
    this.pointerDown = null;
    this.dragging = false;
    if (wasDragging) this.finishDrag();
    else {
      this.closeBubbles();
      this.emit('click');
    }
    this.broadcast();
  }

  private finishDrag(): void {
    const display = this.displayAt(this.center);
    let c = clampFaceCenter(this.center, this.size, display.workArea);
    if (this.settings.character.snapToEdges) c = snapFaceCenter(c, this.size, display.workArea);
    this.center = c;
    this.layoutFace();
    this.savePosition(display);
  }

  private savePosition(display = this.displayAt(this.center)): void {
    this.deps.store.update({
      character: { position: { x: this.center.x, y: this.center.y, displayId: display.id } },
    });
  }

  interaction(_kind: InteractionKind): void {
    this.lastInteraction = Date.now();
    if (this.sleeping) this.wake();
  }

  private wake(): void {
    if (!this.sleeping) return;
    this.sleeping = false;
    this.wakingUntil = Date.now() + WAKING_MS;
    this.broadcast();
  }

  // ------------------------------------------------------------------
  // 位置
  // ------------------------------------------------------------------

  moveToCorner(corner: Corner): void {
    const display = this.displayAt(this.center);
    this.center = cornerCenter(corner, this.size, display.workArea);
    this.layoutFace();
    this.savePosition(display);
    this.broadcast(true);
  }

  /** ディスプレイ構成や解像度が変わったときに画面内へ戻す */
  ensureOnScreen(): void {
    if (this.face.isDestroyed()) return;
    const display = this.displayAt(this.center);
    const c = clampFaceCenter(this.center, this.size, display.workArea);
    if (c.x !== this.center.x || c.y !== this.center.y) {
      this.center = c;
      this.savePosition(display);
    }
    this.layoutFace();
    this.broadcast(true);
  }

  setVisible(visible: boolean): void {
    this.deps.store.update({ character: { visible } });
  }

  // ------------------------------------------------------------------
  // PC 操作との干渉防止
  // ------------------------------------------------------------------

  /** 入力注入中は Gumi のウィンドウをクリック透過にする */
  setInjecting(injecting: boolean): void {
    if (this.injecting === injecting || this.face.isDestroyed()) return;
    this.injecting = injecting;
    if (injecting) this.face.setIgnoreMouseEvents(true);
    else this.face.setIgnoreMouseEvents(this.faceIgnoreMouse, { forward: true });
  }

  /**
   * AI が画面を撮影する間だけ、Gumi をキャプチャ対象から外す。
   * 透明にするのではなく Windows のキャプチャ除外 (SetWindowDisplayAffinity) を使うので、
   * 画面上の Gumi は消えずに表示されたまま (ちらつかない)。
   */
  excludeFromCapture(): void {
    if (!this.face.isDestroyed()) this.face.setContentProtection(true);
  }

  includeInCapture(): void {
    if (!this.face.isDestroyed()) this.face.setContentProtection(false);
  }

  /** カーソルが Gumi の上にあるか (ユーザー操作検知の除外用) */
  cursorOverGumi(): boolean {
    const cursor = screen.getCursorScreenPoint();
    const rel = { x: cursor.x - this.center.x, y: cursor.y - this.center.y };
    return hitControl(rel, this.size, this.hitState(), 4) !== null;
  }

  isFocused(): boolean {
    return !this.face.isDestroyed() && this.face.isFocused();
  }

  // ------------------------------------------------------------------
  // 状態通知
  // ------------------------------------------------------------------

  getState(): CharacterState {
    const now = Date.now();
    const display = this.displayAt(this.center);
    return {
      sleeping: this.sleeping,
      waking: now < this.wakingUntil,
      hover: this.hover,
      dragging: this.dragging,
      idle: now - this.lastInteraction > IDLE_AFTER_MS,
      faceRect: this.faceRect(),
      bubbles: { open: this.bubblesOpen, direction: this.bubbleDir },
      ui: { mode: this.mode(), prompt: this.prompt(), result: this.result, side: this.side, controlsDir: this.controlsDir },
      quadrant: quadrantOf(this.center, display.workArea),
    };
  }

  private broadcast(force = false): void {
    const state = this.getState();
    const key = JSON.stringify(state);
    if (!force && key === this.lastState) return;
    this.lastState = key;
    try {
      if (!this.face.isDestroyed() && !this.face.webContents.isDestroyed()) this.face.webContents.send('character:state', state);
    } catch {
      /* 終了処理中のウィンドウ */
    }
    this.emit('state', state);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
