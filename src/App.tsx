import { useEffect, useState } from 'react';
import { FacePage } from './pages/FacePage';
import { SettingsPage } from './pages/SettingsPage';
import { CursorPage } from './pages/CursorPage';
import { bootstrap } from './stores/appStore';
import { useApp } from './hooks/useApp';
import { useTheme } from './hooks/useTheme';

export type Page = 'face' | 'settings' | 'cursor';

export function pageFromHash(hash: string): Page {
  const h = hash.replace(/^#/, '');
  return h === 'settings' || h === 'cursor' ? h : 'face';
}

export function App({ page }: { page: Page }) {
  const settings = useApp((s) => s.settings);
  const [error, setError] = useState<string | null>(null);
  useTheme(settings);

  useEffect(() => {
    bootstrap().catch((err) => setError((err as Error).message));
  }, []);

  if (error) {
    return page === 'face' || page === 'cursor' ? null : <div style={{ padding: 20, color: '#c00' }}>初期化に失敗しました: {error}</div>;
  }
  switch (page) {
    case 'settings':
      return <SettingsPage />;
    case 'cursor':
      return <CursorPage />;
    default:
      return <FacePage />;
  }
}
