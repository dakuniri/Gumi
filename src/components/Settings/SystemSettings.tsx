import { useEffect, useState } from 'react';
import type { PublicSettings } from '../../services/settings/schema';
import type { LogEntry, TaskSummary } from '../../types/agent';
import type { PermissionStatus } from '../../types/ipc';
import { gumi } from '../../services/bridge';
import { appStore, call, updateSettings } from '../../stores/appStore';
import { useApp } from '../../hooks/useApp';
import { CommitInput, Field, NumberInput, Toggle, Badge } from '../ui/controls';
import { LogView } from '../History/LogView';
import { formatDateTime } from '../History/labels';

export function HistorySettings({ settings }: { settings: PublicSettings }) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [ops, setOps] = useState<LogEntry[]>([]);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    void call(() => gumi().invoke('history:list')).then((t) => setTasks(t ?? []));
    void call(() => gumi().invoke('history:operations')).then((o) => setOps((o ?? []).slice().reverse()));
  }, [reload]);

  return (
    <>
      <section className="s-card">
        <h2>履歴の保存</h2>
        <Toggle
          label="会話履歴・操作履歴を保存"
          hint="スクリーンショット画像は保存しません。オフにすると保存済みの履歴ファイルも削除されます"
          checked={settings.history.enabled}
          onChange={(enabled) => void updateSettings({ history: { enabled } })}
        />
        <Field label="保存するタスク数">
          <NumberInput value={settings.history.maxTasks} min={1} max={2000} onCommit={(maxTasks) => void updateSettings({ history: { maxTasks } })} />
        </Field>
        <div className="s-actions">
          <button
            type="button"
            className="btn btn-danger-outline"
            onClick={() => {
              if (window.confirm('保存されているすべての履歴を削除しますか？')) {
                void call(() => gumi().invoke('history:clear')).then(() => setReload((n) => n + 1));
              }
            }}
          >
            履歴をすべて削除
          </button>
        </div>
      </section>

      <section className="s-card">
        <h2>タスク履歴 ({tasks.length})</h2>
        {tasks.length === 0 ? (
          <div className="empty">履歴はありません</div>
        ) : (
          <table className="s-table">
            <thead>
              <tr>
                <th>日時</th>
                <th>指示</th>
                <th>結果</th>
                <th>ステップ</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td>{formatDateTime(t.startedAt)}</td>
                  <td title={t.summary ?? ''}>{t.text}</td>
                  <td>
                    <Badge tone={t.status === 'completed' ? 'ok' : t.status === 'failed' ? 'danger' : 'neutral'}>{t.status}</Badge>
                  </td>
                  <td>{t.steps}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="s-card">
        <h2>操作履歴 (直近)</h2>
        <LogView logs={ops} mode="operations" empty="操作履歴はありません" />
      </section>
    </>
  );
}

const SCREEN_LABEL: Record<PermissionStatus['screen'], string> = {
  granted: '許可済み',
  denied: '許可されていません',
  'not-determined': 'まだ確認していません',
  restricted: '管理者により制限されています',
  unknown: '不明',
};

/** macOS: PC 操作に必要な 2 つの許可の状態と、許可を求めるボタン */
function MacPermissions() {
  const [st, setSt] = useState<PermissionStatus | null>(null);

  useEffect(() => {
    const load = () => void call(() => gumi().invoke('system:permissions')).then((p) => setSt(p ?? null));
    load();
    // システム設定でオンにして戻ってきたときに反映する
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);

  if (!st) return null;
  const request = (kind: 'accessibility' | 'screen') =>
    void call(() => gumi().invoke('system:request-permission', { kind })).then((p) => p && setSt(p));

  return (
    <section className="s-card">
      <h2>macOS の許可</h2>
      <p className="s-desc">
        PC を操作するには、システム設定 &gt; プライバシーとセキュリティ で次の 2 つを Gumi に許可してください。画面収録はオンにした後、Gumi の再起動が必要です。
      </p>
      <Field label="アクセシビリティ (マウス・キーボード操作)">
        {st.accessibility ? (
          <Badge tone="ok">許可済み</Badge>
        ) : (
          <>
            <Badge tone="danger">許可されていません</Badge>{' '}
            <button type="button" className="btn btn-small" onClick={() => request('accessibility')}>
              許可する
            </button>
          </>
        )}
      </Field>
      <Field label="画面収録 (画面を見る)">
        {st.screen === 'granted' ? (
          <Badge tone="ok">許可済み</Badge>
        ) : (
          <>
            <Badge tone="danger">{SCREEN_LABEL[st.screen]}</Badge>{' '}
            <button type="button" className="btn btn-small" onClick={() => request('screen')}>
              許可する
            </button>
          </>
        )}
      </Field>
    </section>
  );
}

export function SystemSettings({ settings }: { settings: PublicSettings }) {
  const version = useApp((s) => s.version);
  const isMac = useApp((s) => s.platform) === 'darwin';
  const automationAvailable = useApp((s) => s.automationAvailable);
  const automationError = useApp((s) => s.automationError);
  const shortcutErrors = useApp((s) => s.shortcutErrors);
  const sys = settings.system;

  return (
    <>
      <section className="s-card">
        <h2>起動</h2>
        <Toggle
          label={isMac ? 'ログイン時に自動で起動' : 'Windows 起動時に自動で起動'}
          hint="インストール版でのみ有効です"
          checked={sys.launchAtLogin}
          onChange={(launchAtLogin) => void updateSettings({ system: { launchAtLogin } })}
        />
      </section>

      {isMac && <MacPermissions />}

      <section className="s-card">
        <h2>ショートカット</h2>
        <p className="s-desc">どのアプリを使っていても有効です。Electron のアクセラレータ形式 (例: Control+Alt+Escape) で指定します。</p>
        <Field label="緊急停止">
          <CommitInput
            value={sys.emergencyStopShortcut}
            ariaLabel="緊急停止ショートカット"
            autoSave={false}
            onCommit={(emergencyStopShortcut) => void updateSettings({ system: { emergencyStopShortcut } })}
          />
        </Field>
        <Field label="一時停止 / 再開">
          <CommitInput
            value={sys.pauseShortcut}
            ariaLabel="一時停止ショートカット"
            autoSave={false}
            onCommit={(pauseShortcut) => void updateSettings({ system: { pauseShortcut } })}
          />
        </Field>
        {shortcutErrors.map((e) => (
          <div key={e} className="banner warn">
            {e}
          </div>
        ))}
      </section>

      <section className="s-card">
        <h2>状態</h2>
        <Field label="バージョン">
          <span className="s-value">{version}</span>
        </Field>
        <Field label="PC 操作エンジン">
          {automationAvailable ? <Badge tone="ok">利用可能</Badge> : <Badge tone="danger">利用不可: {automationError}</Badge>}
        </Field>
      </section>

      <section className="s-card">
        <h2>設定の初期化</h2>
        <p className="s-desc">すべての設定を初期値に戻します (API キーと履歴は削除されません)。</p>
        <button
          type="button"
          className="btn btn-danger-outline"
          onClick={() => {
            if (window.confirm('すべての設定を初期化しますか？')) {
              void call(() => gumi().invoke('settings:reset')).then((s) => s && appStore.set({ settings: s }));
            }
          }}
        >
          設定を初期化
        </button>
      </section>
    </>
  );
}
