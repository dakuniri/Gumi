import { app } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 開発時の Vite dev server URL (本番では null) */
export const DEV_SERVER_URL: string | null = !app.isPackaged ? (process.env.GUMI_DEV_SERVER_URL ?? null) : null;

/** dist-electron/ からの相対で dist/index.html を指す */
export function rendererIndexPath(): string {
  return path.join(__dirname, '..', 'dist', 'index.html');
}

export function preloadPath(): string {
  return path.join(__dirname, 'preload.cjs');
}

export function assetPath(...parts: string[]): string {
  return path.join(app.getAppPath(), 'assets', ...parts);
}

/** URL がアプリ自身のページか (外部コンテンツの判定) */
export function isAppUrl(url: string): boolean {
  if (!url) return false;
  try {
    if (DEV_SERVER_URL) {
      return new URL(url).origin === new URL(DEV_SERVER_URL).origin;
    }
    const target = new URL(url);
    const index = pathToFileURL(rendererIndexPath());
    return target.protocol === 'file:' && decodeURIComponent(target.pathname) === decodeURIComponent(index.pathname);
  } catch {
    return false;
  }
}
