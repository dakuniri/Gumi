/**
 * アプリケーション起動 (macOS)。
 * 1) 既知のエイリアス (メモ帳 -> テキストエディット、電卓 -> 計算機 など Windows の呼び名も含む)
 * 2) アプリケーションフォルダの .app 一覧 3) LaunchServices による名前解決 (open -a)
 * の順に解決する。シェルを経由しないため、引数によるコマンドインジェクションは発生しない。
 */
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findStartApp } from '../apps';
import type { AppLauncher, LaunchResult, ShellApi, StartApp } from '../types';

const P = path.posix;

/** 呼び名 -> アプリ名 (先頭から順に存在するものを使う) */
const ALIASES: Record<string, string[]> = {
  notepad: ['TextEdit'],
  メモ帳: ['TextEdit'],
  textedit: ['TextEdit'],
  テキストエディット: ['TextEdit'],
  calc: ['Calculator'],
  calculator: ['Calculator'],
  電卓: ['Calculator'],
  計算機: ['Calculator'],
  explorer: ['Finder'],
  エクスプローラー: ['Finder'],
  'file explorer': ['Finder'],
  finder: ['Finder'],
  ファインダー: ['Finder'],
  settings: ['System Settings', 'System Preferences'],
  設定: ['System Settings', 'System Preferences'],
  システム設定: ['System Settings', 'System Preferences'],
  システム環境設定: ['System Settings', 'System Preferences'],
  'system settings': ['System Settings', 'System Preferences'],
  'system preferences': ['System Settings', 'System Preferences'],
  'control panel': ['System Settings', 'System Preferences'],
  コントロールパネル: ['System Settings', 'System Preferences'],
  taskmgr: ['Activity Monitor'],
  タスクマネージャー: ['Activity Monitor'],
  アクティビティモニタ: ['Activity Monitor'],
  edge: ['Microsoft Edge'],
  msedge: ['Microsoft Edge'],
  chrome: ['Google Chrome'],
  safari: ['Safari'],
  firefox: ['Firefox'],
  mail: ['Mail'],
  メール: ['Mail'],
  outlook: ['Microsoft Outlook'],
  calendar: ['Calendar'],
  カレンダー: ['Calendar'],
  notes: ['Notes'],
  メモ: ['Notes'],
  preview: ['Preview'],
  プレビュー: ['Preview'],
  photos: ['Photos'],
  写真: ['Photos'],
  paint: ['Preview'],
  ペイント: ['Preview'],
  music: ['Music'],
  ミュージック: ['Music'],
  reminders: ['Reminders'],
  リマインダー: ['Reminders'],
  maps: ['Maps'],
  マップ: ['Maps'],
  messages: ['Messages'],
  メッセージ: ['Messages'],
  'app store': ['App Store'],
  snippingtool: ['Screenshot'],
  スクリーンショット: ['Screenshot'],
  terminal: ['Terminal'],
  ターミナル: ['Terminal'],
  cmd: ['Terminal'],
  powershell: ['Terminal'],
  'コマンドプロンプト': ['Terminal'],
  vscode: ['Visual Studio Code'],
  code: ['Visual Studio Code'],
  word: ['Microsoft Word'],
  excel: ['Microsoft Excel'],
  powerpoint: ['Microsoft PowerPoint'],
};

/** アプリを探すフォルダ */
export function applicationDirs(home = os.homedir()): string[] {
  return [
    '/Applications',
    '/Applications/Utilities',
    '/System/Applications',
    '/System/Applications/Utilities',
    '/System/Library/CoreServices/Applications',
    P.join(home, 'Applications'),
  ];
}

/** 起動に確認が必要な高リスクのアプリ (シェル・スクリプト・システム管理ツール・インストーラー) */
const HIGH_RISK = [
  /^terminal(\.app)?$/i,
  /ターミナル/,
  /^iterm2?(\.app)?$/i,
  /^warp(\.app)?$/i,
  /script editor|スクリプトエディタ/i,
  /^automator(\.app)?$/i,
  /disk utility|ディスクユーティリティ/i,
  /keychain|キーチェーン/i,
  /activity monitor|アクティビティモニタ/i,
  /^installer(\.app)?$/i,
  /インストーラ/,
  /migration assistant|移行アシスタント/i,
  /boot camp/i,
  /\.(pkg|mpkg|command|sh|zsh|bash|tool|scpt|applescript|workflow|terminal|dmg)$/i,
  /setup|install/i,
];

export function isMacHighRiskApp(name: string): boolean {
  const n = name.trim();
  const base = P.basename(n);
  return HIGH_RISK.some((r) => r.test(base) || r.test(n));
}

/** 起動して良い URI スキーム */
const ALLOWED_URI = /^(x-apple\.systempreferences:|mailto:|macappstore:|facetime:|maps:|calshow:|music:)/i;

function validateArgs(args: string[]): string[] {
  if (args.length > 20) throw new Error('引数が多すぎます');
  for (const a of args) {
    if (a.length > 2000) throw new Error('引数が長すぎます');
    if (/[\0\r\n]/.test(a)) throw new Error('引数に使用できない文字が含まれています');
  }
  return args;
}

/** `open` コマンドで起動する (シェルは使わない)。失敗したら例外 */
function openCommand(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', args, { timeout: 15_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim()));
      else resolve();
    });
  });
}

function openApp(appNameOrPath: string, args: string[]): Promise<void> {
  return openCommand(['-a', appNameOrPath, ...(args.length > 0 ? ['--args', ...args] : [])]);
}

/** アプリケーションフォルダの .app を列挙する (サブフォルダは 1 階層まで) */
export async function listApplications(dirs = applicationDirs()): Promise<StartApp[]> {
  const out: StartApp[] = [];
  const seen = new Set<string>();
  const add = (full: string) => {
    const name = P.basename(full, '.app');
    if (seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    out.push({ name, appId: full });
  };
  for (const dir of dirs) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = P.join(dir, e.name);
      if (e.name.endsWith('.app')) add(full);
      else if (e.isDirectory() && !e.name.startsWith('.')) {
        try {
          for (const sub of await fs.readdir(full)) if (sub.endsWith('.app')) add(P.join(full, sub));
        } catch {
          /* 読めないフォルダは無視 */
        }
      }
    }
  }
  return out;
}

export async function launchMacApp(
  name: string,
  args: string[],
  deps: { shell: ShellApi; startApps: () => Promise<StartApp[]> },
): Promise<LaunchResult> {
  const query = name.trim();
  if (!query) throw new Error('アプリ名が空です');
  if (/[<>|&;`$"]/.test(query)) throw new Error('アプリ名に使用できない文字が含まれています');
  validateArgs(args);

  // URI (x-apple.systempreferences: 等)
  if (/^[a-z][a-z0-9.+-]*:/i.test(query)) {
    if (!ALLOWED_URI.test(query)) throw new Error(`このスキームは起動できません: ${query}`);
    await deps.shell.openExternal(query);
    return { method: 'uri', target: query, label: query };
  }

  // 絶対パス / ~
  if (query.startsWith('/') || query.startsWith('~/')) {
    const full = query.startsWith('~/') ? P.join(os.homedir(), query.slice(2)) : query;
    if (!existsSync(full)) throw new Error(`ファイルが見つかりません: ${full}`);
    if (/\.app\/?$/i.test(full)) await openApp(full, args);
    else {
      const err = await deps.shell.openPath(full);
      if (err) throw new Error(err);
    }
    return { method: 'path', target: full, label: P.basename(full).replace(/\.app\/?$/i, '') };
  }

  const apps = await deps.startApps().catch(() => [] as StartApp[]);

  // エイリアス
  const alias = ALIASES[query.toLowerCase()] ?? ALIASES[query];
  if (alias) {
    for (const target of alias) {
      const hit = apps.find((a) => a.name.toLowerCase() === target.toLowerCase());
      try {
        await openApp(hit?.appId ?? target, args);
        return { method: 'alias', target: hit?.appId ?? target, label: target };
      } catch {
        /* 次の候補へ */
      }
    }
  }

  // アプリケーションフォルダ
  const hit = findStartApp(query.replace(/\.app$/i, ''), apps);
  if (hit) {
    await openApp(hit.appId, args);
    return { method: 'start-menu', target: hit.appId, label: hit.name };
  }

  // LaunchServices に名前で解決させる (日本語名など)
  try {
    await openApp(query.replace(/\.app$/i, ''), args);
    return { method: 'application', target: query, label: query };
  } catch {
    throw new Error(
      `アプリ「${query}」が見つかりませんでした。英語の正式名称 (例: "TextEdit", "System Settings") で再試行するか、Spotlight (cmd+space) で探してください。`,
    );
  }
}

/** macOS のアプリ起動 */
export const macLauncher: AppLauncher = {
  launch: launchMacApp,
  isHighRisk: isMacHighRiskApp,
};
