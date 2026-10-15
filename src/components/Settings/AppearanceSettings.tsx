import type { Corner, PublicSettings } from '../../services/settings/schema';
import { gumi } from '../../services/bridge';
import { call, updateSettings } from '../../stores/appStore';
import { GumiOrb } from '../GumiOrb/GumiOrb';
import { AiCursorIcon } from '../../pages/CursorPage';
import { ColorChoice, Field, NumberInput, Select, Toggle, ToneChoice } from '../ui/controls';

/** 外観: 白 / 黒・大きさ・アニメーション */
export function AppearanceSettings({ settings }: { settings: PublicSettings }) {
  const size = settings.character.size;
  return (
    <>
      <section className="s-card preview-card">
        <div className="preview-stage orb-preview">
          <GumiOrb size={size} state="normal" bubbles={{ open: true, direction: 'up' }} />
        </div>
        <div className="preview-controls">
          <h2>プレビュー</h2>
          <p className="s-desc">カーソルを円に合わせると、上に「設定」と「色の切り替え」の小さな円が出ます。円をクリックすると左に入力欄が出ます。</p>
          <div className="cursor-preview" title="AI のカーソル">
            <AiCursorIcon color={settings.appearance.color} amuTone={settings.appearance.amuTone} />
            <span className="s-desc">AI のカーソル</span>
          </div>
        </div>
      </section>

      <section className="s-card">
        <h2>色</h2>
        <Field label="円と UI の色" hint="白と黒は、円にカーソルを合わせて出る色切り替えボタンでも切り替えられます。亜夢はここでだけ選べます">
          <ColorChoice value={settings.appearance.color} onChange={(color) => void updateSettings({ appearance: { color } })} />
        </Field>
        {settings.appearance.color === 'amu' && (
          <Field label="亜夢の画面の色" hint="円は緑のまま、入力欄・小さな円・ボタン・設定画面を白か黒の配色にします">
            <ToneChoice value={settings.appearance.amuTone} onChange={(amuTone) => void updateSettings({ appearance: { amuTone } })} />
          </Field>
        )}
      </section>

      <section className="s-card">
        <h2>大きさと動き</h2>
        <Field label="円の大きさ">
          <input
            type="range"
            min={20}
            max={96}
            step={2}
            value={size}
            aria-label="円の大きさ"
            onChange={(e) => void updateSettings({ character: { size: Number(e.target.value) } })}
          />
          <span className="s-value">{size}px</span>
        </Field>
        <Toggle
          label="AI のカーソルを表示"
          hint="AI がマウスを動かしている間、その位置に左上を向いた「<」の形のカーソルを表示します。色は上の白 / 黒に合わせて変わります"
          checked={settings.appearance.aiCursor}
          onChange={(aiCursor) => void updateSettings({ appearance: { aiCursor } })}
        />
        <Toggle
          label="状態のアニメーション"
          hint="考え中・操作中などを円の周りの動きで表します"
          checked={settings.appearance.animations}
          onChange={(animations) => void updateSettings({ appearance: { animations } })}
        />
      </section>
    </>
  );
}

const CORNER_OPTIONS: { value: Corner; label: string }[] = [
  { value: 'top-left', label: '左上' },
  { value: 'top-right', label: '右上' },
  { value: 'bottom-left', label: '左下' },
  { value: 'bottom-right', label: '右下' },
];

/** 表示位置・スリープの設定 */
export function CharacterSettings({ settings }: { settings: PublicSettings }) {
  const c = settings.character;
  const setC = (patch: Partial<typeof c>) => void updateSettings({ character: patch });

  return (
    <>
      <section className="s-card">
        <h2>表示</h2>
        <Toggle
          label="Gumi を表示"
          hint="非表示にしてもタスクトレイから戻せます"
          checked={c.visible}
          onChange={(visible) => void call(() => gumi().invoke('character:set-visible', { visible }))}
        />
        <Toggle label="常に最前面に表示" checked={c.alwaysOnTop} onChange={(alwaysOnTop) => setC({ alwaysOnTop })} />
        <Toggle label="画面端に吸着" hint="ドラッグで端の近くに置くとぴったり寄せます" checked={c.snapToEdges} onChange={(snapToEdges) => setC({ snapToEdges })} />
        <Field label="起動時の表示位置">
          <Select
            value={c.startPosition}
            options={[{ value: 'last', label: '前回の位置' }, ...CORNER_OPTIONS]}
            onChange={(startPosition) => setC({ startPosition })}
          />
        </Field>
        <Field label="今すぐ移動">
          <div className="btn-row">
            {CORNER_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className="btn btn-small"
                onClick={() => void call(() => gumi().invoke('character:move-to-corner', { corner: o.value }))}
              >
                {o.label}
              </button>
            ))}
          </div>
        </Field>
      </section>

      <section className="s-card">
        <h2>スリープ</h2>
        <p className="s-desc">しばらく操作がないと円が薄くなります (PC はスリープしません)。タスク実行中や承認待ちの間は薄くなりません。</p>
        <Toggle label="操作がないときに薄くする" checked={c.sleepEnabled} onChange={(sleepEnabled) => setC({ sleepEnabled })} />
        <Field label="薄くなるまでの時間">
          <NumberInput value={c.sleepAfterSec} min={10} max={3600} suffix="秒" onCommit={(sleepAfterSec) => setC({ sleepAfterSec })} />
        </Field>
      </section>
    </>
  );
}
