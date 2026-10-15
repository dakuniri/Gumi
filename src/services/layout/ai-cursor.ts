/**
 * AI カーソル (「<」の形) の形と位置合わせ (純粋関数)。
 *
 * 「<」を 45 度回して、とがった先端を左上 (ホットスポット) に向けた形。
 * 2 本の腕は先端から右下方向へ、中心線 (45 度) から左右に OPEN_HALF_ANGLE ずつ開いて伸びる。
 * 先端がクリック位置になる。
 */
import type { Point } from '../../types/character';

/** オーバーレイウィンドウの一辺 (DIP) */
export const CURSOR_WINDOW = 36;

/** ウィンドウ内での先端 (クリック位置) */
export const CURSOR_HOTSPOT = { x: 4, y: 4 };

const AXIS_DEG = 45; // 右下向き (= 先端は左上を向く)
const OPEN_HALF_ANGLE = 24; // 「<」の開き具合 (片側)
const ARM_LENGTH = 23;
const THICKNESS = 6;

const rad = (d: number) => (d * Math.PI) / 180;
const r1 = (v: number) => Math.round(v * 100) / 100;

/** 「<」を太い線として描いた多角形の頂点 (先端から時計回り) */
export function chevronPoints(tip: Point = CURSOR_HOTSPOT): Point[] {
  const a1 = rad(AXIS_DEG - OPEN_HALF_ANGLE); // 上側の腕 (右へ伸びる)
  const a2 = rad(AXIS_DEG + OPEN_HALF_ANGLE); // 下側の腕 (下へ伸びる)
  const p1 = { x: tip.x + ARM_LENGTH * Math.cos(a1), y: tip.y + ARM_LENGTH * Math.sin(a1) };
  const p2 = { x: tip.x + ARM_LENGTH * Math.cos(a2), y: tip.y + ARM_LENGTH * Math.sin(a2) };
  // 腕の内側へ太さ分ずらした点
  const p1in = { x: p1.x - THICKNESS * Math.sin(a1), y: p1.y + THICKNESS * Math.cos(a1) };
  const p2in = { x: p2.x + THICKNESS * Math.sin(a2), y: p2.y - THICKNESS * Math.cos(a2) };
  // 内側の頂点 (2 本の内側の線の交点): 中心線上、先端から THICKNESS / sin(開き角) の位置
  const d = THICKNESS / Math.sin(rad(OPEN_HALF_ANGLE));
  const inner = { x: tip.x + d * Math.cos(rad(AXIS_DEG)), y: tip.y + d * Math.sin(rad(AXIS_DEG)) };
  return [tip, p1, p1in, inner, p2in, p2].map((p) => ({ x: r1(p.x), y: r1(p.y) }));
}

export function chevronPath(tip: Point = CURSOR_HOTSPOT): string {
  const pts = chevronPoints(tip);
  return `M${pts.map((p) => `${p.x} ${p.y}`).join(' L')} Z`;
}
