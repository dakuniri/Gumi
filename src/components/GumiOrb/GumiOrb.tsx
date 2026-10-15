import type { CSSProperties, ReactNode } from 'react';
import type { ExpressionName } from '../../types/character';
import type { BubbleAction, BubbleDirection } from '../../services/layout/bubbles';
import { bubbleGeometry, bubbleOffsets } from '../../services/layout/bubbles';
import './gumi-orb.css';

/** 円の状態 → 見た目のクラス (色は白 / 黒のみ。状態は動きで表す) */
export function orbStateClass(state: ExpressionName): string {
  switch (state) {
    case 'thinking':
      // 円の中に「?」を表示
      return 'orb--thinking';
    case 'searching':
      // 円の中に虫眼鏡を表示
      return 'orb--searching';
    case 'working':
      // 円の中に「・・・」を順番に跳ねるアニメーションで表示
      return 'orb--working';
    case 'waiting':
      return 'orb--waiting';
    case 'success':
      // 円の中にチェックマークを表示
      return 'orb--success';
    case 'failure':
    case 'error':
      return 'orb--error';
    case 'sleep':
      return 'orb--sleep';
    case 'waking':
      return 'orb--waking';
    case 'hover':
      return 'orb--hover';
    case 'drag':
      return 'orb--drag';
    default:
      return 'orb--idle';
  }
}

const BUBBLE_LABELS: Record<BubbleAction, string> = { settings: '設定', color: '色を切り替え (白 / 黒)' };

function GearIcon() {
  const teeth = Array.from({ length: 8 }, (_, i) => (
    <rect key={i} x="10.6" y="2.2" width="2.8" height="4.2" rx="0.8" transform={`rotate(${i * 45} 12 12)`} />
  ));
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="bubble-icon">
      <g className="icon-fill">{teeth}</g>
      <circle cx="12" cy="12" r="6.6" className="icon-fill" />
      <circle cx="12" cy="12" r="2.6" className="icon-hole" />
    </svg>
  );
}

function ColorIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="bubble-icon">
      <circle cx="12" cy="12" r="7.5" className="icon-ring" />
      <path d="M12 4.5 A7.5 7.5 0 0 1 12 19.5 Z" className="icon-fill" />
    </svg>
  );
}

/** 虫眼鏡 (検索中) */
function SearchMark({ size }: { size: number }) {
  const s = Math.round(size * 0.56);
  return (
    <span className="orb-mark orb-search" aria-hidden>
      <svg width={s} height={s} viewBox="0 0 24 24">
        <circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" strokeWidth="2.6" />
        <path d="M14.6 14.6 L20.5 20.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/** チェックマーク (作業完了) */
function CheckMark({ size }: { size: number }) {
  const s = Math.round(size * 0.6);
  return (
    <span className="orb-mark orb-check" aria-hidden>
      <svg width={s} height={s} viewBox="0 0 24 24">
        <path
          className="check-path"
          d="M4.5 12.5 L9.8 17.6 L19.5 6.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
        />
      </svg>
    </span>
  );
}

export interface GumiOrbProps {
  size: number;
  /** 入力欄・作業中ボタンなど、円の周りに重ねて描く要素 */
  children?: ReactNode;
  state: ExpressionName;
  bubbles: { open: boolean; direction: BubbleDirection };
  onBubble?: (action: BubbleAction) => void;
}

/**
 * 白 / 黒の小さな円。カーソルを合わせると、上 (余白が無ければ下) に
 * 設定と色変更の 2 つの小さな円が現れる。
 * ウィンドウ中央に円を置く前提で、座標は中央基準で配置する。
 */
export function GumiOrb({ size, state, bubbles, onBubble, children }: GumiOrbProps) {
  const g = bubbleGeometry(size);
  return (
    <div className="orb-stage">
      {children}
      <div className={`orb ${orbStateClass(state)}`} style={{ width: size, height: size }} role="img" aria-label="Gumi">
        <span className="orb-ring" />
        {state === 'thinking' && (
          <span className="orb-mark orb-question" style={{ fontSize: Math.round(size * 0.58) }} aria-hidden>
            ?
          </span>
        )}
        {state === 'searching' && <SearchMark size={size} />}
        {state === 'success' && <CheckMark size={size} />}
        {state === 'working' && (
          <span className="orb-mark orb-dots" style={{ gap: Math.max(2, Math.round(size * 0.07)) }} aria-hidden>
            {[0, 1, 2].map((i) => (
              <span key={i} className="orb-dot" style={{ width: Math.max(3, Math.round(size * 0.13)) }} />
            ))}
          </span>
        )}
      </div>
      {bubbleOffsets(size, bubbles.direction).map((b, i) => (
        <button
          key={b.action}
          type="button"
          className={`bubble ${bubbles.open ? 'open' : ''} dir-${bubbles.direction}`}
          data-action={b.action}
          title={BUBBLE_LABELS[b.action]}
          aria-label={BUBBLE_LABELS[b.action]}
          tabIndex={-1}
          style={
            {
              width: g.bubble,
              height: g.bubble,
              // 円の中心から自分の位置へ飛び出す (閉じるときは円へ戻る)。順番に少しずつ遅らせる
              '--tx': `${b.dx}px`,
              '--ty': `${b.dy}px`,
              transitionDelay: bubbles.open ? `${i * 45}ms` : `${(1 - i) * 25}ms`,
            } as CSSProperties
          }
          onClick={() => onBubble?.(b.action)}
        >
          {b.action === 'settings' ? <GearIcon /> : <ColorIcon />}
        </button>
      ))}
    </div>
  );
}
