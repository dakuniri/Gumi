/**
 * 画面キャプチャ (Electron desktopCapturer)。
 * Main Process 専用。物理解像度で撮影し、AI 送信用に縮小・JPEG 化する。
 * Gumi 自身のウィンドウは撮影の瞬間だけ透明にして写り込みを防ぐ (画面共有や通常のスクショには映る)。
 */
import { desktopCapturer, screen, type Display, type NativeImage } from 'electron';
import { createFrame, type CaptureFrame } from '../computer-use/coords';
import { fingerprintFromBgra, FINGERPRINT_H, FINGERPRINT_W } from './diff';
import type { Rect } from '../../types/character';

export interface DisplayInfo {
  id: number;
  index: number;
  primary: boolean;
  label: string;
  scaleFactor: number;
  /** DIP 座標 */
  bounds: Rect;
  workArea: Rect;
  /**
   * 入力座標系での矩形 (PC 操作エンジンと同じ座標)。
   * Windows: 物理ピクセル / macOS: ポイント (= DIP。CoreGraphics のグローバル座標と同じ)
   */
  physical: Rect;
}

function physicalRect(d: Display): Rect {
  if (process.platform === 'win32') {
    const r = screen.dipToScreenRect(null, d.bounds);
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  if (process.platform === 'darwin') return { ...d.bounds };
  return {
    x: Math.round(d.bounds.x * d.scaleFactor),
    y: Math.round(d.bounds.y * d.scaleFactor),
    width: Math.round(d.bounds.width * d.scaleFactor),
    height: Math.round(d.bounds.height * d.scaleFactor),
  };
}

export function listDisplays(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, index) => ({
    id: d.id,
    index,
    primary: d.id === primaryId,
    label: d.label || `ディスプレイ ${index + 1}`,
    scaleFactor: d.scaleFactor,
    bounds: { ...d.bounds },
    workArea: { ...d.workArea },
    physical: physicalRect(d),
  }));
}

export interface CaptureResult {
  frame: CaptureFrame;
  /** AI に送る画像 (base64) */
  base64: string;
  mediaType: 'image/jpeg' | 'image/png';
  fingerprint: Uint8Array;
  bytes: number;
}

export interface CaptureOptions {
  display: DisplayInfo;
  /** 物理座標の切り抜き領域 (省略時はディスプレイ全体) */
  region?: Rect;
  maxLongEdge: number;
  jpegQuality: number;
}

async function grabDisplay(display: DisplayInfo): Promise<NativeImage> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    // macOS は座標がポイントなので、Retina の実ピクセルで撮ってから縮小する
    thumbnailSize: {
      width: Math.round(display.physical.width * (process.platform === 'darwin' ? display.scaleFactor : 1)),
      height: Math.round(display.physical.height * (process.platform === 'darwin' ? display.scaleFactor : 1)),
    },
    fetchWindowIcons: false,
  });
  const byId = sources.find((s) => s.display_id === String(display.id));
  const src = byId ?? sources[display.index] ?? sources[0];
  if (!src || src.thumbnail.isEmpty()) {
    throw new Error(
      process.platform === 'darwin'
        ? '画面を取得できませんでした。システム設定 > プライバシーとセキュリティ > 画面収録 で Gumi を許可してください'
        : '画面を取得できませんでした (画面キャプチャが OS により制限されている可能性があります)',
    );
  }
  return src.thumbnail;
}

export function fingerprintOf(img: NativeImage): Uint8Array {
  const small = img.resize({ width: FINGERPRINT_W, height: FINGERPRINT_H, quality: 'good' });
  return fingerprintFromBgra(small.toBitmap(), FINGERPRINT_W, FINGERPRINT_H);
}

export async function captureScreen(opts: CaptureOptions): Promise<CaptureResult> {
  const { display } = opts;
  let img = await grabDisplay(display);
  const size = img.getSize();
  // サムネイルが物理解像度と異なる場合に備えて倍率を求める
  const kx = size.width / display.physical.width;
  const ky = size.height / display.physical.height;

  let region: Rect = display.physical;
  if (opts.region) {
    const r = intersect(opts.region, display.physical);
    if (!r) throw new Error('指定領域はディスプレイ外です');
    region = r;
    img = img.crop({
      x: Math.round((r.x - display.physical.x) * kx),
      y: Math.round((r.y - display.physical.y) * ky),
      width: Math.max(1, Math.round(r.width * kx)),
      height: Math.max(1, Math.round(r.height * ky)),
    });
  }

  const frame = createFrame(region, opts.maxLongEdge, display);
  const resized =
    img.getSize().width === frame.imageWidth && img.getSize().height === frame.imageHeight
      ? img
      : img.resize({ width: frame.imageWidth, height: frame.imageHeight, quality: 'best' });
  const jpeg = resized.toJPEG(opts.jpegQuality);
  return {
    frame,
    base64: jpeg.toString('base64'),
    mediaType: 'image/jpeg',
    fingerprint: fingerprintOf(resized),
    bytes: jpeg.length,
  };
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  if (r <= x || btm <= y) return null;
  return { x, y, width: r - x, height: btm - y };
}
