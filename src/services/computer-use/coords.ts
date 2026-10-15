/**
 * AI が扱う「スクリーンショット画像座標」と、OS の「物理ピクセル座標 (仮想スクリーン)」の相互変換。
 *
 * AI には対象ディスプレイ (またはウィンドウ) を縮小した画像を渡す。
 * AI が返す座標は画像上のピクセル位置なので、撮影時の領域とスケールを使って物理座標へ戻す。
 * DPI スケーリングとマルチモニター (負の座標を含む) に対応する。
 */
import type { Point, Rect } from '../../types/character';

export interface CaptureFrame {
  /** 撮影領域 (物理ピクセル, 仮想スクリーン座標) */
  region: Rect;
  /** AI に渡した画像のサイズ */
  imageWidth: number;
  imageHeight: number;
  /** 対象ディスプレイ */
  displayId: number;
  displayIndex: number;
  /** 撮影領域が属するディスプレイの DPI 倍率 */
  scaleFactor: number;
}

/** 物理サイズを、長辺が maxLongEdge 以下になるよう縮小したサイズ */
export function fitImageSize(width: number, height: number, maxLongEdge: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxLongEdge) return { width: Math.round(width), height: Math.round(height) };
  const s = maxLongEdge / long;
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

export function createFrame(
  region: Rect,
  maxLongEdge: number,
  display: { id: number; index: number; scaleFactor: number },
): CaptureFrame {
  const size = fitImageSize(region.width, region.height, maxLongEdge);
  return {
    region,
    imageWidth: size.width,
    imageHeight: size.height,
    displayId: display.id,
    displayIndex: display.index,
    scaleFactor: display.scaleFactor,
  };
}

/** 画像座標 → 物理座標 */
export function imageToScreen(frame: CaptureFrame, p: Point): Point {
  const sx = frame.region.width / frame.imageWidth;
  const sy = frame.region.height / frame.imageHeight;
  return {
    x: Math.round(frame.region.x + p.x * sx),
    y: Math.round(frame.region.y + p.y * sy),
  };
}

/** 物理座標 → 画像座標 */
export function screenToImage(frame: CaptureFrame, p: Point): Point {
  const sx = frame.imageWidth / frame.region.width;
  const sy = frame.imageHeight / frame.region.height;
  return {
    x: Math.round((p.x - frame.region.x) * sx),
    y: Math.round((p.y - frame.region.y) * sy),
  };
}

export function screenRectToImage(frame: CaptureFrame, r: Rect): Rect {
  const tl = screenToImage(frame, { x: r.x, y: r.y });
  const br = screenToImage(frame, { x: r.x + r.width, y: r.y + r.height });
  return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
}

export function rectCenter(r: Rect): Point {
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}

/** 物理矩形とディスプレイ (物理) の重なり面積 */
export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
