/**
 * 円の横に出る入力欄・停止ボタン・一時停止ボタンと、上に出る小さな円 (設定 / 色) を含む
 * Gumi ウィンドウ全体の配置 (純粋関数, DIP, 円の中心からの相対座標)。
 *
 *   入力中:   [停止] (        入力欄        ) (円)
 *   作業中:            [一時停止] [停止]
 *                            (円)
 *   承認・質問:  (  許可 / 拒否 や 回答欄  )(円)   (作業中のボタンはそのまま)
 * 円が画面の左端にあって左に余白が無いときは左右を反転して右側に出す。
 * 円が画面の上端にあって上に余白が無いときは、作業中のボタンを下に出す。
 */
import type { Point } from '../../types/character';
import { bubbleGeometry, bubbleOffsets, type BubbleAction, type BubbleDirection } from './bubbles';

export const PILL_WIDTH = 240;
export const PILL_HEIGHT = 34;
export const BUTTON = 28;
export const GAP = 8;
const PAD = 10;
/** 入力欄の上に出す質問・承認内容の吹き出しの最大の高さ (3 行) */
const NOTE_HEIGHT = 64;

export type UiMode = 'idle' | 'input' | 'task';
/** 作業中に入力欄の位置へ出す確認 (承認 / AI からの質問) */
export type Prompt = 'approval' | 'question' | null;
export type Side = 'left' | 'right';
export type ControlsDirection = 'up' | 'down';
export type ControlTarget = 'orb' | 'pill' | 'stop' | 'pause' | 'result' | BubbleAction;

/** 作業後に円の横に出す結果の吹き出しの最大の高さ */
export const RESULT_MAX_HEIGHT = 150;

export interface Layout {
  pill: { cx: number; cy: number; width: number; height: number };
  /** 入力中の停止ボタン (入力欄の外側) */
  inputStop: Point;
  /** 作業中の一時停止 / 停止ボタン (円の上、一時停止が左) */
  taskPause: Point;
  taskStop: Point;
}

export function controlsLayout(size: number, side: Side, dir: ControlsDirection): Layout {
  const half = size / 2;
  const s = side === 'left' ? -1 : 1;
  const pillCx = s * (half + GAP + PILL_WIDTH / 2);
  const stopX = s * (half + GAP + PILL_WIDTH + GAP + BUTTON / 2);
  const ty = (dir === 'up' ? -1 : 1) * (half + GAP + BUTTON / 2);
  const tx = BUTTON / 2 + GAP / 2;
  return {
    pill: { cx: pillCx, cy: 0, width: PILL_WIDTH, height: PILL_HEIGHT },
    inputStop: { x: stopX, y: 0 },
    taskPause: { x: -tx, y: ty },
    taskStop: { x: tx, y: ty },
  };
}

/**
 * 円のまわりに常に付いて回るもの (状態リングと影 / 作業中の一時停止・停止ボタン / 上に出る 2 つの小さな円) が
 * 円の中心から最大どこまで広がるか。円をこの分だけ画面の内側に置けば、どれも画面の端で切れない。
 * (入力欄・作業中ボタンと小さな円の上下は、余白がある側へ向きを変えるので含めない)
 */
export function orbExtent(size: number): { x: number; y: number } {
  const ring = size / 2 + 8;
  const taskButtons = BUTTON + GAP / 2;
  const b = bubbleGeometry(size);
  const bubblePair = (b.bubble + b.gap) / 2 + b.bubble / 2;
  return { x: Math.ceil(Math.max(ring, taskButtons, bubblePair) + 2), y: Math.ceil(ring + 2) };
}

/** 入力欄を出すために必要な横方向の幅 (円の中心から) */
export function horizontalReach(size: number): number {
  return size / 2 + GAP + PILL_WIDTH + GAP + BUTTON;
}

/** ウィンドウの大きさ (円をウィンドウの中央に置く) */
export function orbWindowSize(size: number): { width: number; height: number } {
  const b = bubbleGeometry(size);
  const width = Math.max(b.windowWidth, Math.ceil(2 * (horizontalReach(size) + PAD)));
  const height = Math.max(
    b.windowHeight,
    Math.ceil(2 * (size / 2 + GAP + BUTTON + PAD)),
    Math.ceil(2 * (PILL_HEIGHT / 2 + 6 + NOTE_HEIGHT + PAD)),
    Math.ceil(2 * (RESULT_MAX_HEIGHT - PILL_HEIGHT / 2 + PAD)),
  );
  return { width, height };
}

/** 円の位置から入力欄を出す側を決める (基本は左) */
export function chooseSide(center: Point, size: number, workArea: { x: number; width: number }): Side {
  return center.x - workArea.x >= horizontalReach(size) + 4 ? 'left' : 'right';
}

/** 作業中のボタンを出す方向 (基本は上) */
export function chooseControlsDirection(center: Point, size: number, workAreaTop: number): ControlsDirection {
  return center.y - workAreaTop >= size / 2 + GAP + BUTTON + 4 ? 'up' : 'down';
}

export interface HitState {
  mode: UiMode;
  prompt?: Prompt;
  /** 結果の吹き出しの実際の高さ (表示中のみ) */
  resultHeight?: number | null;
  side: Side;
  controlsDir: ControlsDirection;
  bubblesOpen: boolean;
  bubbleDir: BubbleDirection;
}

/**
 * 結果の吹き出しの範囲 (入力欄と同じ横位置。下端を入力欄の下端に揃え、ボタンと同じ側へ伸びる)
 */
export function resultRect(size: number, side: Side, dir: ControlsDirection, height: number) {
  const l = controlsLayout(size, side, dir);
  const h = Math.min(RESULT_MAX_HEIGHT, Math.max(PILL_HEIGHT, height));
  const left = l.pill.cx - l.pill.width / 2;
  const y = dir === 'up' ? PILL_HEIGHT / 2 - h : -PILL_HEIGHT / 2;
  return { x: left, y, width: l.pill.width, height: h };
}

/** カーソル (円の中心からの相対位置) がどの部品の上にあるか */
export function hitControl(rel: Point, size: number, st: HitState, slop = 2): ControlTarget | null {
  if (Math.hypot(rel.x, rel.y) <= size / 2 + slop) return 'orb';
  const l = controlsLayout(size, st.side, st.controlsDir);
  const inCircle = (p: Point, d: number) => Math.hypot(rel.x - p.x, rel.y - p.y) <= d / 2 + slop;
  if (st.mode === 'input') {
    const p = l.pill;
    if (Math.abs(rel.x - p.cx) <= p.width / 2 + slop && Math.abs(rel.y - p.cy) <= p.height / 2 + slop) return 'pill';
    if (inCircle(l.inputStop, BUTTON)) return 'stop';
  } else if (st.mode === 'task') {
    if (inCircle(l.taskPause, BUTTON)) return 'pause';
    if (inCircle(l.taskStop, BUTTON)) return 'stop';
    const p = l.pill;
    if (st.prompt && Math.abs(rel.x - p.cx) <= p.width / 2 + slop && Math.abs(rel.y - p.cy) <= p.height / 2 + slop) {
      return 'pill';
    }
  } else if (st.resultHeight) {
    const r = resultRect(size, st.side, st.controlsDir, st.resultHeight);
    if (rel.x >= r.x - slop && rel.x <= r.x + r.width + slop && rel.y >= r.y - slop && rel.y <= r.y + r.height + slop) {
      return 'result';
    }
  }
  if (st.mode === 'idle' && st.bubblesOpen) {
    const r = bubbleGeometry(size).bubble;
    for (const b of bubbleOffsets(size, st.bubbleDir)) {
      if (inCircle({ x: b.dx, y: b.dy }, r)) return b.action;
    }
  }
  return null;
}
