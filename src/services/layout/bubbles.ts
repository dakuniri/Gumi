/**
 * 円 (Gumi) とホバー時に出る 2 つの小さな円 (設定 / 色変更) の配置 (純粋関数, DIP)。
 * Main (ホバー判定・ウィンドウサイズ) と Renderer (描画・クリック透過判定) で同じ計算を使う。
 */
import type { Point } from '../../types/character';

export type BubbleAction = 'settings' | 'color';
export type BubbleDirection = 'up' | 'down';

export interface BubbleGeometry {
  /** 小さな円の直径 */
  bubble: number;
  gap: number;
  pad: number;
  /** 円の中心から小さな円の中心までの縦の距離 */
  radius: number;
  windowWidth: number;
  windowHeight: number;
}

export function bubbleGeometry(size: number): BubbleGeometry {
  const bubble = Math.max(22, Math.round(size * 0.72));
  const gap = Math.max(5, Math.round(size * 0.16));
  const pad = 8;
  const radius = size / 2 + gap + bubble / 2;
  const width = Math.max(size, bubble * 2 + gap);
  return {
    bubble,
    gap,
    pad,
    radius,
    windowWidth: width + pad * 2,
    // 円を中心に、上下どちらにも小さな円を出せる高さ
    windowHeight: Math.ceil((radius + bubble / 2) * 2 + pad * 2),
  };
}

/** 円の中心から見た各バブル中心のオフセット */
export function bubbleOffsets(size: number, direction: BubbleDirection): { action: BubbleAction; dx: number; dy: number }[] {
  const g = bubbleGeometry(size);
  const dy = g.radius * (direction === 'up' ? -1 : 1);
  const dx = (g.bubble + g.gap) / 2;
  return [
    { action: 'settings', dx: -dx, dy },
    { action: 'color', dx, dy },
  ];
}

/** 上に出す余白が無いときだけ下に出す */
export function bubbleDirection(center: Point, size: number, workAreaTop: number): BubbleDirection {
  const g = bubbleGeometry(size);
  const needed = g.radius + g.bubble / 2 + 2;
  return center.y - workAreaTop >= needed ? 'up' : 'down';
}

/** カーソル (円の中心からの相対位置) がどのバブル上にあるか */
export function hitBubble(rel: Point, size: number, direction: BubbleDirection, slop = 2): BubbleAction | null {
  const r = bubbleGeometry(size).bubble / 2 + slop;
  for (const b of bubbleOffsets(size, direction)) {
    if (Math.hypot(rel.x - b.dx, rel.y - b.dy) <= r) return b.action;
  }
  return null;
}

/** 円とバブルの間 (カーソル移動中に閉じないための通路) にいるか */
export function inBubbleCorridor(rel: Point, size: number, direction: BubbleDirection): boolean {
  const g = bubbleGeometry(size);
  const halfW = g.bubble + g.gap / 2;
  const y0 = direction === 'up' ? -g.radius : 0;
  const y1 = direction === 'up' ? 0 : g.radius;
  return Math.abs(rel.x) <= halfW && rel.y >= y0 && rel.y <= y1;
}
