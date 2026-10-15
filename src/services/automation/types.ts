/**
 * PC 操作エンジンの OS 共通インターフェース。
 * Windows (Win32 + UI Automation) と macOS (CoreGraphics + アクセシビリティ API) がそれぞれ実装する。
 *
 * 座標はすべて「入力座標系」:
 *   Windows = 物理ピクセル (仮想スクリーン座標)
 *   macOS   = ポイント (グローバル表示座標。メインディスプレイ左上が原点、Electron の DIP と同じ)
 */
import type { Point, Rect } from '../../types/character';
import type { KeySpec } from './keys';

export type MouseButton = 'left' | 'right' | 'middle';
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';
export type AutomationPlatform = 'win32' | 'darwin';

export interface InputHooks {
  /** 入力を注入する直前 (Gumi のウィンドウをクリック透過にする) */
  before?: () => void;
  after?: () => void;
  /** AI がカーソルを動かした (AI カーソルの表示用) */
  moved?: (p: Point) => void;
}

export interface InputDriver {
  hooks: InputHooks;
  /** 入力を注入中か */
  readonly injecting: boolean;
  /** 最後に入力を注入した時刻 (Date.now) */
  lastInjectionAt: number;
  getCursor(): Point;
  virtualScreen(): Rect;
  moveTo(x: number, y: number, opts?: { smooth?: boolean; durationMs?: number; signal?: AbortSignal }): Promise<void>;
  mouseDown(button?: MouseButton): Promise<void>;
  mouseUp(button?: MouseButton): Promise<void>;
  click(opts: {
    x?: number;
    y?: number;
    button?: MouseButton;
    clicks?: number;
    modifiers?: KeySpec[];
    signal?: AbortSignal;
  }): Promise<void>;
  hold(opts: { x?: number; y?: number; button?: MouseButton; durationMs: number; signal?: AbortSignal }): Promise<void>;
  drag(opts: { from: Point; to: Point; button?: MouseButton; durationMs?: number; signal?: AbortSignal }): Promise<void>;
  scroll(opts: { x?: number; y?: number; direction: ScrollDirection; amount: number; signal?: AbortSignal }): Promise<void>;
  keyDown(spec: KeySpec): Promise<void>;
  keyUp(spec: KeySpec): Promise<void>;
  pressCombo(keys: KeySpec[], opts?: { repeat?: number; signal?: AbortSignal }): Promise<void>;
  holdKey(spec: KeySpec, durationMs: number, signal?: AbortSignal): Promise<void>;
  /** IME を経由せず Unicode 文字をそのまま入力する */
  typeUnicode(text: string, signal?: AbortSignal): Promise<void>;
  /** 押下中のキー・ボタンをすべて離す */
  releaseAll(): { keys: number; buttons: number };
  /** システム全体で最後に入力があってからの経過ミリ秒 (注入した入力も含む) */
  msSinceLastInput(): number;
  isMouseButtonDown(button?: MouseButton): boolean;
}

export interface WindowInfo {
  /** Windows: HWND / macOS: CGWindowID */
  hwnd: number;
  title: string;
  className: string;
  pid: number;
  processName: string;
  rect: Rect;
  minimized: boolean;
  maximized: boolean;
  foreground: boolean;
  responding: boolean;
}

export type WindowAction = 'minimize' | 'maximize' | 'restore' | 'close';

export interface WindowDriver {
  list(excludePids: number[]): WindowInfo[];
  foreground(excludePids?: number[]): WindowInfo | null;
  pidOf(id: number): number;
  titleOf(id: number): string;
  findByTitle(query: string, excludePids: number[]): WindowInfo | null;
  /** 前面に出してアクティブにする。できたら true */
  focus(id: number, input: InputDriver): Promise<boolean>;
  action(id: number, action: WindowAction): Promise<void>;
  /** 見た目の矩形が指定値になるよう移動 / サイズ変更 (入力座標系) */
  setBounds(id: number, bounds: { x: number; y: number; width?: number; height?: number }): Promise<void>;
  /** 前面のアプリなど、非同期でしか取れない情報を最新にする (macOS) */
  sync?(): Promise<void>;
  /** アプリ (pid) を前面に出す (macOS: 入力欄を閉じた後に元のアプリへフォーカスを戻す) */
  activateApp?(pid: number): Promise<boolean>;
}

export interface ProcessInfo {
  pid: number;
  parentPid: number;
  threads: number;
  name: string;
}

export interface ProcessDriver {
  list(): ProcessInfo[];
}

export interface UiElement {
  id: number;
  name: string;
  type: string;
  automationId: string;
  className: string;
  /** 入力座標系 */
  rect: Rect;
  enabled: boolean;
  focused: boolean;
  patterns: string[];
  value?: string;
  password?: boolean;
  toggleState?: string;
}

export interface UiTree {
  window: string;
  elements: UiElement[];
  truncated: boolean;
  elapsedMs: number;
}

export interface StartApp {
  name: string;
  /** Windows: AppID または実行ファイルのパス / macOS: .app のパス */
  appId: string;
}

/** 画面の UI 要素 (Windows: UI Automation / macOS: アクセシビリティ API) */
export interface UiDriver {
  ping(): Promise<Record<string, unknown>>;
  listElements(opts: {
    hwnd?: number;
    maxCount?: number;
    maxDepth?: number;
    interactiveOnly?: boolean;
    budgetMs?: number;
  }): Promise<UiTree>;
  elementAt(x: number, y: number): Promise<UiElement | null>;
  focusedElement(): Promise<UiElement | null>;
  /** 既定の操作を実行。対応する操作が無ければ null (呼び出し側でクリックにフォールバック) */
  invoke(elementId: number): Promise<string | null>;
  setValue(elementId: number, value: string): Promise<void>;
  focus(elementId: number): Promise<void>;
  rect(elementId: number): Promise<Rect>;
  /** 起動できるアプリの一覧 */
  startApps(): Promise<StartApp[]>;
  dispose(): void;
}

export interface ShellApi {
  openPath(p: string): Promise<string>;
  openExternal(url: string): Promise<void>;
}

export interface LaunchResult {
  method: 'alias' | 'path' | 'start-menu' | 'uri' | 'executable' | 'application';
  target: string;
  label: string;
}

export interface AppLauncher {
  launch(name: string, args: string[], deps: { shell: ShellApi; startApps: () => Promise<StartApp[]> }): Promise<LaunchResult>;
  isHighRisk(name: string): boolean;
}

export interface PermissionStatus {
  /** macOS: アクセシビリティ (マウス・キーボード操作と UI 要素の取得に必要) / Windows: 常に true */
  accessibility: boolean;
  /** macOS: 画面収録 / Windows: 常に 'granted' */
  screen: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';
}

export interface Automation {
  platform: AutomationPlatform;
  available: boolean;
  error: string | null;
  input: InputDriver;
  windows: WindowDriver;
  processes: ProcessDriver;
  ui: UiDriver;
  apps: AppLauncher;
}
