/**
 * アプリケーション起動。
 * 1) 既知のエイリアス (メモ帳/電卓/設定 など) 2) スタートメニューのアプリ一覧 3) PATH 上の実行ファイル
 * の順に解決する。シェルを経由しないため、引数によるコマンドインジェクションは発生しない。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import type { AppLauncher, LaunchResult, ShellApi, StartApp } from './types';

export type { LaunchResult, ShellApi, StartApp };

const ALIASES: Record<string, { exe?: string; uri?: string; label: string }> = {
  notepad: { exe: 'notepad.exe', label: 'メモ帳' },
  メモ帳: { exe: 'notepad.exe', label: 'メモ帳' },
  calc: { exe: 'calc.exe', label: '電卓' },
  calculator: { exe: 'calc.exe', label: '電卓' },
  電卓: { exe: 'calc.exe', label: '電卓' },
  explorer: { exe: 'explorer.exe', label: 'エクスプローラー' },
  エクスプローラー: { exe: 'explorer.exe', label: 'エクスプローラー' },
  'file explorer': { exe: 'explorer.exe', label: 'エクスプローラー' },
  paint: { exe: 'mspaint.exe', label: 'ペイント' },
  ペイント: { exe: 'mspaint.exe', label: 'ペイント' },
  mspaint: { exe: 'mspaint.exe', label: 'ペイント' },
  snippingtool: { exe: 'SnippingTool.exe', label: 'Snipping Tool' },
  settings: { uri: 'ms-settings:', label: '設定' },
  設定: { uri: 'ms-settings:', label: '設定' },
  'windows settings': { uri: 'ms-settings:', label: '設定' },
  taskmgr: { exe: 'taskmgr.exe', label: 'タスクマネージャー' },
  タスクマネージャー: { exe: 'taskmgr.exe', label: 'タスクマネージャー' },
  'control panel': { exe: 'control.exe', label: 'コントロールパネル' },
  コントロールパネル: { exe: 'control.exe', label: 'コントロールパネル' },
  edge: { exe: 'msedge.exe', label: 'Microsoft Edge' },
  msedge: { exe: 'msedge.exe', label: 'Microsoft Edge' },
  'microsoft edge': { exe: 'msedge.exe', label: 'Microsoft Edge' },
};

/** 起動に確認が必要な高リスクのアプリ (シェル・システム管理ツール・インストーラー) */
const HIGH_RISK = [
  /^cmd(\.exe)?$/i,
  /^powershell(_ise)?(\.exe)?$/i,
  /^pwsh(\.exe)?$/i,
  /^wt(\.exe)?$/i,
  /terminal/i,
  /コマンド ?プロンプト/,
  /^regedit(\.exe)?$/i,
  /レジストリ/,
  /^mmc(\.exe)?$/i,
  /^gpedit/i,
  /^diskpart/i,
  /^diskmgmt/i,
  /^msiexec/i,
  /\.(msi|bat|cmd|ps1|vbs|js|wsf|reg|scr)$/i,
  /setup|install|インストール/i,
  /^taskmgr/i,
  /タスクマネージャー/,
  /^control(\.exe)?$/i,
];

export function isHighRiskApp(name: string): boolean {
  const base = path.win32.basename(name.trim());
  return HIGH_RISK.some((r) => r.test(base) || r.test(name.trim()));
}

/** 起動して良い URI スキーム (ms-settings: など Windows 標準のものに限定) */
const ALLOWED_URI = /^(ms-settings:|ms-windows-store:|mailto:|ms-photos:|ms-clock:|ms-screenclip:)/i;

export function scoreAppMatch(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  const c = candidate.trim().toLowerCase();
  if (!q || !c) return 0;
  if (c === q) return 100;
  if (c.startsWith(q)) return 80 - Math.min(20, c.length - q.length);
  if (c.includes(q)) return 60 - Math.min(20, c.length - q.length);
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => c.includes(w))) return 50;
  return 0;
}

export function findStartApp(query: string, apps: StartApp[]): StartApp | null {
  let best: StartApp | null = null;
  let bestScore = 0;
  for (const a of apps) {
    const s = scoreAppMatch(query, a.name);
    if (s > bestScore) {
      best = a;
      bestScore = s;
    }
  }
  return bestScore >= 40 ? best : null;
}

function validateArgs(args: string[]): string[] {
  if (args.length > 20) throw new Error('引数が多すぎます');
  for (const a of args) {
    if (a.length > 2000) throw new Error('引数が長すぎます');
    if (/[\0\r\n]/.test(a)) throw new Error('引数に使用できない文字が含まれています');
  }
  return args;
}

function spawnDetached(exe: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
      child.once('error', (err) => reject(new Error(`起動に失敗しました: ${err.message}`)));
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    } catch (err) {
      reject(err as Error);
    }
  });
}

export async function launchApp(
  name: string,
  args: string[],
  deps: { shell: ShellApi; startApps: () => Promise<StartApp[]> },
): Promise<LaunchResult> {
  const query = name.trim();
  if (!query) throw new Error('アプリ名が空です');
  if (/[<>|&^"]/.test(query)) throw new Error('アプリ名に使用できない文字が含まれています');
  validateArgs(args);

  // URI (ms-settings: 等)
  if (/^[a-z-]+:/i.test(query) && !/^[a-z]:\\/i.test(query)) {
    if (!ALLOWED_URI.test(query)) throw new Error(`このスキームは起動できません: ${query}`);
    await deps.shell.openExternal(query);
    return { method: 'uri', target: query, label: query };
  }

  // 絶対パス
  if (path.win32.isAbsolute(query)) {
    if (!existsSync(query)) throw new Error(`ファイルが見つかりません: ${query}`);
    if (args.length > 0 && /\.exe$/i.test(query)) {
      await spawnDetached(query, args);
    } else {
      const err = await deps.shell.openPath(query);
      if (err) throw new Error(err);
    }
    return { method: 'path', target: query, label: path.win32.basename(query) };
  }

  // エイリアス
  const alias = ALIASES[query.toLowerCase()] ?? ALIASES[query];
  if (alias) {
    if (alias.uri) {
      await deps.shell.openExternal(alias.uri);
      return { method: 'alias', target: alias.uri, label: alias.label };
    }
    if (alias.exe) {
      try {
        await spawnDetached(alias.exe, args);
        return { method: 'alias', target: alias.exe, label: alias.label };
      } catch {
        /* スタートメニューで再検索 */
      }
    }
  }

  // スタートメニュー
  const apps = await deps.startApps().catch(() => [] as StartApp[]);
  const hit = findStartApp(query, apps);
  if (hit) {
    if (path.win32.isAbsolute(hit.appId) && existsSync(hit.appId)) {
      if (args.length > 0 && /\.exe$/i.test(hit.appId)) await spawnDetached(hit.appId, args);
      else {
        const err = await deps.shell.openPath(hit.appId);
        if (err) throw new Error(err);
      }
    } else {
      // UWP / パッケージアプリ
      await spawnDetached('explorer.exe', [`shell:AppsFolder\\${hit.appId}`]);
    }
    return { method: 'start-menu', target: hit.appId, label: hit.name };
  }

  // PATH 上の実行ファイル
  const exe = /\.exe$/i.test(query) ? query : `${query}.exe`;
  if (!/^[\w.\- ]+$/.test(exe)) throw new Error(`アプリ「${query}」が見つかりませんでした`);
  try {
    await spawnDetached(exe, args);
    return { method: 'executable', target: exe, label: exe };
  } catch {
    throw new Error(`アプリ「${query}」が見つかりませんでした。正式名称で再試行するか、スタートメニューから探してください。`);
  }
}

/** Windows のアプリ起動 */
export const windowsLauncher: AppLauncher = {
  launch: launchApp,
  isHighRisk: isHighRiskApp,
};
