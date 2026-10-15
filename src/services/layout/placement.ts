/**
 * 円の配置計算 (4 隅・画面内への補正・吸着, 純粋関数, DIP 座標)。
 */
import type { Corner } from '../settings/schema';
import type { Point, Rect } from '../../types/character';
import { orbExtent } from './controls';

export const EDGE_MARGIN = 12;
export const SNAP_DISTANCE = 28;

export function center(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function quadrantOf(faceCenter: Point, workArea: Rect): { vertical: 'top' | 'bottom'; horizontal: 'left' | 'right' } {
  const c = center(workArea);
  return {
    vertical: faceCenter.y >= c.y ? 'bottom' : 'top',
    horizontal: faceCenter.x >= c.x ? 'right' : 'left',
  };
}

export function cornerOf(faceCenter: Point, workArea: Rect): Corner {
  const q = quadrantOf(faceCenter, workArea);
  return `${q.vertical}-${q.horizontal}` as Corner;
}

/** 円の矩形 (正方形) を中心とサイズから作る */
export function faceRectFromCenter(c: Point, size: number): Rect {
  return { x: Math.round(c.x - size / 2), y: Math.round(c.y - size / 2), width: size, height: size };
}

/**
 * 画面の端から円の中心までの最小距離 (横 / 縦)。
 * 円だけでなく、まわりのボタン・小さな円・リングも切れない距離にする。
 */
export function edgeInset(size: number, margin: number): { x: number; y: number } {
  const e = orbExtent(size);
  return { x: Math.max(size / 2 + margin, e.x + 2), y: Math.max(size / 2 + margin, e.y + 2) };
}

/** 円 (とまわりのボタン) が作業領域内に収まるよう中心を補正する */
export function clampFaceCenter(c: Point, size: number, workArea: Rect, margin = 4): Point {
  const inset = edgeInset(size, margin);
  const minX = workArea.x + inset.x;
  const maxX = workArea.x + workArea.width - inset.x;
  const minY = workArea.y + inset.y;
  const maxY = workArea.y + workArea.height - inset.y;
  return {
    x: Math.round(Math.min(Math.max(c.x, minX), Math.max(minX, maxX))),
    y: Math.round(Math.min(Math.max(c.y, minY), Math.max(minY, maxY))),
  };
}

/** 画面端に近ければ吸着させる */
export function snapFaceCenter(c: Point, size: number, workArea: Rect, margin = EDGE_MARGIN, distance = SNAP_DISTANCE): Point {
  const inset = edgeInset(size, margin);
  const left = workArea.x + inset.x;
  const right = workArea.x + workArea.width - inset.x;
  const top = workArea.y + inset.y;
  const bottom = workArea.y + workArea.height - inset.y;
  let { x, y } = c;
  if (Math.abs(x - left) <= distance) x = left;
  else if (Math.abs(x - right) <= distance) x = right;
  if (Math.abs(y - top) <= distance) y = top;
  else if (Math.abs(y - bottom) <= distance) y = bottom;
  return { x: Math.round(x), y: Math.round(y) };
}

export function cornerCenter(corner: Corner, size: number, workArea: Rect, margin = EDGE_MARGIN): Point {
  const inset = edgeInset(size, margin);
  const left = workArea.x + inset.x;
  const right = workArea.x + workArea.width - inset.x;
  const top = workArea.y + inset.y;
  const bottom = workArea.y + workArea.height - inset.y;
  return {
    x: Math.round(corner.endsWith('left') ? left : right),
    y: Math.round(corner.startsWith('top') ? top : bottom),
  };
}

export function pointInRect(p: Point, r: Rect, pad = 0): boolean {
  return p.x >= r.x - pad && p.y >= r.y - pad && p.x <= r.x + r.width + pad && p.y <= r.y + r.height + pad;
}
