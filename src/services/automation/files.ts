/**
 * ファイル・フォルダ操作。
 * - パスはユーザーフォルダの別名 (Desktop / デスクトップ / Downloads / ダウンロード など) や %ENV% / ~ を展開する。
 * - Windows (C:\...) と macOS (/Users/...) の両方のパス形式に対応する。
 * - システム領域・ネットワークパス・Gumi 自身のデータ領域への操作は拒否する。
 * - 削除は完全削除ではなく「ごみ箱へ移動」のみ。
 */
import { promises as fs, constants as fsc } from 'node:fs';
import path from 'node:path';

export interface KnownFolders {
  home: string;
  desktop: string;
  documents: string;
  downloads: string;
  pictures: string;
  music: string;
  videos: string;
}

export interface FileSafetyConfig {
  folders: KnownFolders;
  /** 操作を禁止するディレクトリ (正規化済み絶対パス) */
  protectedRoots: string[];
  /** パスの形式。省略時は実行中の OS */
  platform?: PathPlatform;
}

export type PathPlatform = 'win32' | 'darwin';

const W = path.win32;
const X = path.posix;

function currentPathPlatform(): PathPlatform {
  return process.platform === 'darwin' ? 'darwin' : 'win32';
}

const FOLDER_ALIASES: Record<string, keyof KnownFolders> = {
  desktop: 'desktop',
  デスクトップ: 'desktop',
  documents: 'documents',
  ドキュメント: 'documents',
  'my documents': 'documents',
  downloads: 'downloads',
  ダウンロード: 'downloads',
  pictures: 'pictures',
  ピクチャ: 'pictures',
  画像: 'pictures',
  music: 'music',
  ミュージック: 'music',
  videos: 'videos',
  ビデオ: 'videos',
  home: 'home',
  ホーム: 'home',
};

export function defaultProtectedRoots(
  env: NodeJS.ProcessEnv = process.env,
  platform: PathPlatform = currentPathPlatform(),
): string[] {
  if (platform === 'darwin') {
    const roots = [
      '/System',
      '/Library',
      '/Applications',
      '/usr',
      '/bin',
      '/sbin',
      '/private',
      '/etc',
      '/var',
      '/tmp',
      '/opt',
      '/cores',
      '/dev',
      '/Volumes/Recovery',
    ];
    // ユーザーの Library (キーチェーン・アプリの設定やデータ) も対象外
    if (env.HOME) roots.push(X.join(env.HOME, 'Library'));
    return roots.map((r) => X.normalize(r));
  }
  const roots = [
    env.SystemRoot ?? 'C:\\Windows',
    env.ProgramFiles ?? 'C:\\Program Files',
    env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    env.ProgramData ?? 'C:\\ProgramData',
    'C:\\$Recycle.Bin',
    'C:\\System Volume Information',
    'C:\\Recovery',
    'C:\\Boot',
  ];
  return roots.map((r) => W.normalize(r));
}

function expandEnv(p: string, env: NodeJS.ProcessEnv): string {
  return p.replace(/%([^%]+)%/g, (m, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? (env[key] ?? m) : m;
  });
}

function aliasFolder(first: string, cfg: FileSafetyConfig): string | null {
  const alias = FOLDER_ALIASES[first.toLowerCase()] ?? FOLDER_ALIASES[first];
  return alias ? cfg.folders[alias] : null;
}

/** ユーザー入力のパスを絶対パスへ解決する (存在確認はしない) */
export function resolveUserPath(input: string, cfg: FileSafetyConfig, env: NodeJS.ProcessEnv = process.env): string {
  let p = input.trim().replace(/^["']|["']$/g, '');
  if (!p) throw new Error('パスが空です');
  if ((cfg.platform ?? currentPathPlatform()) === 'darwin') return resolvePosixPath(p, input, cfg, env);
  if (/[\0<>|"?*]/.test(p.replace(/^[a-zA-Z]:/, ''))) throw new Error(`パスに使用できない文字が含まれています: ${input}`);
  p = expandEnv(p, env);
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = W.join(cfg.folders.home, p.slice(1));
  p = p.replace(/\//g, '\\');
  if (!W.isAbsolute(p) || /^\\(?!\\)/.test(p)) {
    const [first, ...rest] = p.split('\\');
    const alias = FOLDER_ALIASES[first.toLowerCase()] ?? FOLDER_ALIASES[first];
    if (!alias) {
      throw new Error(
        `パス "${input}" は絶対パスではありません。C:\\... の形式か、Desktop\\... / Downloads\\... のように指定してください。`,
      );
    }
    p = W.join(cfg.folders[alias], ...rest);
  }
  return W.normalize(p);
}

function resolvePosixPath(p: string, input: string, cfg: FileSafetyConfig, env: NodeJS.ProcessEnv): string {
  if (p.includes('\0')) throw new Error(`パスに使用できない文字が含まれています: ${input}`);
  p = p.replace(/\$(\w+)|\$\{(\w+)\}/g, (m, a: string | undefined, b: string | undefined) => env[(a ?? b)!] ?? m);
  if (p === '~' || p.startsWith('~/')) p = X.join(cfg.folders.home, p.slice(1));
  // Windows 風の区切り (Desktop\foo) も受け付ける
  if (!p.startsWith('/')) p = p.replace(/\\/g, '/');
  if (!X.isAbsolute(p)) {
    const [first, ...rest] = p.split('/');
    const base = aliasFolder(first, cfg);
    if (!base) {
      throw new Error(
        `パス "${input}" は絶対パスではありません。/Users/... の形式か、Desktop/... / Downloads/... のように指定してください。`,
      );
    }
    p = X.join(base, ...rest);
  }
  return X.normalize(p).replace(/(.)\/+$/, '$1');
}

/** macOS (APFS) は既定で大文字小文字を区別しないので、比較も区別しない */
function isInsidePosix(child: string, parent: string): boolean {
  const c = child.toLowerCase().replace(/\/+$/, '');
  const pp = parent.toLowerCase().replace(/\/+$/, '');
  return c === pp || c.startsWith(pp + '/');
}

function isInside(child: string, parent: string): boolean {
  const c = child.toLowerCase().replace(/\\+$/, '');
  const pp = parent.toLowerCase().replace(/\\+$/, '');
  return c === pp || c.startsWith(pp + '\\');
}

/** 操作対象として安全なパスか検証し、正規化パスを返す */
export function assertSafePath(p: string, cfg: FileSafetyConfig): string {
  if ((cfg.platform ?? currentPathPlatform()) === 'darwin') {
    const n = X.normalize(p).replace(/(.)\/+$/, '$1');
    if (!n.startsWith('/')) throw new Error(`/ から始まる絶対パスを指定してください: ${p}`);
    if (n === '/' || n === '/Users' || n === '/Volumes' || /^\/Volumes\/[^/]+$/.test(n)) {
      throw new Error('ルートやボリュームそのものは操作できません');
    }
    for (const root of cfg.protectedRoots) {
      if (root.startsWith('/') && isInsidePosix(n, root)) throw new Error(`保護された場所のため操作できません: ${root}`);
    }
    return n;
  }
  const normalized = W.normalize(p);
  if (normalized.startsWith('\\\\')) throw new Error('ネットワークパス / デバイスパスは操作できません');
  if (!/^[a-zA-Z]:\\/.test(normalized)) throw new Error(`ドライブ付きの絶対パスを指定してください: ${p}`);
  if (/^[a-zA-Z]:\\?$/.test(normalized)) throw new Error('ドライブのルートそのものは操作できません');
  for (const root of cfg.protectedRoots) {
    if (isInside(normalized, root)) throw new Error(`保護された場所のため操作できません: ${root}`);
  }
  return normalized;
}

export function resolveSafe(input: string, cfg: FileSafetyConfig): string {
  return assertSafePath(resolveUserPath(input, cfg), cfg);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsc.F_OK);
    return true;
  } catch {
    return false;
  }
}

export interface DirEntry {
  name: string;
  type: 'file' | 'directory' | 'other';
  size: number;
  modified: string;
}

export async function listDirectory(dir: string, limit = 200): Promise<{ path: string; entries: DirEntry[]; total: number }> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: DirEntry[] = [];
  for (const e of entries.slice(0, limit)) {
    const full = path.join(dir, e.name);
    let size = 0;
    let modified = '';
    try {
      const st = await fs.stat(full);
      size = st.size;
      modified = st.mtime.toISOString();
    } catch {
      /* アクセス不可 */
    }
    out.push({ name: e.name, type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other', size, modified });
  }
  return { path: dir, entries: out, total: entries.length };
}

export async function createFolder(dir: string): Promise<{ created: boolean }> {
  if (await exists(dir)) {
    const st = await fs.stat(dir);
    if (st.isDirectory()) return { created: false };
    throw new Error(`同名のファイルが既に存在します: ${dir}`);
  }
  await fs.mkdir(dir, { recursive: true });
  return { created: true };
}

/** 移動先が既存フォルダならその中へ移動する。上書きはしない。 */
export async function movePath(from: string, to: string): Promise<string> {
  if (!(await exists(from))) throw new Error(`移動元が見つかりません: ${from}`);
  let dest = to;
  if ((await exists(to)) && (await fs.stat(to)).isDirectory()) dest = path.join(to, path.basename(from));
  if (dest.toLowerCase() === from.toLowerCase()) return dest;
  if (await exists(dest)) throw new Error(`移動先に同名の項目が既に存在します: ${dest}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(from, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.cp(from, dest, { recursive: true, errorOnExist: true, force: false });
    await fs.rm(from, { recursive: true });
  }
  return dest;
}

export async function copyPath(from: string, to: string): Promise<string> {
  if (!(await exists(from))) throw new Error(`コピー元が見つかりません: ${from}`);
  let dest = to;
  if ((await exists(to)) && (await fs.stat(to)).isDirectory()) dest = path.join(to, path.basename(from));
  if (await exists(dest)) throw new Error(`コピー先に同名の項目が既に存在します: ${dest}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(from, dest, { recursive: true, errorOnExist: true, force: false });
  return dest;
}

export async function renamePath(p: string, newName: string): Promise<string> {
  if (/[\\/:*?"<>|]/.test(newName) || newName.trim() === '' || newName === '.' || newName === '..') {
    throw new Error(`新しい名前に使用できない文字が含まれています: ${newName}`);
  }
  if (!(await exists(p))) throw new Error(`対象が見つかりません: ${p}`);
  const dest = path.join(path.dirname(p), newName);
  if (dest.toLowerCase() !== p.toLowerCase() && (await exists(dest))) {
    throw new Error(`同名の項目が既に存在します: ${dest}`);
  }
  await fs.rename(p, dest);
  return dest;
}

const MAX_READ = 64 * 1024;

export async function readTextFile(p: string, maxBytes = MAX_READ): Promise<{ text: string; truncated: boolean; size: number }> {
  const st = await fs.stat(p);
  if (!st.isFile()) throw new Error('ファイルではありません');
  const fh = await fs.open(p, 'r');
  try {
    const len = Math.min(st.size, Math.min(maxBytes, MAX_READ));
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    if (buf.includes(0)) throw new Error('バイナリファイルのため読み取れません');
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { text, truncated: st.size > len, size: st.size };
  } finally {
    await fh.close();
  }
}

export async function writeTextFile(p: string, content: string, overwrite: boolean): Promise<{ overwritten: boolean }> {
  if (Buffer.byteLength(content, 'utf8') > 5 * 1024 * 1024) throw new Error('書き込む内容が大きすぎます (5MB まで)');
  const already = await exists(p);
  if (already && !overwrite) throw new Error(`ファイルが既に存在します (上書きするには overwrite=true): ${p}`);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf8');
  return { overwritten: already };
}

export async function pathExists(p: string): Promise<boolean> {
  return exists(p);
}
