/**
 * 画面変化の検出 (純粋関数)。
 * 縮小したグレースケール画像 (フィンガープリント) 同士を比較して、操作後に画面が変化したかを判定する。
 */

export const FINGERPRINT_W = 64;
export const FINGERPRINT_H = 36;

/** BGRA ビットマップからグレースケールのフィンガープリントを作る */
export function fingerprintFromBgra(bgra: Uint8Array | Buffer, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const b = bgra[i * 4];
    const g = bgra[i * 4 + 1];
    const r = bgra[i * 4 + 2];
    out[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return out;
}

export interface ChangeResult {
  /** 変化したピクセルの割合 (0..1) */
  changedRatio: number;
  /** 平均輝度差 (0..1) */
  meanDiff: number;
  changed: boolean;
}

export function compareFingerprints(a: Uint8Array | null, b: Uint8Array | null, pixelThreshold = 18): ChangeResult {
  if (!a || !b || a.length !== b.length || a.length === 0) {
    return { changedRatio: 1, meanDiff: 1, changed: true };
  }
  let changedPixels = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > pixelThreshold) changedPixels++;
  }
  const changedRatio = changedPixels / a.length;
  const meanDiff = sum / a.length / 255;
  // カーソル点滅程度の微小変化は無視する
  return { changedRatio, meanDiff, changed: changedRatio > 0.002 || meanDiff > 0.004 };
}

export function describeChange(r: ChangeResult): string {
  if (!r.changed) return '画面に変化はありません';
  const pct = Math.round(r.changedRatio * 1000) / 10;
  return pct >= 30 ? `画面が大きく変化しました (${pct}%)` : `画面が変化しました (${pct}%)`;
}
