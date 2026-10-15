import { useEffect, useState } from 'react';
import { useApp } from '../hooks/useApp';
import { gumi } from '../services/bridge';
import { appStore } from '../stores/appStore';
import { CloseIcon } from '../components/ui/icons';
import { AiSettings } from '../components/Settings/AiSettings';
import { OperationSettings, PermissionSettings, ScreenshotSettings } from '../components/Settings/SafetySettings';
import { AppearanceSettings, CharacterSettings } from '../components/Settings/AppearanceSettings';
import { HistorySettings, SystemSettings } from '../components/Settings/SystemSettings';
import '../components/Settings/settings.css';

const TABS = [
  { id: 'ai', label: 'AI プロバイダー' },
  { id: 'permissions', label: '権限と確認' },
  { id: 'operation', label: '操作' },
  { id: 'screenshot', label: 'スクリーンショット' },
  { id: 'appearance', label: '外観' },
  { id: 'character', label: '表示位置・スリープ' },
  { id: 'history', label: '履歴' },
  { id: 'system', label: 'システム' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export function SettingsPage() {
  const settings = useApp((s) => s.settings);
  const lastError = useApp((s) => s.lastError);
  const [tab, setTab] = useState<TabId>('ai');

  useEffect(
    () =>
      gumi().on('settings:navigate', ({ tab: t }) => {
        if (TABS.some((x) => x.id === t)) setTab(t as TabId);
      }),
    [],
  );

  if (!settings) return <div className="settings-loading">読み込み中…</div>;

  return (
    <div className="settings">
      <nav className="s-nav" aria-label="設定カテゴリ">
        <div className="s-brand">Gumi 設定</div>
        {TABS.map((t) => (
          <button key={t.id} type="button" className={`s-nav-item ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <main className="s-main">
        {lastError && (
          <div className="banner danger" role="alert">
            {lastError}
            <button type="button" className="icon-btn" aria-label="閉じる" onClick={() => appStore.set({ lastError: null })}>
              <CloseIcon />
            </button>
          </div>
        )}
        <h1>{TABS.find((t) => t.id === tab)?.label}</h1>
        {tab === 'ai' && <AiSettings settings={settings} />}
        {tab === 'permissions' && <PermissionSettings settings={settings} />}
        {tab === 'operation' && <OperationSettings settings={settings} />}
        {tab === 'screenshot' && <ScreenshotSettings settings={settings} />}
        {tab === 'appearance' && <AppearanceSettings settings={settings} />}
        {tab === 'character' && <CharacterSettings settings={settings} />}
        {tab === 'history' && <HistorySettings settings={settings} />}
        {tab === 'system' && <SystemSettings settings={settings} />}
      </main>
    </div>
  );
}
