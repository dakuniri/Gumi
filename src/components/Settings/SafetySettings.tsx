import { useEffect, useState } from 'react';
import type { PermissionCategory, PermissionMode, PublicSettings } from '../../services/settings/schema';
import { PERMISSION_CATEGORIES, PERMISSION_LABELS } from '../../services/settings/constants';
import { updateSettings } from '../../stores/appStore';
import { Field, NumberInput, Select, Toggle } from '../ui/controls';

const MODE_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: 'allow', label: '許可' },
  { value: 'ask', label: '毎回確認' },
  { value: 'deny', label: '禁止' },
];

export function PermissionSettings({ settings }: { settings: PublicSettings }) {
  return (
    <>
      <section className="s-card">
        <h2>操作確認ポリシー</h2>
        <Field label="確認を求める操作" hint="ファイル削除・上書き、シェルの起動、AI 自身が確認を求めた操作は常に確認します">
          <Select
            value={settings.confirmPolicy}
            options={[
              { value: 'high', label: '高リスクの操作のみ (推奨)' },
              { value: 'medium', label: '中リスク以上 (アプリ起動・移動など)' },
              { value: 'every', label: 'すべての操作' },
            ]}
            onChange={(confirmPolicy) => void updateSettings({ confirmPolicy })}
          />
        </Field>
      </section>
      <section className="s-card">
        <h2>AI の操作権限</h2>
        <p className="s-desc">「禁止」にした操作は AI に提示されず、実行もされません。</p>
        {PERMISSION_CATEGORIES.map((c: PermissionCategory) => (
          <Field key={c} label={PERMISSION_LABELS[c]}>
            <Select<PermissionMode>
              value={settings.permissions[c]}
              options={MODE_OPTIONS}
              ariaLabel={PERMISSION_LABELS[c]}
              onChange={(v) => void updateSettings({ permissions: { [c]: v } })}
            />
          </Field>
        ))}
      </section>
    </>
  );
}

export function OperationSettings({ settings }: { settings: PublicSettings }) {
  const a = settings.agent;
  const set = (patch: Partial<typeof a>) => void updateSettings({ agent: patch });
  return (
    <section className="s-card">
      <h2>操作</h2>
      <Field label="操作速度" hint="遅いほど確実ですが時間がかかります">
        <Select
          value={a.speed}
          options={[
            { value: 'slow', label: 'ゆっくり' },
            { value: 'normal', label: 'ふつう' },
            { value: 'fast', label: '速い' },
          ]}
          onChange={(speed) => set({ speed })}
        />
      </Field>
      <Field label="最大ステップ数" hint="これを超えるとタスクを打ち切ります">
        <NumberInput value={a.maxSteps} min={1} max={300} onCommit={(maxSteps) => set({ maxSteps })} />
      </Field>
      <Toggle label="自動再試行" hint="失敗した操作や API エラーを自動で再試行します" checked={a.autoRetry} onChange={(autoRetry) => set({ autoRetry })} />
      <Field label="API エラー時の再試行回数">
        <NumberInput value={a.maxApiRetries} min={0} max={10} onCommit={(maxApiRetries) => set({ maxApiRetries })} />
      </Field>
      <Field label="連続失敗の許容回数" hint="超えると AI に方針転換を指示し、さらに続くと停止します">
        <NumberInput value={a.maxActionRetries} min={0} max={10} onCommit={(maxActionRetries) => set({ maxActionRetries })} />
      </Field>
      <Toggle
        label="操作後に画面を撮影して結果を確認"
        checked={a.screenshotAfterAction}
        onChange={(screenshotAfterAction) => set({ screenshotAfterAction })}
      />
      <Field label="会話に残すスクリーンショット数" hint="古い画像は送信対象から外します (通信量の節約)">
        <NumberInput value={a.keepScreenshots} min={1} max={10} onCommit={(keepScreenshots) => set({ keepScreenshots })} />
      </Field>
      <Field label="文字入力の方式" hint="日本語 IME が有効でも正しく入力できる方式を選びます">
        <Select
          value={a.textInputMethod}
          options={[
            { value: 'auto', label: '自動 (短文は直接入力・長文は貼り付け)' },
            { value: 'unicode', label: 'Unicode 直接入力' },
            { value: 'clipboard', label: 'クリップボード経由で貼り付け' },
          ]}
          onChange={(textInputMethod) => set({ textInputMethod })}
        />
      </Field>
      <Toggle
        label="あなたが操作したら自動で一時停止"
        hint="AI の作業中にマウスやキーボードを使うと、すぐに一時停止して制御を戻します"
        checked={a.pauseOnUserInput}
        onChange={(pauseOnUserInput) => set({ pauseOnUserInput })}
      />
    </section>
  );
}

export function ScreenshotSettings({ settings }: { settings: PublicSettings }) {
  const s = settings.screenshot;
  const set = (patch: Partial<typeof s>) => void updateSettings({ screenshot: patch });
  const [keywords, setKeywords] = useState(s.blockedWindowKeywords.join('\n'));
  useEffect(() => setKeywords(s.blockedWindowKeywords.join('\n')), [s.blockedWindowKeywords]);
  return (
    <section className="s-card">
      <h2>スクリーンショット</h2>
      <Field label="撮影範囲 (AI と共有する範囲)">
        <Select
          value={s.scope}
          options={[
            { value: 'cursor-display', label: 'カーソルがあるディスプレイ' },
            { value: 'primary-display', label: 'メインディスプレイ' },
            { value: 'active-window', label: 'アクティブなウィンドウのみ' },
          ]}
          onChange={(scope) => set({ scope })}
        />
      </Field>
      <Field label="送信画像の最大サイズ (長辺)" hint="大きいほど細部まで認識できますが通信量が増えます">
        <NumberInput value={s.maxLongEdge} min={640} max={2560} step={1} suffix="px" onCommit={(maxLongEdge) => set({ maxLongEdge })} />
      </Field>
      <Field label="JPEG 品質">
        <NumberInput value={s.jpegQuality} min={40} max={100} onCommit={(jpegQuality) => set({ jpegQuality })} />
      </Field>
      <Toggle
        label="AI の撮影に Gumi を写さない"
        hint="AI が画面を撮る間だけ Gumi をキャプチャから外し、画面認識の邪魔をしないようにします。画面上の Gumi は消えません (撮影中の一瞬だけ、画面共有の相手側には写らないことがあります)"
        checked={s.hideGumiDuringCapture}
        onChange={(hideGumiDuringCapture) => set({ hideGumiDuringCapture })}
      />
      <Toggle
        label="機密情報を自動マスク"
        hint="API キー・カード番号・パスワード表記などを AI に送る前に伏せます"
        checked={s.redactSecrets}
        onChange={(redactSecrets) => set({ redactSecrets })}
      />
      <div className="field column">
        <div className="field-label">
          撮影を停止するウィンドウのキーワード
          <span className="field-hint">タイトルにこれらを含むウィンドウが表示されている間は、画面を AI に送信しません (1 行に 1 つ)</span>
        </div>
        <textarea
          className="input"
          rows={4}
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          onBlur={() =>
            set({
              blockedWindowKeywords: keywords
                .split('\n')
                .map((k) => k.trim())
                .filter(Boolean)
                .slice(0, 100),
            })
          }
        />
      </div>
    </section>
  );
}
