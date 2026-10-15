import { app } from 'electron';

/** ログイン時の自動起動 (パッケージ版のみ。開発時は electron 本体が登録されてしまうため行わない。path / args は Windows のみ有効) */
export function applyLaunchAtLogin(enabled: boolean): string | null {
  if (!app.isPackaged) return enabled ? '開発モードでは自動起動を登録しません' : null;
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ['--autostart'] });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
