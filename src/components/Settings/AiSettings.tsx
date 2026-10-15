import { useState } from 'react';
import type { ProviderId, PublicSettings } from '../../services/settings/schema';
import { DEFAULT_PROFILES, PROVIDER_IDS, PROVIDER_LABELS } from '../../services/settings/constants';
import type { ModelInfo } from '../../types/ipc';
import { gumi } from '../../services/bridge';
import { call, updateSettings } from '../../stores/appStore';
import { Badge, CommitInput, Field, NumberInput, Select, Toggle, useAutoSave } from '../ui/controls';

const ENDPOINT_HINTS: Record<ProviderId, string> = {
  anthropic: '通常は https://api.anthropic.com',
  openai: '通常は https://api.openai.com/v1',
  gemini: '通常は https://generativelanguage.googleapis.com/v1beta',
  openrouter: '通常は https://openrouter.ai/api/v1',
  'openai-compatible': '/chat/completions を提供するサーバーのベース URL (…/v1)',
  local: 'Ollama: http://localhost:11434/v1 / LM Studio: http://localhost:1234/v1',
};

export function AiSettings({ settings }: { settings: PublicSettings }) {
  const [editing, setEditing] = useState<ProviderId>(settings.ai.provider);
  const profile = settings.ai.profiles[editing];
  const [fetched, setFetched] = useState<{ provider: ProviderId; models: ModelInfo[] } | null>(null);
  // 一度取得したモデル一覧は保存されているので、次回からもすぐ候補に出る
  const models: ModelInfo[] =
    fetched?.provider === editing
      ? fetched.models
      : (settings.ai.modelCache[editing]?.ids ?? []).map((id) => ({ id }));
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const hasKey = settings.apiKeys[editing];
  const needsKey = editing !== 'local' && editing !== 'openai-compatible';

  const patchProfile = (patch: Partial<typeof profile>) => void updateSettings({ ai: { profiles: { [editing]: patch } } });

  const fetchModels = async () => {
    setBusy('models');
    setResult(null);
    try {
      const list = await gumi().invoke('settings:list-models', { provider: editing });
      setFetched({ provider: editing, models: list });
      setResult({ ok: true, text: `${list.length} 件のモデルを取得しました` });
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setResult(null);
    try {
      const r = await gumi().invoke('settings:test-connection', { provider: editing });
      setResult({ ok: true, text: `接続成功 (${r.ms}ms): ${r.reply}` });
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <section className="s-card">
        <h2>使用する AI</h2>
        <Field label="AI プロバイダー" hint="タスク実行に使うプロバイダー">
          <Select<ProviderId>
            value={settings.ai.provider}
            options={PROVIDER_IDS.map((id) => ({ value: id, label: PROVIDER_LABELS[id] }))}
            onChange={(v) => {
              setEditing(v);
              void updateSettings({ ai: { provider: v } });
            }}
          />
        </Field>
      </section>

      <section className="s-card">
        <div className="s-card-head">
          <h2>プロバイダー設定</h2>
          <div className="provider-tabs">
            {PROVIDER_IDS.map((id) => (
              <button
                key={id}
                type="button"
                className={`chip ${editing === id ? 'chip-on' : ''}`}
                onClick={() => {
                  setEditing(id);
                  setResult(null);
                }}
              >
                {PROVIDER_LABELS[id]}
                {settings.apiKeys[id] && ' (キー設定済み)'}
              </button>
            ))}
          </div>
        </div>

        <Field label="モデル" hint="例: Anthropic は claude-sonnet-5-5。一覧取得で候補を表示できます">
          <CommitInput
            value={profile.model}
            list={`models-${editing}`}
            placeholder="モデル名"
            ariaLabel="モデル名"
            onCommit={(model) => patchProfile({ model: model.trim() })}
          />
          <datalist id={`models-${editing}`}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </datalist>
          <button type="button" className="btn btn-small" disabled={busy !== null} onClick={() => void fetchModels()}>
            {busy === 'models' ? '取得中…' : '一覧を取得'}
          </button>
        </Field>

        <Field label="API エンドポイント" hint={ENDPOINT_HINTS[editing]}>
          <CommitInput
            value={profile.endpoint}
            type="url"
            ariaLabel="API エンドポイント"
            placeholder={DEFAULT_PROFILES[editing].endpoint}
            onCommit={(endpoint) => patchProfile({ endpoint: endpoint.trim() })}
          />
        </Field>

        <Field
          label={
            <>
              API キー {hasKey ? <Badge tone="ok">保存済み</Badge> : needsKey ? <Badge tone="warn">未設定</Badge> : <Badge>任意</Badge>}
            </>
          }
          hint="入力すると自動で保存されます。Windows の DPAPI で暗号化して AppData (%APPDATA%/Gumi) に保存し、画面 (Renderer) には返しません"
        >
          <ApiKeyInput key={editing} provider={editing} hasKey={hasKey} disabled={!settings.secureStorageAvailable} />
          {hasKey && (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              onClick={() => void call(() => gumi().invoke('settings:clear-api-key', { provider: editing }))}
            >
              削除
            </button>
          )}
        </Field>
        {!settings.secureStorageAvailable && (
          <div className="banner danger">OS の安全な保存領域が利用できないため、API キーを保存できません。</div>
        )}

        <Toggle
          label="画像入力 (スクリーンショット) に対応"
          hint={
            profile.supportsVision
              ? '画面を見て操作します'
              : '非対応: 画面認識は UI 要素情報・ウィンドウ情報のみとなり、精度が下がります。画像を見る必要がある作業はできません'
          }
          checked={profile.supportsVision}
          onChange={(supportsVision) => patchProfile({ supportsVision })}
        />
        <Toggle
          label="ツール呼び出し (Function Calling) に対応"
          hint={profile.supportsTools ? 'ネイティブのツール呼び出しで操作します' : '非対応: JSON 形式の指示で代替します (精度が下がる場合があります)'}
          checked={profile.supportsTools}
          onChange={(supportsTools) => patchProfile({ supportsTools })}
        />
        <Field label="最大出力トークン">
          <NumberInput value={profile.maxTokens} min={256} max={64000} onCommit={(maxTokens) => patchProfile({ maxTokens })} />
        </Field>
        <Field label="Temperature" hint="空欄 (既定) にするとモデルの既定値">
          <CommitInput
            value={profile.temperature === null ? '' : String(profile.temperature)}
            placeholder="既定"
            ariaLabel="Temperature"
            onCommit={(v) => {
              const t = v.trim() === '' ? null : Number(v);
              if (t === null || (Number.isFinite(t) && t >= 0 && t <= 2)) patchProfile({ temperature: t });
            }}
          />
        </Field>

        <div className="s-actions">
          <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void test()}>
            {busy === 'test' ? '接続テスト中…' : '接続テスト'}
          </button>
          {result && <span className={`s-result ${result.ok ? 'ok' : 'err'}`}>{result.text}</span>}
        </div>
      </section>

      <section className="s-card info">
        <h2>AI API へ送信される情報</h2>
        <ul>
          <li>あなたが入力した指示文</li>
          <li>画面のスクリーンショット (縮小 JPEG。Gumi 自身のウィンドウは除外。機密キーワードを含むウィンドウ表示中は送信しません)</li>
          <li>ウィンドウのタイトル・UI 要素の名前と位置、操作結果のテキスト</li>
          <li>AI が読み取りを要求したクリップボード / ファイルの内容 (API キー・カード番号などは自動マスク)</li>
        </ul>
        <p>送信先は上で設定したエンドポイントのみです。API キーは Main Process 内でのみ復号され、画面側には渡されません。</p>
      </section>
    </>
  );
}

/** API キー入力。入力が止まると自動で暗号化保存し、フォーカスが外れたら入力欄を空に戻す */
function ApiKeyInput({ provider, hasKey, disabled }: { provider: ProviderId; hasKey: boolean; disabled: boolean }) {
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const save = (v: string) => {
    const key = v.trim();
    if (!key || disabled) return;
    void call(() => gumi().invoke('settings:set-api-key', { provider, key })).then((r) => {
      if (r) setStatus('自動保存しました');
    });
  };
  const { markDirty, flush } = useAutoSave(draft, save, true);
  return (
    <>
      <input
        className="input"
        type="password"
        value={draft}
        autoComplete="off"
        disabled={disabled}
        placeholder={hasKey ? '保存済み (変更する場合のみ入力)' : 'API キーを入力'}
        aria-label="API キー"
        onChange={(e) => {
          setDraft(e.target.value);
          setStatus(null);
          markDirty();
        }}
        onBlur={() => {
          flush();
          setDraft('');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') flush();
        }}
      />
      {status && <span className="s-value">{status}</span>}
    </>
  );
}
