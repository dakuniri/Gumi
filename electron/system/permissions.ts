/**
 * PC 操作に必要な OS の許可。
 * macOS: アクセシビリティ (マウス・キーボード操作と UI 要素の取得) と 画面収録 (スクリーンショット) の 2 つ。
 *        どちらもユーザーがシステム設定でオンにする必要がある (アプリから勝手にはオンにできない)。
 * Windows: 追加の許可は不要。
 */
import { shell, systemPreferences } from 'electron';
import type { PermissionStatus } from '../../src/services/automation/types';
import { mac } from '../../src/services/automation/macos/bindings';
import { trusted as axTrusted } from '../../src/services/automation/macos/ax-core';

export type PermissionKind = 'accessibility' | 'screen';

const SETTINGS_URL: Record<PermissionKind, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
};

/** 現在の許可の状態。Windows では null (許可は不要) */
export function permissionStatus(): PermissionStatus | null {
  if (process.platform !== 'darwin') return null;
  let accessibility = false;
  try {
    accessibility = mac().AXIsProcessTrusted();
  } catch {
    accessibility = false;
  }
  let screen: PermissionStatus['screen'] = 'unknown';
  try {
    screen = systemPreferences.getMediaAccessStatus('screen');
  } catch {
    screen = 'unknown';
  }
  return { accessibility, screen };
}

/**
 * 許可を求める。初回は macOS の確認ダイアログが出る。
 * すでに拒否されている場合はダイアログが出ないので、システム設定の該当ページを開く。
 */
export async function requestPermission(kind: PermissionKind): Promise<PermissionStatus | null> {
  if (process.platform !== 'darwin') return null;
  try {
    if (kind === 'accessibility') {
      if (!axTrusted(true)) await shell.openExternal(SETTINGS_URL.accessibility);
    } else if (!mac().CGRequestScreenCaptureAccess()) {
      await shell.openExternal(SETTINGS_URL.screen);
    }
  } catch {
    await shell.openExternal(SETTINGS_URL[kind]);
  }
  return permissionStatus();
}

/** タスクを始める前の確認。足りない許可があれば理由を返す (macOS 以外は常に null) */
export function missingPermission(): string | null {
  const st = permissionStatus();
  if (!st) return null;
  if (!st.accessibility) {
    void requestPermission('accessibility');
    return 'マウス・キーボードを操作するには「アクセシビリティ」の許可が必要です。システム設定 > プライバシーとセキュリティ > アクセシビリティ で Gumi をオンにしてから、もう一度送信してください。';
  }
  if (st.screen !== 'granted') {
    void requestPermission('screen');
    return '画面を見るには「画面収録」の許可が必要です。システム設定 > プライバシーとセキュリティ > 画面収録 (画面とシステムオーディオの録音) で Gumi をオンにし、Gumi を再起動してください。';
  }
  return null;
}
