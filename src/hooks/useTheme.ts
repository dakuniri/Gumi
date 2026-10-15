import { useEffect } from 'react';
import type { PublicSettings } from '../services/settings/schema';

/** 白 / 黒 / 亜夢 (#279634)。亜夢は設定画面からだけ選べる (円の上の切り替えは白と黒のみ) */
export type GumiColor = 'white' | 'black' | 'amu';

export const AMU_GREEN = '#279634';

export const COLOR_LABELS: Record<GumiColor, string> = { white: '白', black: '黒', amu: '亜夢' };

/** 亜夢のときの画面 (入力欄・小さな円・ボタン・設定画面) の色。白 / 黒の配色と同じになる */
export type AmuTone = 'white' | 'black';

/** 白 / 黒の配色の塗り (bg) と文字・縁 (fg) */
export function colorPair(color: GumiColor, amuTone: AmuTone = 'white'): { fg: string; bg: string } {
  const base = color === 'amu' ? amuTone : color;
  return base === 'black' ? { fg: '#ffffff', bg: '#111111' } : { fg: '#111111', bg: '#ffffff' };
}

/** 配色 (円と画面)。--core-* は円そのものの色 (亜夢のときだけ緑の円に白の記号) */
export function paletteFor(color: GumiColor, amuTone: AmuTone = 'white'): Record<string, string> {
  const base: 'white' | 'black' = color === 'amu' ? amuTone : color;
  const { fg, bg } = colorPair(base);
  return {
    '--orb-bg': bg,
    '--orb-fg': fg,
    '--core-bg': color === 'amu' ? AMU_GREEN : bg,
    '--core-fg': color === 'amu' ? '#ffffff' : fg,
    '--accent': fg,
    '--accent-soft': base === 'black' ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)',
    '--button': fg,
    '--button-hover': base === 'black' ? '#dddddd' : '#333333',
    '--button-text': bg,
    // 状態表示も 1 色のみ (動き・形で区別する)
    '--status-thinking': fg,
    '--status-working': fg,
    '--status-success': fg,
    '--status-error': fg,
    '--status-waiting': fg,
  };
}

/** 画面の明暗 (亜夢は選んだ白 / 黒に合わせる) */
export function themeOf(color: GumiColor, amuTone: AmuTone = 'white'): 'light' | 'dark' {
  return (color === 'amu' ? amuTone : color) === 'black' ? 'dark' : 'light';
}

/** 設定の配色をドキュメントへ反映する (変更は即座に反映される) */
export function useTheme(settings: PublicSettings | null): GumiColor {
  const color: GumiColor = settings?.appearance.color ?? 'white';
  const amuTone: AmuTone = settings?.appearance.amuTone ?? 'white';
  const animations = settings?.appearance.animations ?? true;

  useEffect(() => {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(paletteFor(color, amuTone))) root.style.setProperty(k, v);
    root.dataset.theme = themeOf(color, amuTone);
    root.classList.toggle('no-anim', !animations);
  }, [color, amuTone, animations]);

  return color;
}
