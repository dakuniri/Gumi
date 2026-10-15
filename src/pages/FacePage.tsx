/**
 * Gumi の円のウィンドウ (透明・枠なし)。
 * - クリック透過の切り替えは Main がカーソル位置から判定する (円・小さな円・入力欄・ボタンの上だけ受け付ける)
 * - 円を押す -> Main がカーソルを追跡してドラッグ移動 / クリック判定 (クリックで入力欄を開閉)
 * - 承認待ち・質問待ちは円の横 (入力欄の位置) に出す
 * - 小さな円をクリック -> 設定を開く / 白黒を切り替える
 */
import { GumiOrb } from '../components/GumiOrb/GumiOrb';
import { OrbControls } from '../components/OrbControls/OrbControls';
import { useApp } from '../hooks/useApp';
import { useExpression } from '../hooks/useExpression';
import { gumi } from '../services/bridge';

const onOrb = (e: React.PointerEvent) => !!(e.target as Element).closest('.orb');

export function FacePage() {
  const settings = useApp((s) => s.settings);
  const character = useApp((s) => s.character);
  const agent = useApp((s) => s.agent);
  const { expression } = useExpression();
  const size = settings?.character.size ?? 36;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !onOrb(e)) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    gumi().send('character:pointer-down', {});
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    gumi().send('character:pointer-up', {});
  };

  if (!settings) return null;

  return (
    <div
      className="face-root"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <GumiOrb
        size={size}
        state={expression}
        bubbles={character?.bubbles ?? { open: false, direction: 'up' }}
        onBubble={(action) => gumi().send('character:bubble', { action })}
      >
        <OrbControls
          size={size}
          ui={character?.ui ?? { mode: 'idle', prompt: null, result: null, side: 'left', controlsDir: 'up' }}
          agent={agent}
        />
      </GumiOrb>
    </div>
  );
}
