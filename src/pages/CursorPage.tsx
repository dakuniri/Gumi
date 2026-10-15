/**
 * AI カーソルのオーバーレイ (「<」の形、先端は左上)。
 * 塗りは前景色、縁は背景色で、設定の色 (白 / 黒 / 亜夢) に合わせて変わる。
 */
import { useApp } from '../hooks/useApp';
import { AMU_GREEN, colorPair, type AmuTone, type GumiColor } from '../hooks/useTheme';
import { CURSOR_WINDOW, chevronPath } from '../services/layout/ai-cursor';

export function AiCursorIcon({ color, amuTone = 'white' }: { color: GumiColor; amuTone?: AmuTone }) {
  // 亜夢は緑の塗りに、選んだ画面の色 (白 / 黒) の縁 (白黒は前景色の塗りに背景色の縁)
  const { fg, bg } = color === 'amu' ? { fg: AMU_GREEN, bg: amuTone === 'black' ? '#111111' : '#ffffff' } : colorPair(color);
  return (
    <svg width={CURSOR_WINDOW} height={CURSOR_WINDOW} viewBox={`0 0 ${CURSOR_WINDOW} ${CURSOR_WINDOW}`} aria-label="AI のカーソル">
      <path
        className="ai-cursor"
        d={chevronPath()}
        fill={fg}
        stroke={bg}
        strokeWidth="2"
        strokeLinejoin="round"
        paintOrder="stroke"
        style={{ filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,0.45))' }}
      />
    </svg>
  );
}

export function CursorPage() {
  const color = useApp((s) => s.settings?.appearance.color ?? 'white');
  const amuTone = useApp((s) => s.settings?.appearance.amuTone ?? 'white');
  return <AiCursorIcon color={color} amuTone={amuTone} />;
}
